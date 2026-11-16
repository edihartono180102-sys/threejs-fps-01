// The simulation: one fixed 60 Hz step, kept apart from rendering. It owns the
// match and pushes numbers to the HUD; rendering only reads bodies and meshes.
// No allocation in the hot loop: one raycaster, a handful of scratch vectors,
// and a small tracer pool.
//
// The file is organised as four layers, top to bottom:
//   1. Match rules — the economy and round tables, and the phase machine that
//      walks buy -> live -> roundEnd -> buy (or matchEnd).
//   2. Combat — one shot resolved as a pipeline: find the nearest hit, price
//      it through the weapon's falloff, apply it to a bot or the player, and
//      settle the kill (reward, killfeed, bomb drop, round end).
//   3. Player actions — movement, shooting, grenades, buying, planting.
//   4. World systems — the bomb fuse, grenade bounces, and the bot pickup that
//      keeps a round moving after the carrier dies.
//
// Damage falls off with distance (each weapon's falloffStart/End/Min), so a
// shotgun is a close weapon and a rifle still reaches across the yard. Loss
// streaks pay: each consecutive lost round adds $50 to the loss reward, capped
// at +$150, so a team on a slide can still buy back. A team that lost the
// previous round arms its bots with 25 plate, the same buy-back pressure the
// player feels. Round history (W/L per round) is kept for the HUD strip, and
// the bomb's plant channel and fuse are reported as a progress bar.
import * as THREE from 'three';
import { createMover } from './mover.js';
import { WEAPONS, GRENADE, createWeaponView, falloff } from './weapons.js';
import { createBot, createBotSystem } from './bots.js';
import { createBomb, PLANT_SECONDS, DEFUSE_SECONDS, FUSE_SECONDS } from './bomb.js';
import { range } from './rng.js';

// -- Match rules ---------------------------------------------------------------

const BUY_SECONDS = 12;
const ROUND_SECONDS = 100;
const ROUND_END_SECONDS = 4;
const WIN_ROUNDS = 5;
const MAX_ROUNDS = 9;
const START_MONEY = 800;
const KILL_REWARD = 300;
const WIN_REWARD = 325;
const LOSS_REWARD = 190;
const LOSS_STREAK_BONUS = 50;
const LOSS_STREAK_CAP = 150;
const PLANT_REWARD = 300;
const GRAVITY_GRENADE = 12;
const BOT_ARMOR_ON_LOSS = 25;
const LANDING_SOUND_SPEED = 6;
const PICKUP_RADIUS = 1.2;
const TRACER_LIFE = 0.07;
const MAX_TRACERS = 10;

// The shop as data: every entry knows its price, when it can be bought, and
// what it does. Weapons are generated from WEAPONS so the shop and the weapon
// table cannot drift apart.
function shopEntries() {
  const entries = {
    armor: {
      price: 650,
      canBuy: (player) => player.armor < 50,
      apply: (player) => { player.armor = 50; },
    },
    grenade: {
      price: GRENADE.price,
      canBuy: (player) => player.grenades < 2,
      apply: (player) => { player.grenades += 1; },
    },
  };
  for (const [id, def] of Object.entries(WEAPONS)) {
    entries[id] = {
      price: def.price,
      canBuy: (player) => player.primary !== id,
      apply: (player, weaponView) => {
        player.owned[id] = true;
        player.primary = id;
        weaponView.equip(def);
      },
    };
  }
  return entries;
}
const SHOP = shopEntries();
const BUY_KEYS = ['rifle', 'smg', 'shotgun', 'grenade', 'armor'];

// -- Ray helpers ---------------------------------------------------------------
// Pure geometry, no allocation: raySphere solves the quadratic directly and
// rayAabb works in scalars instead of the array version that allocated four
// arrays per call.

function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

