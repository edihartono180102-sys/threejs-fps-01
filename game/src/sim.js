// The simulation: one fixed 60 Hz step, kept apart from rendering. It owns the match —
// buy phase, rounds, economy, the bomb, grenades, tracers and every shot — and pushes
// numbers to the HUD. Rendering only reads bodies and meshes. No allocation in the hot
// loop: one raycaster, a handful of scratch vectors, and a small tracer pool.
import * as THREE from 'three';
import { createMover } from './mover.js';
import { WEAPONS, GRENADE, createWeaponView } from './weapons.js';
import { createBot, createBotSystem } from './bots.js';
import { createBomb, PLANT_SECONDS, DEFUSE_SECONDS, FUSE_SECONDS } from './bomb.js';
import { range } from './rng.js';

const BUY_SECONDS = 12;
const ROUND_SECONDS = 100;
const ROUND_END_SECONDS = 4;
const WIN_ROUNDS = 5;
const MAX_ROUNDS = 9;
const START_MONEY = 800;
const KILL_REWARD = 300;
const WIN_REWARD = 325;
const LOSS_REWARD = 190;
const PLANT_REWARD = 300;
const GRAVITY_GRENADE = 12;

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
  for (let i = 0; i < 10; i += 1) {
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
  };

  function teamAlive(team) {
    if (team === 'ember') {
      return (player.alive ? 1 : 0) + bots.filter((b) => b.team === 'ember' && b.alive).length;
    }
    return bots.filter((b) => b.team === 'ash' && b.alive).length;
  }

  function teamTotal(team) {
    return team === 'ember' ? 1 + bots.filter((b) => b.team === 'ember').length : bots.filter((b) => b.team === 'ash').length;
  }

  function spawnBots() {
    for (const bot of bots) scene.remove(bot.parts.group);
    bots.length = 0;
    const defs = { rifle: WEAPONS.rifle, smg: WEAPONS.smg };
    bots.push(createBot(scene, world, rng, { id: 'ember-1', team: 'ember', name: 'Ember-1', spawn: world.spawnAttacker[0], yaw: 0, route: world.routes.toMid, def: defs.smg }));
    bots.push(createBot(scene, world, rng, { id: 'ember-2', team: 'ember', name: 'Ember-2', spawn: world.spawnAttacker[2], yaw: 0, route: world.routes.toB, def: defs.rifle }));
    bots.push(createBot(scene, world, rng, { id: 'ash-1', team: 'ash', name: 'Ash-1', spawn: world.spawnDefender[0], yaw: Math.PI, holdPoint: world.routes.holdA[0], def: defs.rifle }));
    bots.push(createBot(scene, world, rng, { id: 'ash-2', team: 'ash', name: 'Ash-2', spawn: world.spawnDefender[1], yaw: Math.PI, holdPoint: world.routes.holdB[0], def: defs.smg }));
    bots.push(createBot(scene, world, rng, { id: 'ash-3', team: 'ash', name: 'Ash-3', spawn: world.spawnDefender[2], yaw: Math.PI, holdPoint: world.routes.holdMid[0], def: defs.rifle }));
    bots.push(createBot(scene, world, rng, { id: 'ash-4', team: 'ash', name: 'Ash-4', spawn: world.spawnDefender[3], yaw: Math.PI, holdPoint: world.routes.holdMid[1], def: defs.smg }));
  }

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
    slot.life = 0.07;
  }

  function emitNoise(position) {
    sim.noise = { position: position.clone(), at: sim.time };
  }

  // Resolve one hitscan shot. Returns the hit point. shooterTeam is 'ember' or 'ash'.
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
    // The player is a math body, not a mesh: ray vs head sphere, then vs torso box.
    if (shooterTeam === 'ash' && player.alive) {
      const body = player.mover.body;
      scratch.center.set(body.position.x, body.position.y + 1.53, body.position.z);
      const headDistance = raySphere(origin, dir, scratch.center, 0.17);
      scratch.min.set(body.position.x - 0.34, body.position.y, body.position.z - 0.34);
      scratch.max.set(body.position.x + 0.34, body.position.y + body.height, body.position.z + 0.34);
      const torsoDistance = rayAabb(origin, dir, scratch.min, scratch.max);
      const playerDistance = Math.min(headDistance, torsoDistance);
      if (playerDistance < hitDistance && playerDistance <= def.range) {
        hitDistance = playerDistance;
        end = scratch.point.copy(dir).multiplyScalar(playerDistance).add(origin);
        damagePlayer(headDistance < torsoDistance ? def.headDamage : def.damage, headDistance < torsoDistance);
        return { end, hitBot: null, hitPart: headDistance < torsoDistance ? 'head' : 'torso', hitPlayer: true };
      }
    }
    if (hitBot) {
      const amount = hitPart === 'head' ? def.headDamage : def.damage;
      const killed = botSystem.damage(hitBot, amount, hitPart);
      // Match stats and kill money are the player's own: an Ember bot's hits
      // used to count as the player's and pay the player $300.
      const byPlayer = shooterTeam === 'ember' && shooterBot && shooterBot.id === 'player';
      if (byPlayer) {
        sim.stats.hits += 1;
        sim.stats.damage += amount;
        if (hitPart === 'head') sim.stats.headshots += 1;
      }
      if (killed) {
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

  function playerShoot() {
    const def = weaponView.state.def;
    if (!weaponView.takeRound()) {
      audio.dryFire();
      return;
    }
    sim.stats.shots += 1;
    camera.getWorldDirection(scratch.dir);
    const spread = weaponView.spread(playerMover.groundSpeed());
    scratch.dir.x += (rng() * 2 - 1) * spread;
    scratch.dir.y += (rng() * 2 - 1) * spread;
    scratch.dir.z += (rng() * 2 - 1) * spread;
    scratch.dir.normalize();
    camera.getWorldPosition(scratch.origin);
    const muzzle = scratch.muzzle.copy(scratch.origin).addScaledVector(scratch.dir, 0.6);
    // Every pellet gets its own ray: a shotgun used to fire all eight pellets along
    // one identical line and stop at the first hit, so it dealt a single pellet's
    // damage. Pellets spread around the aim and each one resolves on its own.
    let anyHit = false;
    let anyKill = false;
    let anyHeadshot = false;
    for (let pellet = 0; pellet < def.pellets; pellet += 1) {
      if (def.pellets > 1) {
        scratch.pelletDir.copy(scratch.dir);
        scratch.pelletDir.x += (rng() * 2 - 1) * def.spreadStill;
        scratch.pelletDir.y += (rng() * 2 - 1) * def.spreadStill;
        scratch.pelletDir.z += (rng() * 2 - 1) * def.spreadStill;
        scratch.pelletDir.normalize();
      } else {
        scratch.pelletDir.copy(scratch.dir);
      }
      const result = resolveShot(scratch.origin, scratch.pelletDir, def, 'ember', { id: 'player' });
      addTracer(muzzle, result.end);
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
    playerMover.recoil(0.009 + rng() * 0.004, (rng() * 2 - 1) * 0.004);
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

  function explodeGrenade(grenade) {
    const position = grenade.mesh.position;
    scene.remove(grenade.mesh);
    explosionLight.position.copy(position);
    explosionLight.intensity = 60;
    sim.shake = Math.max(sim.shake, 0.7);
    audio.explosion();
    emitNoise(position);
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

  function buy(itemId) {
    if (sim.phase !== 'buy') return false;
    if (itemId === 'armor') {
      if (player.money < 650 || player.armor >= 50) return false;
      player.money -= 650;
      player.armor = 50;
      audio.buy();
      return true;
    }
    if (itemId === 'grenade') {
      if (player.money < GRENADE.price || player.grenades >= 2) return false;
      player.money -= GRENADE.price;
      player.grenades += 1;
      audio.buy();
      return true;
    }
    const def = WEAPONS[itemId];
    if (!def || player.money < def.price) return false;
    if (player.primary === itemId) return false;
    player.money -= def.price;
    player.owned[itemId] = true;
    player.primary = itemId;
    weaponView.equip(def);
    audio.buy();
    return true;
  }

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

  function endRound(winner, reason) {
    if (sim.phase !== 'live') return;
    sim.phase = 'roundEnd';
    sim.timer = ROUND_END_SECONDS;
    sim.roundWinner = winner;
    sim.wins[winner] += 1;
    const won = winner === 'ember';
    for (const bot of bots) bot.channel = null;
    if (won) {
      player.money += WIN_REWARD;
      audio.roundWin();
    } else {
      player.money += LOSS_REWARD;
      audio.roundLose();
    }
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
  }

  function startMatch() {
    sim.wins.ember = 0;
    sim.wins.ash = 0;
    sim.round = 1;
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

  function syncHud() {
    if (sim.phase === 'buy') hud.refreshBuy(player.money, player.owned, player.grenades, player.armor);
    hud.setHealth(player.health, player.armor);
    hud.setAmmo(weaponView.state.mag, weaponView.state.reserve, weaponView.state.def.name);
    hud.setMoney(player.money);
    hud.setTimer(sim.timer);
    hud.setRound(sim.wins.ember, sim.wins.ash, sim.round);
    hud.setPips(teamAlive('ember'), teamTotal('ember'), teamAlive('ash'), teamTotal('ash'));
    hud.setCrosshair(weaponView.spread(playerMover.groundSpeed()));
    if (sim.phase === 'live' && bomb.state.status === 'planted') {
      hud.setBomb(`BOMB PLANTED — ${bomb.state.site ? bomb.state.site.name : ''} · ${Math.ceil(bomb.state.fuse)}s`);
    } else if (sim.phase === 'live' && sim.plantChannel > 0) {
      hud.setBomb(`PLANTING… ${Math.ceil(sim.plantChannel)}s — hold E`);
    } else if (sim.phase === 'live' && player.isCarrier) {
      const site = nearestSite(playerMover.body.position);
      const inside = site.center.distanceTo(playerMover.body.position) < site.radius;
      hud.setBomb(inside ? 'HOLD E TO PLANT THE BOMB' : `CARRYING THE BOMB — reach site ${site.name}`);
    } else if (sim.phase !== 'live') {
      hud.setBomb('');
    }
  }

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
        tracer.line.material.opacity = Math.max(0, tracer.life / 0.07) * 0.9;
        if (tracer.life <= 0) tracer.line.visible = false;
      }
    }
    if (sim.paused) return;

    if (sim.phase === 'buy') {
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
          const item = ['rifle', 'smg', 'shotgun', 'grenade', 'armor'][Number(key.slice(-1)) - 1];
          buy(item);
        }
      }
      if (sim.timer <= 0) {
        sim.phase = 'live';
        sim.timer = ROUND_SECONDS;
        hud.hideBuy();
        input.requestLock();
      }
      syncHud();
      return;
    }

    if (sim.phase === 'roundEnd') {
      sim.timer -= dt;
      if (sim.timer <= 0) {
        if (sim.wins.ember >= WIN_ROUNDS || sim.wins.ash >= WIN_ROUNDS || sim.round >= MAX_ROUNDS) endMatch();
        else {
          sim.round += 1;
          startRound();
        }
      }
      syncHud();
      return;
    }

    if (sim.phase !== 'live') {
      syncHud();
      return;
    }

    // Live phase.
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

    const body = playerMover.body;
    const keys = input.state.keys;
    const look = input.takeLook();
    if (player.alive) {
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

      if (input.state.firing && weaponView.ready()) playerShoot();
      if (keys.has('KeyR')) {
        if (weaponView.reload()) audio.reload();
      }
      const pressed = input.takePressed();
      if (pressed.has('KeyG')) throwGrenade();
      if (pressed.has('Digit1') && player.owned.rifle) { player.primary = 'rifle'; weaponView.equip(WEAPONS.rifle); }
      if (pressed.has('Digit2') && player.owned.smg) { player.primary = 'smg'; weaponView.equip(WEAPONS.smg); }
      if (pressed.has('Digit3') && player.owned.shotgun) { player.primary = 'shotgun'; weaponView.equip(WEAPONS.shotgun); }
      if (pressed.has('Digit4')) { player.primary = 'pistol'; weaponView.equip(WEAPONS.pistol); }

      // Planting: hold E inside a site while carrying the bomb.
      if (player.isCarrier && keys.has('KeyE')) {
        const site = nearestSite(body.position);
        if (site.center.distanceTo(body.position) < site.radius) {
          sim.plantChannel += dt;
          if (sim.plantChannel >= PLANT_SECONDS) {
            sim.plantChannel = 0;
            player.isCarrier = false;
            player.money += PLANT_REWARD;
            bomb.plant(body.position, site);
            audio.plant();
            hud.killfeed(`Bomb planted at site ${site.name}`);
          }
        } else {
          sim.plantChannel = 0;
        }
      } else {
        sim.plantChannel = 0;
      }
      // Pick up a dropped bomb by walking over it.
      if (bomb.state.status === 'dropped' && bomb.state.droppedAt) {
        if (body.position.distanceTo(bomb.state.droppedAt) < 1.2) {
          player.isCarrier = true;
          bomb.carry(player);
          hud.killfeed('You picked up the bomb');
        }
      }
    }

    // Bomb fuse and defuse.
    if (bomb.state.status === 'planted') {
      bomb.step(dt, sim.time, () => audio.beep(bomb.state.fuse < 10));
      if (bomb.state.fuse <= 0) {
        bomb.explode();
        audio.explosion();
        explosionLight.position.copy(bomb.state.position).setY(1);
        explosionLight.intensity = 80;
        sim.shake = 1;
        endRound('ember', 'The bomb detonated.');
        syncHud();
        return;
      }
    }

    // Grenades.
    for (let i = grenades.length - 1; i >= 0; i -= 1) {
      const grenade = grenades[i];
      grenade.fuse -= dt;
      grenade.velocity.y -= GRAVITY_GRENADE * dt;
      const next = grenade.mesh.position.clone().addScaledVector(grenade.velocity, dt);
      let bounced = false;
      for (const collider of world.colliders) {
        if (next.x > collider.min.x - 0.09 && next.x < collider.max.x + 0.09
          && next.y > collider.min.y - 0.09 && next.y < collider.max.y + 0.09
          && next.z > collider.min.z - 0.09 && next.z < collider.max.z + 0.09) {
          const penX = Math.min(next.x - (collider.min.x - 0.09), (collider.max.x + 0.09) - next.x);
          const penY = Math.min(next.y - (collider.min.y - 0.09), (collider.max.y + 0.09) - next.y);
          const penZ = Math.min(next.z - (collider.min.z - 0.09), (collider.max.z + 0.09) - next.z);
          if (penX <= penY && penX <= penZ) grenade.velocity.x *= -0.4;
          else if (penY <= penZ) grenade.velocity.y *= -0.4;
          else grenade.velocity.z *= -0.4;
          bounced = true;
          break;
        }
      }
      if (!bounced) grenade.mesh.position.copy(next);
      if (grenade.fuse <= 0) {
        explodeGrenade(grenade);
        grenades.splice(i, 1);
      }
    }

    // A dropped bomb is not lost: the nearest living Ember bot picks it up and
    // carries it to a site. Before this, only the player could carry it, so a
    // dead carrier with living teammates still stalled the round to a timeout.
    if (bomb.state.status === 'dropped' && bomb.state.droppedAt) {
      let carrier = null;
      let best = 1.2;
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

    // Bots.
    const ctx = {
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
      },
      onDefused: () => {
        bomb.defuse();
        audio.defuse();
        endRound('ash', 'The bomb was defused.');
      },
    };
    for (const bot of bots) botSystem.stepBot(bot, dt, ctx, sim.time);

    syncHud();
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