function rayAabb(origin, dir, min, max) {
  let tmin = 0;
  let tmax = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const mn = [min.x, min.y, min.z];
  const mx = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return Infinity;
    } else {
      let t1 = (mn[i] - o[i]) / d[i];
      let t2 = (mx[i] - o[i]) / d[i];
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

export function createSim(deps) {
  const { scene, camera, world, hud, audio, input, rng, shotMode } = deps;
  const weaponView = createWeaponView(camera);
  const bomb = createBomb(scene, world);
  const botSystem = createBotSystem(scene, world, rng);
  const raycaster = new THREE.Raycaster();

  const playerMover = createMover(world.colliders, world.spawnAttacker[1], 0);
  const player = {
    mover: playerMover,
    health: 100,
    armor: 0,
    alive: true,
    money: START_MONEY,
    owned: { pistol: true },
    primary: 'pistol',
    grenades: 0,
    isCarrier: true,
  };
  const bots = [];
  const grenades = [];
  const tracers = [];
  const tracerMaterial = new THREE.LineBasicMaterial({ color: 0xffc266, transparent: true, opacity: 0.9 });
  for (let i = 0; i < MAX_TRACERS; i += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geometry, tracerMaterial.clone());
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  const explosionLight = new THREE.PointLight(new THREE.Color('#ff7a1a'), 0, 18);
  scene.add(explosionLight);

  const sim = {
    phase: 'menu', // menu | buy | live | roundEnd | matchEnd
    paused: false,
    round: 1,
    wins: { ember: 0, ash: 0 },
    // One entry per finished round, 'ember' or 'ash', for the HUD history strip.
    history: [],
    // Consecutive rounds Ember has lost; each one adds to the next loss reward.
    lossStreak: 0,
    prevWinner: null,
    timer: 0,
    time: 0,
    shake: 0,
    stats: { shots: 0, hits: 0, kills: 0, headshots: 0, damage: 0 },
    spectate: null,
    noise: null,
    player,
    bots,
    bomb: bomb.state,
    plantChannel: 0,
    roundWinner: null,
    matchWinner: null,
  };

  const scratch = {
    dir: new THREE.Vector3(),
    pelletDir: new THREE.Vector3(),
    origin: new THREE.Vector3(),
    point: new THREE.Vector3(),
    min: new THREE.Vector3(),
    max: new THREE.Vector3(),
    center: new THREE.Vector3(),
    muzzle: new THREE.Vector3(),
    next: new THREE.Vector3(),
  };

  // -- Teams --------------------------------------------------------------------

  function teamAlive(team) {
    if (team === 'ember') {
      return (player.alive ? 1 : 0) + bots.filter((b) => b.team === 'ember' && b.alive).length;
    }
    return bots.filter((b) => b.team === 'ash' && b.alive).length;
  }

  function teamTotal(team) {
    return team === 'ember'
      ? 1 + bots.filter((b) => b.team === 'ember').length
      : bots.filter((b) => b.team === 'ash').length;
  }

  // Buy-back pressure: a team that lost the previous round arms its bots with
  // plate, so a 0–3 start does not snowball into free rounds.
  function armorFor(team) {
    if (team === 'ember') return sim.prevWinner === 'ash' ? BOT_ARMOR_ON_LOSS : 0;
    return sim.prevWinner === 'ember' ? BOT_ARMOR_ON_LOSS : 0;
  }

  function spawnBots() {
    for (const bot of bots) scene.remove(bot.parts.group);
    bots.length = 0;
    const defs = { rifle: WEAPONS.rifle, smg: WEAPONS.smg };
    bots.push(createBot(scene, world, rng, { id: 'ember-1', team: 'ember', name: 'Ember-1', spawn: world.spawnAttacker[0], yaw: 0, route: world.routes.toMid, def: defs.smg, armor: armorFor('ember') }));
    bots.push(createBot(scene, world, rng, { id: 'ember-2', team: 'ember', name: 'Ember-2', spawn: world.spawnAttacker[2], yaw: 0, route: world.routes.toB, def: defs.rifle, armor: armorFor('ember') }));
    bots.push(createBot(scene, world, rng, { id: 'ash-1', team: 'ash', name: 'Ash-1', spawn: world.spawnDefender[0], yaw: Math.PI, holdPoint: world.routes.holdA[0], def: defs.rifle, armor: armorFor('ash') }));
    bots.push(createBot(scene, world, rng, { id: 'ash-2', team: 'ash', name: 'Ash-2', spawn: world.spawnDefender[1], yaw: Math.PI, holdPoint: world.routes.holdB[0], def: defs.smg, armor: armorFor('ash') }));
    bots.push(createBot(scene, world, rng, { id: 'ash-3', team: 'ash', name: 'Ash-3', spawn: world.spawnDefender[2], yaw: Math.PI, holdPoint: world.routes.holdMid[0], def: defs.rifle, armor: armorFor('ash') }));
    bots.push(createBot(scene, world, rng, { id: 'ash-4', team: 'ash', name: 'Ash-4', spawn: world.spawnDefender[3], yaw: Math.PI, holdPoint: world.routes.holdMid[1], def: defs.smg, armor: armorFor('ash') }));
  }

  // The enemies a bot of a team can see, as the bot system expects them: the
  // player is a math body, not a mesh, so it is wrapped with isPlayer set.
  function botWrappers(team) {
    const out = [];
    if (team === 'ember') {
      for (const bot of bots) if (bot.team === 'ash') out.push({ body: bot.mover.body, alive: bot.alive, bot });
    } else {
      if (player.alive) out.push({ body: player.mover.body, alive: true, bot: null, isPlayer: true });
      for (const bot of bots) if (bot.team === 'ember') out.push({ body: bot.mover.body, alive: bot.alive, bot });
    }
    return out;
  }

  // -- Tracers and noise ----------------------------------------------------------

  function addTracer(from, to) {
    let slot = tracers.find((t) => t.life <= 0);
    if (!slot) slot = tracers[0];
    const positions = slot.line.geometry.attributes.position.array;
    positions[0] = from.x;
    positions[1] = from.y;
    positions[2] = from.z;
    positions[3] = to.x;
    positions[4] = to.y;
    positions[5] = to.z;
    slot.line.geometry.attributes.position.needsUpdate = true;
    slot.line.visible = true;
    slot.line.material.opacity = 0.9;
    slot.life = TRACER_LIFE;
  }

  function emitNoise(position) {
    sim.noise = { position: position.clone(), at: sim.time };
  }

  // -- Combat ---------------------------------------------------------------------
  //
  // One shot is a pipeline: find the nearest hit (rayPlayer for the player
  // body, the raycaster for meshes), price it through the weapon's falloff,
  // apply it, and settle the kill. The amount the caller sees is already
  // scaled, so stats and kill rewards agree.

  // The player is a math body, not a mesh: ray vs head sphere, then vs torso
  // box. Returns { distance, part } for the nearer of the two, or null.
  function rayPlayer(origin, dir) {
    const body = player.mover.body;
    scratch.center.set(body.position.x, body.position.y + 1.53, body.position.z);
    const headDistance = raySphere(origin, dir, scratch.center, 0.17);
    scratch.min.set(body.position.x - 0.34, body.position.y, body.position.z - 0.34);
    scratch.max.set(body.position.x + 0.34, body.position.y + body.height, body.position.z + 0.34);
    const torsoDistance = rayAabb(origin, dir, scratch.min, scratch.max);
    const distance = Math.min(headDistance, torsoDistance);
    if (!Number.isFinite(distance)) return null;
    return { distance, part: headDistance < torsoDistance ? 'head' : 'torso' };
  }

  // Price a hit through the weapon's falloff curve, rounded like the old code.
  function priceHit(def, part, distance) {
    const base = part === 'head' ? def.headDamage : def.damage;
    return Math.round(base * falloff(def, distance));
  }

  // Settle a bot kill: stats and money are the player's own (an Ember bot's
  // hits used to count as the player's and pay the player $300), the killfeed
  // names the shooter, and a carrier drops the bomb.
  function settleBotKill(hitBot, shooterTeam, shooterBot, byPlayer) {
    if (byPlayer) {
      sim.stats.kills += 1;
      player.money += KILL_REWARD;
    }
    if (shooterTeam === 'ember') {
      hud.killfeed(`${shooterBot && shooterBot.id !== 'player' ? shooterBot.name : 'You'} ▸ ${hitBot.name}`);
      audio.kill();
    } else {
      hud.killfeed(`${shooterBot ? shooterBot.name : 'Ash'} ▸ ${hitBot.name}`);
    }
    if (hitBot.carriesBomb) {
      hitBot.carriesBomb = false;
      bomb.drop(hitBot.mover.body.position);
    }
    checkRoundEnd();
  }

  function applyShotToBot(hitBot, hitPart, def, hitDistance, shooterTeam, shooterBot) {
    const scaled = priceHit(def, hitPart, hitDistance);
    const killed = botSystem.damage(hitBot, scaled, hitPart);
    // Match stats and kill money are the player's own: an Ember bot's hits
    // used to count as the player's and pay the player $300.
    const byPlayer = shooterTeam === 'ember' && shooterBot && shooterBot.id === 'player';
    if (byPlayer) {
      sim.stats.hits += 1;
      sim.stats.damage += scaled;
      if (hitPart === 'head') sim.stats.headshots += 1;
    }
    if (killed) settleBotKill(hitBot, shooterTeam, shooterBot, byPlayer);
    return killed;
  }

  // Resolve one hitscan shot. Returns { end, hitBot, hitPart, hitPlayer }.
  // shooterTeam is 'ember' or 'ash'.
  function resolveShot(origin, dir, def, shooterTeam, shooterBot) {
    const targets = world.shootables.slice();
    for (const bot of bots) {
      if (!bot.alive || bot.team === shooterTeam) continue;
      targets.push(bot.parts.torso, bot.parts.head);
    }
    raycaster.set(origin, dir);
    raycaster.far = def.range;
    const hits = raycaster.intersectObjects(targets, false);
    let end = scratch.point.copy(dir).multiplyScalar(def.range).add(origin);
    let hitBot = null;
    let hitPart = null;
    let hitDistance = Infinity;
    if (hits.length > 0) {
      hitDistance = hits[0].distance;
      end = hits[0].point;
      if (hits[0].object.userData.bot) {
        hitBot = hits[0].object.userData.bot;
        hitPart = hits[0].object.userData.part;
      }
    }
    // The player is closer than anything the raycaster found: the shot is
    // theirs to take, and a bot hit behind them is ignored.
    if (shooterTeam === 'ash' && player.alive) {
      const playerHit = rayPlayer(origin, dir);
      if (playerHit && playerHit.distance < hitDistance && playerHit.distance <= def.range) {
        end = scratch.point.copy(dir).multiplyScalar(playerHit.distance).add(origin);
        damagePlayer(priceHit(def, playerHit.part, playerHit.distance), playerHit.part === 'head');
        return { end, hitBot: null, hitPart: playerHit.part, hitPlayer: true };
      }
    }
    if (hitBot) {
      applyShotToBot(hitBot, hitPart, def, hitDistance, shooterTeam, shooterBot);
      return { end, hitBot, hitPart, hitPlayer: false };
    }
    return { end, hitBot: null, hitPart: null, hitPlayer: false };
  }

  function damagePlayer(amount, head) {
    if (!player.alive) return;
    let left = amount;
    if (player.armor > 0) {
      const absorbed = Math.min(player.armor, left * 0.5);
      player.armor -= absorbed;
      left -= absorbed;
    }
    player.health -= left;
    audio.hurt();
    hud.damageFlash();
    if (player.health > 0) return;
    player.health = 0;
    player.alive = false;
    sim.plantChannel = 0;
    sim.spectate = bots.find((b) => b.team === 'ember' && b.alive) || null;
    if (player.isCarrier) {
      player.isCarrier = false;
      bomb.drop(player.mover.body.position);
    }
    checkRoundEnd();
  }

  // Fire one pellet along the (already spread) aim direction and draw its
  // tracer. Returns the shot report so the caller can fold hit/kill/headshot
  // across pellets.
  function firePellet(def, aimDir, muzzle) {
    scratch.pelletDir.copy(aimDir);
    if (def.pellets > 1) {
      scratch.pelletDir.x += (rng() * 2 - 1) * def.spreadStill;
      scratch.pelletDir.y += (rng() * 2 - 1) * def.spreadStill;
      scratch.pelletDir.z += (rng() * 2 - 1) * def.spreadStill;
      scratch.pelletDir.normalize();
    }
    const result = resolveShot(scratch.origin, scratch.pelletDir, def, 'ember', { id: 'player' });
    addTracer(muzzle, result.end);
    return result;
  }

  function playerShoot() {
    const def = weaponView.state.def;
    if (!weaponView.takeRound()) {
      audio.dryFire();
      return;
    }
    sim.stats.shots += 1;
    camera.getWorldDirection(scratch.dir);
    const crouching = playerMover.body.crouching;
    const spread = weaponView.spread(playerMover.groundSpeed(), crouching);
    scratch.dir.x += (rng() * 2 - 1) * spread;
    scratch.dir.y += (rng() * 2 - 1) * spread;
    scratch.dir.z += (rng() * 2 - 1) * spread;
    scratch.dir.normalize();
    camera.getWorldPosition(scratch.origin);
    const muzzle = scratch.muzzle.copy(scratch.origin).addScaledVector(scratch.dir, 0.6);
    // Every pellet gets its own ray: a shotgun used to fire all eight pellets
    // along one identical line and stop at the first hit, so it dealt a single
    // pellet's damage. Pellets spread around the aim and each one resolves on
    // its own.
    let anyHit = false;
    let anyKill = false;
    let anyHeadshot = false;
    for (let pellet = 0; pellet < def.pellets; pellet += 1) {
      const result = firePellet(def, scratch.dir, muzzle);
      if (result.hitBot) {
        anyHit = true;
        if (!result.hitBot.alive) anyKill = true;
        if (result.hitPart === 'head') anyHeadshot = true;
      }
    }
    if (anyHit) {
      audio.hit();
      hud.hitMarker(anyKill || anyHeadshot, shotMode ? 4000 : 120);
    }
    weaponView.pullTrigger();
    playerMover.recoil(def.kick + rng() * 0.004, (rng() * 2 - 1) * 0.004);
    emitNoise(playerMover.body.position);
    audio.shot(def.kind);
  }

  function botShoot(bot, aimError) {
    const target = bot.target;
    if (!target) return;
    const eye = scratch.origin.set(
      bot.mover.body.position.x,
      bot.mover.body.position.y + bot.mover.body.eye,
      bot.mover.body.position.z,
    );
    const chest = scratch.point.set(target.body.position.x, target.body.position.y + 1.15, target.body.position.z);
    scratch.dir.copy(chest).sub(eye).normalize();
    const distance = eye.distanceTo(chest);
    scratch.dir.x += (rng() * 2 - 1) * aimError;
    scratch.dir.y += (rng() * 2 - 1) * aimError;
    scratch.dir.z += (rng() * 2 - 1) * aimError;
    scratch.dir.normalize();
    // Reuse the scratch muzzle: a fresh Vector3 per bot shot was the one
    // allocation left in the hot loop.
    const muzzle = scratch.muzzle.copy(eye).addScaledVector(scratch.dir, 0.5);
    const result = resolveShot(eye, scratch.dir, bot.def, bot.team, bot);
    addTracer(muzzle, result.end);
    emitNoise(bot.mover.body.position);
    if (target.isPlayer) audio.enemyShot(distance);
    void result;
  }

  // -- Grenades -------------------------------------------------------------------

  function throwGrenade() {
    if (player.grenades <= 0 || sim.phase !== 'live') return;
    player.grenades -= 1;
    camera.getWorldDirection(scratch.dir);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({ color: new THREE.Color('#22262c'), roughness: 0.5, metalness: 0.4 }),
    );
    const start = camera.getWorldPosition(new THREE.Vector3());
    mesh.position.copy(start).addScaledVector(scratch.dir, 0.5);
    scene.add(mesh);
    grenades.push({
      mesh,
      velocity: scratch.dir.clone().multiplyScalar(14).add(new THREE.Vector3(0, 3.5, 0)),
      fuse: GRENADE.fuse,
    });
    audio.grenadeThrow();
  }

  // Blast damage falls off linearly from the centre: full at the centre, 15 at
  // the edge of the radius. Returns the kills, for the caller's stats.
  function applyBlast(position) {
    const victims = [];
    if (player.alive) victims.push({ body: player.mover.body, isPlayer: true, bot: null });
    for (const bot of bots) if (bot.alive) victims.push({ body: bot.mover.body, isPlayer: false, bot });
    for (const victim of victims) {
      const distance = victim.body.position.distanceTo(position);
      if (distance > GRENADE.radius) continue;
      const amount = Math.round(15 + (GRENADE.maxDamage - 15) * (1 - distance / GRENADE.radius));
      if (victim.isPlayer) {
        damagePlayer(amount, false);
      } else {
        sim.stats.damage += amount;
        const killed = botSystem.damage(victim.bot, amount, 'torso');
        if (killed) {
          sim.stats.kills += 1;
          player.money += KILL_REWARD;
          hud.killfeed(`Spark-9 ▸ ${victim.bot.name}`);
          if (victim.bot.carriesBomb) {
            victim.bot.carriesBomb = false;
            bomb.drop(victim.bot.mover.body.position);
          }
          checkRoundEnd();
        }
      }
    }
  }

  function explodeGrenade(grenade) {
    const position = grenade.mesh.position;
    scene.remove(grenade.mesh);
    explosionLight.position.copy(position);
    explosionLight.intensity = 60;
    sim.shake = Math.max(sim.shake, 0.7);
    audio.explosion();
    emitNoise(position);
    applyBlast(position);
  }

  // -- Economy ----------------------------------------------------------------------

  function buy(itemId) {
    if (sim.phase !== 'buy') return false;
    const entry = SHOP[itemId];
    if (!entry || player.money < entry.price || !entry.canBuy(player)) return false;
    player.money -= entry.price;
    entry.apply(player, weaponView);
    audio.buy();
    return true;
  }

  // -- Rounds -------------------------------------------------------------------------

  function nearestSite(position) {
    const a = world.sites.A.center.distanceTo(position);
    const b = world.sites.B.center.distanceTo(position);
    return a < b ? world.sites.A : world.sites.B;
  }

  function checkRoundEnd() {
    if (sim.phase !== 'live') return;
    const emberAlive = teamAlive('ember');
    const ashAlive = teamAlive('ash');
    if (ashAlive === 0) endRound('ember', 'All defenders down.');
    else if (emberAlive === 0) endRound('ash', 'All attackers down.');
  }

  // Payouts for a finished round: the winners are paid, and a team on a loss
  // streak gets a growing consolation so it can still buy back.
  function settlePayout(winner) {
    const won = winner === 'ember';
    if (won) {
      player.money += WIN_REWARD;
      sim.lossStreak = 0;
      audio.roundWin();
    } else {
      // Loss streak: each consecutive lost round adds $50 to the loss reward,
      // capped at +$150, so a team on a slide can still buy back.
      sim.lossStreak += 1;
      const bonus = Math.min(LOSS_STREAK_CAP, (sim.lossStreak - 1) * LOSS_STREAK_BONUS);
      player.money += LOSS_REWARD + bonus;
      audio.roundLose();
    }
    return won;
  }

  function endRound(winner, reason) {
    if (sim.phase !== 'live') return;
    sim.phase = 'roundEnd';
    sim.timer = ROUND_END_SECONDS;
    sim.roundWinner = winner;
    sim.prevWinner = winner;
    sim.wins[winner] += 1;
    sim.history.push(winner);
    const won = settlePayout(winner);
    for (const bot of bots) bot.channel = null;
    hud.showOverlay(
      won ? 'ROUND WON' : 'ROUND LOST',
      `${reason} EMBER ${sim.wins.ember} — ${sim.wins.ash} ASH.`,
      sim.wins.ember >= WIN_ROUNDS || sim.wins.ash >= WIN_ROUNDS || sim.round >= MAX_ROUNDS ? 'See results' : 'Next round',
    );
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function startRound() {
    spawnBots();
    playerMover.body.position.copy(world.spawnAttacker[1]);
    playerMover.body.velocity.set(0, 0, 0);
    playerMover.body.yaw = 0;
    playerMover.body.pitch = 0;
    player.health = 100;
    player.alive = true;
    player.isCarrier = true;
    weaponView.equip(WEAPONS[player.primary]);
    weaponView.refill();
    bomb.reset();
    bomb.carry(player);
    grenades.forEach((g) => scene.remove(g.mesh));
    grenades.length = 0;
    sim.phase = 'buy';
    sim.timer = BUY_SECONDS;
    sim.spectate = null;
    sim.plantChannel = 0;
    sim.noise = null;
    hud.hideOverlay();
    hud.showBuy(player.money, player.owned, player.grenades, player.armor);
    hud.setBomb('');
    hud.setRound(sim.wins.ember, sim.wins.ash, sim.round);
    audio.roundStart();
  }

  function startMatch() {
    sim.wins.ember = 0;
    sim.wins.ash = 0;
    sim.round = 1;
    sim.history = [];
    sim.lossStreak = 0;
    sim.prevWinner = null;
    player.money = START_MONEY;
    player.owned = { pistol: true };
    player.primary = 'pistol';
    player.armor = 0;
    player.grenades = 0;
    startRound();
  }

  function endMatch() {
    sim.phase = 'matchEnd';
    const won = sim.wins.ember > sim.wins.ash;
    sim.matchWinner = won ? 'ember' : 'ash';
    hud.showOverlay(
      won ? 'EMBER WINS THE MATCH' : 'ASH WINS THE MATCH',
      `Final score EMBER ${sim.wins.ember} — ${sim.wins.ash} ASH over ${sim.round} rounds. ${sim.stats.kills} eliminations, ${sim.stats.hits} hits from ${sim.stats.shots} shots.`,
      'Play again',
    );
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // -- HUD -----------------------------------------------------------------------------

  // The bomb line: planted (with the fuse as a progress bar), planting, carrying,
  // or nothing. Returns { text, progress } or null for no line; a null progress
  // leaves the fuse bar as it was (hud.setBomb's contract).
  function bombHudLine() {
    if (sim.phase !== 'live') return { text: '', progress: null };
    if (bomb.state.status === 'planted') {
      const left = 1 - bomb.state.fuse / FUSE_SECONDS;
      return {
        text: `BOMB PLANTED — ${bomb.state.site ? bomb.state.site.name : ''} · ${Math.ceil(bomb.state.fuse)}s`,
        progress: left,
      };
    }
    if (sim.plantChannel > 0) {
      return { text: `PLANTING… ${Math.ceil(sim.plantChannel)}s — hold E`, progress: sim.plantChannel / PLANT_SECONDS };
    }
    if (player.isCarrier) {
      const site = nearestSite(playerMover.body.position);
      const inside = site.center.distanceTo(playerMover.body.position) < site.radius;
      return {
        text: inside ? 'HOLD E TO PLANT THE BOMB' : `CARRYING THE BOMB — reach site ${site.name}`,
        progress: null,
      };
    }
    return null;
  }

  function syncHud() {
    if (sim.phase === 'buy') hud.refreshBuy(player.money, player.owned, player.grenades, player.armor);
    hud.setHealth(player.health, player.armor);
    hud.setAmmo(weaponView.state.mag, weaponView.state.reserve, weaponView.state.def.name);
    hud.setMoney(player.money);
    hud.setTimer(sim.timer);
    hud.setRound(sim.wins.ember, sim.wins.ash, sim.round);
    hud.setHistory(sim.history);
    hud.setPips(teamAlive('ember'), teamTotal('ember'), teamAlive('ash'), teamTotal('ash'));
    hud.setCrosshair(weaponView.spread(playerMover.groundSpeed(), playerMover.body.crouching));
    const line = bombHudLine();
    if (line) hud.setBomb(line.text, line.progress);
  }

  // -- Player actions --------------------------------------------------------------------
  //
  // One function per input group so the live step reads as a list of actions.

  function movePlayer(dt) {
    const body = playerMover.body;
    const keys = input.state.keys;
    const look = input.takeLook();
    playerMover.look(look.x, look.y);
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const sin = Math.sin(body.yaw);
    const cos = Math.cos(body.yaw);
    const wishX = -sin * forward + cos * strafe;
    const wishZ = -cos * forward - sin * strafe;
    const crouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    playerMover.step(dt, wishX, wishZ, keys.has('Space'), crouch);
    weaponView.step(dt);
    // A hard landing is audible: the mover records the fall speed at touchdown.
    if (playerMover.body.fallSpeed > LANDING_SOUND_SPEED) audio.footstep(0.2);
  }

  const WEAPON_SLOTS = { Digit1: 'rifle', Digit2: 'smg', Digit3: 'shotgun', Digit4: 'pistol' };

  function switchWeapon(pressed) {
    for (const [key, id] of Object.entries(WEAPON_SLOTS)) {
      if (!pressed.has(key)) continue;
      if (id === 'pistol' || player.owned[id]) {
        player.primary = id;
        weaponView.equip(WEAPONS[id]);
      }
    }
  }

  // Planting: hold E inside a site while carrying the bomb. The channel fills
  // over PLANT_SECONDS; leaving the site or the key resets it.
  function handlePlant(dt) {
    const body = playerMover.body;
    if (!player.isCarrier || !input.state.keys.has('KeyE')) {
      sim.plantChannel = 0;
      return;
    }
    const site = nearestSite(body.position);
    if (site.center.distanceTo(body.position) >= site.radius) {
      sim.plantChannel = 0;
      return;
    }
    sim.plantChannel += dt;
    bomb.setProgress('plant', sim.plantChannel / PLANT_SECONDS);
    if (sim.plantChannel >= PLANT_SECONDS) {
      sim.plantChannel = 0;
      player.isCarrier = false;
      player.money += PLANT_REWARD;
      bomb.plant(body.position, site);
      audio.plant();
      hud.killfeed(`Bomb planted at site ${site.name}`);
      hud.toast(`Bomb planted at ${site.name}`);
    }
  }

  // Pick up a dropped bomb by walking over it.
  function handleBombPickup() {
    if (bomb.state.status !== 'dropped' || !bomb.state.droppedAt) return;
    if (playerMover.body.position.distanceTo(bomb.state.droppedAt) >= PICKUP_RADIUS) return;
    player.isCarrier = true;
    bomb.carry(player);
    hud.killfeed('You picked up the bomb');
  }

  function stepPlayer(dt) {
    if (!player.alive) return;
    movePlayer(dt);
    if (input.state.firing && weaponView.ready()) playerShoot();
    if (input.state.keys.has('KeyR')) {
      if (weaponView.reload()) audio.reload();
    }
    const pressed = input.takePressed();
    if (pressed.has('KeyM')) {
      const muted = audio.toggleMute();
      hud.toast(muted ? 'Sound off (M to unmute)' : 'Sound on');
    }
    if (pressed.has('KeyG')) throwGrenade();
    switchWeapon(pressed);
    handlePlant(dt);
    handleBombPickup();
  }

  // -- World systems ------------------------------------------------------------------------

  function stepBombPhase(dt) {
    if (bomb.state.status !== 'planted') return;
    bomb.step(dt, sim.time, () => audio.beep(bomb.state.fuse < 10));
    if (bomb.state.fuse <= 0) {
      bomb.explode();
      audio.explosion();
      explosionLight.position.copy(bomb.state.position).setY(1);
      explosionLight.intensity = 80;
      sim.shake = 1;
      endRound('ember', 'The bomb detonated.');
    }
  }

  // Reflect a grenade off the shallowest penetration axis, losing 60% of that
  // component's speed. Returns true when a collider was hit.
  function bounceOff(grenade, next) {
    const r = 0.09;
    for (const collider of world.colliders) {
      if (next.x <= collider.min.x - r || next.x >= collider.max.x + r
        || next.y <= collider.min.y - r || next.y >= collider.max.y + r
        || next.z <= collider.min.z - r || next.z >= collider.max.z + r) continue;
      const penX = Math.min(next.x - (collider.min.x - r), (collider.max.x + r) - next.x);
      const penY = Math.min(next.y - (collider.min.y - r), (collider.max.y + r) - next.y);
      const penZ = Math.min(next.z - (collider.min.z - r), (collider.max.z + r) - next.z);
      if (penX <= penY && penX <= penZ) grenade.velocity.x *= -0.4;
      else if (penY <= penZ) grenade.velocity.y *= -0.4;
      else grenade.velocity.z *= -0.4;
      return true;
    }
    return false;
  }

  function stepGrenades(dt) {
    for (let i = grenades.length - 1; i >= 0; i -= 1) {
      const grenade = grenades[i];
      grenade.fuse -= dt;
      grenade.velocity.y -= GRAVITY_GRENADE * dt;
      const next = scratch.next.copy(grenade.mesh.position).addScaledVector(grenade.velocity, dt);
      if (!bounceOff(grenade, next)) grenade.mesh.position.copy(next);
      if (grenade.fuse <= 0) {
        explodeGrenade(grenade);
        grenades.splice(i, 1);
      }
    }
  }

  function stepBotPickup() {
    // A dropped bomb is not lost: the nearest living Ember bot picks it up and
    // carries it to a site. Before this, only the player could carry it, so a
    // dead carrier with living teammates still stalled the round to a timeout.
    if (bomb.state.status !== 'dropped' || !bomb.state.droppedAt) return;
    let carrier = null;
    let best = PICKUP_RADIUS;
    for (const bot of bots) {
      if (bot.team !== 'ember' || !bot.alive) continue;
      const distance = bot.mover.body.position.distanceTo(bomb.state.droppedAt);
      if (distance < best) {
        best = distance;
        carrier = bot;
      }
    }
    if (carrier) {
      carrier.carriesBomb = true;
      bomb.carry(carrier);
      hud.killfeed(`${carrier.name} picked up the bomb`);
    }
  }

  // The context the bot system gets each tick: what it may sense and the
  // callbacks it may call. Built fresh so the noise ages out on its own.
  function makeBotContext() {
    return {
      rng,
      noise: sim.noise && sim.time - sim.noise.at < 1.5 ? sim.noise : null,
      bombPlanted: bomb.state.status === 'planted',
      bombPosition: bomb.state.status === 'planted' ? bomb.state.position : null,
      bombDropped: bomb.state.status === 'dropped' ? bomb.state.droppedAt : null,
      enemies: (bot) => botWrappers(bot.team),
      playerAlive: () => player.alive,
      fire: (bot, aimError) => botShoot(bot, aimError),
      nearestSite: (position) => nearestSite(position),
      onPlanted: (bot, site) => {
        // A bot plant used to only play a sound: the bomb itself never changed
        // state, so the fuse never ran and the round could not end by detonation.
        bomb.plant(bot.mover.body.position, site);
        audio.plant();
        hud.killfeed(`Bomb planted at site ${site.name} by ${bot.name}`);
        hud.toast(`Bomb planted at ${site.name} by ${bot.name}`);
      },
      onDefused: () => {
        bomb.defuse();
        audio.defuse();
        endRound('ash', 'The bomb was defused.');
      },
    };
  }

  function stepBots(dt) {
    const ctx = makeBotContext();
    for (const bot of bots) botSystem.stepBot(bot, dt, ctx, sim.time);
  }

  // -- Phase machine ---------------------------------------------------------------------------
  //
  // One step per phase, dispatched by a table so the fixed step reads top to
  // bottom. The live phase runs its systems in order — player, bomb, grenades,
  // bot pickup, bots — and stops early when a system ends the round.

  function stepBuy(dt) {
    sim.timer -= dt;
    const pressed = input.takePressed();
    if (pressed.has('Enter')) {
      sim.phase = 'live';
      sim.timer = ROUND_SECONDS;
      hud.hideBuy();
      input.requestLock();
    }
    for (const key of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']) {
      if (pressed.has(key)) {
        buy(BUY_KEYS[Number(key.slice(-1)) - 1]);
      }
    }
    if (sim.timer <= 0) {
      sim.phase = 'live';
      sim.timer = ROUND_SECONDS;
      hud.hideBuy();
      input.requestLock();
    }
    syncHud();
  }

  function stepRoundEnd(dt) {
    sim.timer -= dt;
    if (sim.timer <= 0) {
      if (sim.wins.ember >= WIN_ROUNDS || sim.wins.ash >= WIN_ROUNDS || sim.round >= MAX_ROUNDS) endMatch();
      else {
        sim.round += 1;
        startRound();
      }
    }
    syncHud();
  }

  function stepLive(dt) {
    sim.timer -= dt;
    if (sim.timer <= 0) {
      if (bomb.state.status === 'planted') {
        // Let the fuse decide: the round only ends when it blows or is defused.
        sim.timer = 0.01;
      } else {
        endRound('ash', 'Time expired with no bomb planted.');
        syncHud();
        return;
      }
    }
    stepPlayer(dt);
    if (sim.phase !== 'live') {
      syncHud();
      return;
    }
    stepBombPhase(dt);
    if (sim.phase !== 'live') {
      syncHud();
      return;
    }
    stepGrenades(dt);
    stepBotPickup();
    stepBots(dt);
    syncHud();
  }

  const PHASE_STEPS = {
    buy: stepBuy,
    roundEnd: stepRoundEnd,
    live: stepLive,
  };

  function step(dt) {
    sim.time += dt;
    // The simulation steps synchronously in capture/selftest mode, where no render
    // runs between steps: refresh world matrices here so every raycast reads the
    // bodies where they actually are.
    scene.updateMatrixWorld(true);
    sim.shake = Math.max(0, sim.shake - dt * 1.4);
    explosionLight.intensity = Math.max(0, explosionLight.intensity - dt * 220);
    for (const tracer of tracers) {
      if (tracer.life > 0) {
        tracer.life -= dt;
        tracer.line.material.opacity = Math.max(0, tracer.life / TRACER_LIFE) * 0.9;
        if (tracer.life <= 0) tracer.line.visible = false;
      }
    }
    if (sim.paused) return;
    const phaseStep = PHASE_STEPS[sim.phase];
    if (!phaseStep) {
      syncHud();
      return;
    }
    phaseStep(dt);
  }

  return {
    sim,
    startMatch,
    startRound,
    step,
    buy,
    syncHud,
    playerMover,
    weaponView,
    botSystem,
    // Capture-only helpers: ?shot=... scripts a round's end and a plant without
    // playing them out. Never used by the live game loop.
    debug: {
      killAllAsh() {
        for (const bot of bots) {
          if (bot.team === 'ash' && bot.alive) botSystem.damage(bot, 10000, 'torso');
        }
        checkRoundEnd();
      },
      plantAtSite(key) {
        const site = world.sites[key];
        playerMover.body.position.set(site.center.x, 0, site.center.z + 2);
        player.isCarrier = true;
        bomb.plant(playerMover.body.position, site);
        audio.plant();
        hud.killfeed(`Bomb planted at site ${site.name}`);
      },
      // Selftest-only: kill the player outright, so the carried bomb drops.
      killPlayer() {
        damagePlayer(10000, false);
      },
    },
    get phase() {
      return sim.phase;
    },
  };
}
