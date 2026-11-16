// Bots: a body that walks the map's routes, holds a site, and shoots back.
//
// The AI is split into three layers so each can be read on its own:
//   1. Perception — one scan per bot, about seven times a second: who is visible,
//      what noise was just heard, and whether the bomb needs the bot.
//   2. Decision — the scan's result picks the bot's state (engage, investigate,
//      plant, defuse, reposition) and arms its reaction timer.
//   3. Behaviour — a table of one update function per state. A state never reaches
//      into another state's logic; it only steers, faces, channels, or fires.
//
// A bot never allocates in the hot loop: one raycaster and a handful of scratch
// vectors serve every bot. Every bot has a skill (0..1) that stretches its
// reaction window and scales its aim error, so a lobby reads as mixed players
// rather than six identical ones. After a burst a bot falls back to nearby cover
// instead of standing in the open, and defenders stagger their defuse runs so
// the whole team does not arrive at once.
import * as THREE from 'three';
import { createMover } from './mover.js';
import { PALETTE } from './palette.js';
import { range } from './rng.js';

const VISION_RANGE = 42;
const VISION_HALF_FOV = 0.96;
const REACTION_MIN = 0.6;
const REACTION_MAX = 1.1;
const BOT_SPEED = 3.6;
const LOST_SIGHT_SECONDS = 2.5;
const REPOSITION_AFTER_BURSTS = 2; // fall back to cover after this many bursts
const NOISE_HEARING_RANGE = 25;
const NOISE_MEMORY_SECONDS = 1.5;
const INVESTIGATE_NOISE_SECONDS = 3;
const INVESTIGATE_LOST_SECONDS = 4;
const INVESTIGATE_BOMB_SECONDS = 5;
const PLANT_SECONDS = 3;
const DEFUSE_SECONDS = 5;
const DEFUSE_STAGGER_MAX = 1.2;
const PICKUP_RADIUS = 1.2;
const DEFUSE_RADIUS = 1.5;
const ARRIVE_RADIUS = 0.5;
const TURN_RATE = 3.2; // radians per second

const TEAM_COLORS = { ember: PALETTE.accent, ash: PALETTE.ash };
const TEAM_NAMES = { ember: 'EMBER', ash: 'ASH' };

// A box part of the body, placed once; the group carries the bot's userData.
function bodyPart(geometry, material, x, y, z) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildMesh(team) {
  const suit = new THREE.MeshStandardMaterial({
    color: new THREE.Color(TEAM_COLORS[team]), roughness: 0.6, metalness: 0.05,
  });
  const visor = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#22262c'), roughness: 0.5, metalness: 0.2,
  });
  const cloth = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#2e3238'), roughness: 0.85,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#111318'), roughness: 0.5, metalness: 0.4,
  });
  const group = new THREE.Group();
  const torso = bodyPart(new THREE.BoxGeometry(0.52, 0.78, 0.3), suit, 0, 1.0, 0);
  const head = bodyPart(new THREE.SphereGeometry(0.155, 16, 12), visor, 0, 1.53, 0);
  const legL = bodyPart(new THREE.BoxGeometry(0.18, 0.62, 0.2), cloth, -0.14, 0.31, 0);
  const legR = bodyPart(new THREE.BoxGeometry(0.18, 0.62, 0.2), cloth, 0.14, 0.31, 0);
  const gun = bodyPart(new THREE.BoxGeometry(0.07, 0.09, 0.55), steel, 0.2, 1.15, -0.3);
  group.add(torso, head, legL, legR, gun);
  return { group, torso, head, legL, legR };
}

export function createBot(scene, world, rng, options) {
  const mover = createMover(world.colliders, options.spawn, options.yaw || 0);
  const parts = buildMesh(options.team);
  scene.add(parts.group);
  const bot = {
    id: options.id,
    team: options.team,
    name: options.name,
    mover,
    parts,
    health: 100,
    armor: options.armor || 0,
    startArmor: options.armor || 0,
    alive: true,
    // Skill 0..1: 1 reacts fast and shoots straight. Assigned per bot so the
    // lobby is a mix; a caller may fix it (captures want a known spread).
    skill: options.skill !== undefined ? options.skill : range(rng, 0.35, 0.85),
    state: options.holdPoint ? 'hold' : 'patrol',
    route: options.route || null,
    routeIndex: 0,
    holdPoint: options.holdPoint || null,
    def: options.def,
    yaw: options.yaw || 0,
    // What the bot is looking at, and when it last saw it.
    target: null,
    lastSeen: new THREE.Vector3(),
    lastSeenAt: -99,
    // Duel timing: when the bot may first shoot, and the burst it is in.
    reactionAt: 0,
    burstLeft: 0,
    burstPause: 0,
    cooldown: 0,
    burstsFired: 0,
    // Sensing: staggered vision checks and a per-bot scan phase for sway/strafe.
    visionAt: range(rng, 0, 0.15),
    scanPhase: range(rng, 0, Math.PI * 2),
    // Where the bot is walking to look, and until when it keeps looking.
    investigateAt: null,
    investigateUntil: 0,
    // A channel in progress: { kind: 'plant' | 'defuse', left: seconds }.
    channel: null,
    // Death fall animation progress, 0..1.
    fall: 0,
    walkPhase: range(rng, 0, Math.PI * 2),
    carriesBomb: false,
    hasActed: false,
    // Retake stagger: seconds to wait before walking to a planted bomb.
    waitUntil: 0,
    // Reposition: the cover spot the bot is falling back to, and the state it
    // returns to once it arrives.
    repositionAt: null,
    returnState: null,
  };
  parts.torso.userData.bot = bot;
  parts.torso.userData.part = 'torso';
  parts.head.userData.bot = bot;
  parts.head.userData.part = 'head';
  return bot;
}

export function createBotSystem(scene, world, rng) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = VISION_RANGE;
  const eye = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const flat = new THREE.Vector3();
  const wish = new THREE.Vector3();

  // The eye a bot sees from, and the chest it aims at on another body.
  function eyeOf(bot) {
    const body = bot.mover.body;
    eye.set(body.position.x, body.position.y + body.eye, body.position.z);
    return eye;
  }

  function chestOf(body) {
    chest.set(body.position.x, body.position.y + 1.15, body.position.z);
    return chest;
  }

  // True when nothing solid stands between the bot's eye and the other body's
  // chest. Scratch vectors only: the old version allocated two Vector3s per
  // vision check.
  function canSee(bot, body) {
    const from = eyeOf(bot);
    const to = chestOf(body);
    toTarget.copy(to).sub(from);
    const distance = toTarget.length();
    if (distance > VISION_RANGE) return false;
    forward.set(-Math.sin(bot.mover.body.yaw), 0, -Math.cos(bot.mover.body.yaw));
    flat.copy(toTarget).setY(0).normalize();
    if (forward.dot(flat) < Math.cos(VISION_HALF_FOV) && distance > 3) return false;
    raycaster.set(from, toTarget.normalize());
    raycaster.far = distance;
    const hit = raycaster.intersectObjects(world.shootables, false)[0];
    return !hit || hit.distance > distance - 0.6;
  }

  // Turn the body toward a point, capped at TURN_RATE; returns the angle left.
  function turnToward(bot, point, dt) {
    const body = bot.mover.body;
    const dx = point.x - body.position.x;
    const dz = point.z - body.position.z;
    const want = Math.atan2(-dx, -dz);
    let diff = want - body.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    body.yaw += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, diff));
    return Math.abs(diff);
  }

  // Walk toward a point at bot speed; true once inside ARRIVE_RADIUS.
  function advance(bot, point, dt) {
    const body = bot.mover.body;
    const dx = point.x - body.position.x;
    const dz = point.z - body.position.z;
    const length = Math.hypot(dx, dz);
    if (length < ARRIVE_RADIUS) return true;
    wish.set(dx / length, 0, dz / length);
    bot.mover.step(dt, wish.x * (BOT_SPEED / 5.2), wish.z * (BOT_SPEED / 5.2), false, false);
    bot.walkPhase += dt * 9;
    return false;
  }

  // Nearest cover spot from the world's cover list, for the reposition state.
  function findCover(bot) {
    if (!world.cover || world.cover.length === 0) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const point of world.cover) {
      const distance = bot.mover.body.position.distanceTo(point);
      if (distance < bestDistance && distance > 1.5) {
        best = point;
        bestDistance = distance;
      }
    }
    return best;
  }

  // A hit lands: suppression first, then armor, then health. True if it kills.
  function applyHit(bot, amount, part) {
    if (!bot.alive) return false;
    // Suppression: a hit breaks the bot's burst and buys the shooter a breath.
    bot.burstLeft = 0;
    bot.burstPause = 0.6;
    let left = amount;
    if (bot.armor > 0) {
      const absorbed = Math.min(bot.armor, left * 0.5);
      bot.armor -= absorbed;
      left -= absorbed;
    }
    bot.health -= left;
    if (bot.health > 0) return false;
    bot.health = 0;
    bot.alive = false;
    bot.channel = null;
    return true;
  }

  // -- Perception -------------------------------------------------------------
  //
  // Each function returns what the bot noticed; decide() below turns the
  // observations into a state. Vision runs on a stagger so all six bots do not
  // raycast on the same tick.

  function scanForEnemies(bot, ctx) {
    let best = null;
    let bestDistance = Infinity;
    for (const enemy of ctx.enemies(bot)) {
      if (!enemy.alive) continue;
      const distance = bot.mover.body.position.distanceTo(enemy.body.position);
      if (distance < bestDistance && canSee(bot, enemy.body)) {
        best = enemy;
        bestDistance = distance;
      }
    }
    return best ? { enemy: best, distance: bestDistance } : null;
  }

  function hearNoise(bot, ctx, time) {
    if (!ctx.noise) return null;
    const distance = bot.mover.body.position.distanceTo(ctx.noise.position);
    if (distance >= NOISE_HEARING_RANGE) return null;
    if (time - ctx.noise.at >= NOISE_MEMORY_SECONDS) return null;
    return ctx.noise.position;
  }

  // -- Decision ---------------------------------------------------------------
  //
  // Runs the staggered vision scan, the noise check, and the bomb duties, and
  // moves the bot into the state that fits what it noticed. The behaviour table
  // then acts on that state; decide() itself never moves or shoots.

  function decide(bot, ctx, dt, time) {
    bot.visionAt -= dt;
    if (bot.visionAt <= 0) {
      bot.visionAt = 0.15;
      const sighting = scanForEnemies(bot, ctx);
      if (sighting) {
        bot.target = sighting.enemy;
        bot.lastSeen.copy(sighting.enemy.body.position);
        bot.lastSeenAt = time;
        if (bot.state !== 'engage') {
          // Skill stretches the reaction: a 0.35 bot needs up to ~1.5 s, a
          // 0.85 bot as little as ~0.5 s, before its first shot of the duel.
          // Spotting takes longer at range, too: a target 40 m away is
          // noticed later than one across the room, which gives the player a
          // window to win the first duel instead of eating four bursts at
          // once.
          const reaction = range(ctx.rng, REACTION_MIN, REACTION_MAX)
            * (1.35 - bot.skill * 0.7);
          bot.reactionAt = time + reaction * (1 + sighting.distance / 40);
          bot.burstLeft = 0;
          bot.burstPause = 0;
        }
        bot.state = 'engage';
      } else if (bot.state === 'engage' && time - bot.lastSeenAt > LOST_SIGHT_SECONDS) {
        bot.target = null;
        setInvestigate(bot, bot.lastSeen, time + INVESTIGATE_LOST_SECONDS);
      }
    }

    const fighting = bot.state === 'engage' || bot.state === 'plant' || bot.state === 'defuse';
    if (!fighting) {
      const noise = hearNoise(bot, ctx, time);
      if (noise) {
        // A loud noise nearby pulls a holding bot to look at it.
        setInvestigate(bot, noise, time + INVESTIGATE_NOISE_SECONDS);
      }
      if (ctx.bombDropped && bot.team === 'ember') {
        // A dropped bomb is a job for the attackers: an Ember bot that is
        // not fighting walks to it, so a dead carrier does not stall the
        // round on a bomb no one will ever reach. The sim picks it up within
        // PICKUP_RADIUS. A dropped bomb outranks a noise: the noise check
        // above may already have set a destination, and this overwrites it.
        setInvestigate(bot, ctx.bombDropped, time + INVESTIGATE_BOMB_SECONDS);
      }
    }

    // Bomb duty overrides wandering: the carrier plants, a defender defuses.
    if (ctx.bombPlanted && bot.team === 'ash' && bot.state !== 'engage' && bot.state !== 'defuse') {
      bot.state = 'defuse';
      // Stagger the retake: each defender waits a moment before running in,
      // so the whole team does not arrive — and die — at once.
      bot.waitUntil = time + range(ctx.rng, 0, DEFUSE_STAGGER_MAX);
    }
    if (bot.carriesBomb && !ctx.bombPlanted && bot.state !== 'engage' && bot.state !== 'plant') {
      bot.state = 'plant';
    }
  }

  function setInvestigate(bot, point, until) {
    bot.state = 'investigate';
    bot.investigateAt = point.clone();
    bot.investigateUntil = until;
  }

  // -- Fire control -----------------------------------------------------------
  //
  // Burst fire with a pause between bursts. Returns true when a shot was fired
  // this tick, so the behaviour can keep its own timing. Falling back to cover
  // after a few bursts is decided here too, because it is the burst count
  // that triggers it.

  function fireControl(bot, ctx, dt, time) {
    if (time < bot.reactionAt || bot.cooldown !== 0) return false;
    if (bot.burstLeft <= 0) {
      if (bot.burstPause > 0) {
        bot.burstPause -= dt;
        return false;
      }
      bot.burstLeft = 3 + Math.floor(ctx.rng() * 3);
      bot.burstPause = range(ctx.rng, 0.8, 1.6);
      bot.burstsFired += 1;
      // After a couple of bursts, fall back to cover: a bot that never moves
      // after firing is a bot the player farms from one angle.
      if (bot.burstsFired >= REPOSITION_AFTER_BURSTS) {
        bot.burstsFired = 0;
        const cover = findCover(bot);
        if (cover) {
          bot.state = 'reposition';
          bot.repositionAt = cover;
          bot.returnState = bot.holdPoint ? 'hold' : 'patrol';
          return false;
        }
      }
    }
    // Skill tightens the aim: a 0.85 bot's error is about half a 0.35 bot's.
    const distance = bot.target.body.position.distanceTo(bot.mover.body.position);
    const aimError = (0.05 + distance * 0.002) * (1.25 - bot.skill * 0.5);
    ctx.fire(bot, aimError);
    bot.burstLeft -= 1;
    bot.cooldown = bot.def.fireGap;
    return true;
  }

  // -- Behaviour table ---------------------------------------------------------
  //
  // One update per state. Each receives the bot, the sim context, dt and the
  // clock, and only steers, faces, channels, or fires.

  function updateEngage(bot, ctx, dt, time) {
    const targetAlive = bot.target.isPlayer ? ctx.playerAlive() : bot.target.bot.alive;
    if (!bot.target || !targetAlive) {
      setInvestigate(bot, bot.lastSeen, time + INVESTIGATE_NOISE_SECONDS);
      return;
    }
    const targetBody = bot.target.body;
    turnToward(bot, targetBody.position, dt);
    // Strafe a little so a duel is not two statues.
    const strafe = Math.sin(time * 0.9 + bot.scanPhase) * 0.4;
    const sin = Math.sin(bot.mover.body.yaw);
    const cos = Math.cos(bot.mover.body.yaw);
    bot.mover.step(dt, cos * strafe * 0.5, -sin * strafe * 0.5, false, false);
    fireControl(bot, ctx, dt, time);
  }

  function updateReposition(bot, ctx, dt, time) {
    if (bot.repositionAt) {
      const arrived = advance(bot, bot.repositionAt, dt);
      turnToward(bot, bot.lastSeen, dt);
      if (arrived) {
        bot.state = bot.returnState || 'hold';
        bot.repositionAt = null;
        bot.returnState = null;
      }
    } else {
      bot.state = bot.returnState || 'hold';
    }
  }

  function updatePlant(bot, ctx, dt, time) {
    const site = ctx.nearestSite(bot.mover.body.position);
    if (!site) return;
    // Planting starts inside the site ring, not at its exact centre: the
    // centre is walled by crates and the container, and a bot walking the
    // straight line to it wedges on their corners a metre short.
    const arrived = bot.mover.body.position.distanceTo(site.center) < site.radius
      || advance(bot, site.center, dt);
    turnToward(bot, site.center, dt);
    if (arrived) {
      if (!bot.channel) bot.channel = { kind: 'plant', left: PLANT_SECONDS };
      bot.channel.left -= dt;
      if (bot.channel.left <= 0) {
        bot.channel = null;
        bot.carriesBomb = false;
        // Leave the plant state: staying in it re-runs the channel and
        // re-plants the bomb every 3 s, resetting its fuse forever.
        bot.state = 'hold';
        bot.holdPoint = site.center.clone();
        ctx.onPlanted(bot, site);
      }
    } else {
      bot.channel = null;
    }
  }

  function updateDefuse(bot, ctx, dt, time) {
    if (!ctx.bombPosition) return;
    // Staggered start: wait out the delay before running to the bomb.
    if (time < bot.waitUntil) {
      turnToward(bot, ctx.bombPosition, dt);
      return;
    }
    // Same corner wedge as planting: defusing starts next to the bomb, not
    // pressed against its exact spot.
    const arrived = bot.mover.body.position.distanceTo(ctx.bombPosition) < DEFUSE_RADIUS
      || advance(bot, ctx.bombPosition, dt);
    turnToward(bot, ctx.bombPosition, dt);
    if (arrived) {
      if (!bot.channel) bot.channel = { kind: 'defuse', left: DEFUSE_SECONDS };
      bot.channel.left -= dt;
      if (bot.channel.left <= 0) {
        bot.channel = null;
        ctx.onDefused(bot);
      }
    } else {
      bot.channel = null;
    }
  }

  function updateInvestigate(bot, ctx, dt, time) {
    if (bot.investigateAt) {
      const arrived = advance(bot, bot.investigateAt, dt);
      turnToward(bot, bot.investigateAt, dt);
      if (arrived || time > bot.investigateUntil) {
        bot.state = bot.holdPoint ? 'hold' : 'patrol';
        bot.investigateAt = null;
      }
    } else {
      bot.state = bot.holdPoint ? 'hold' : 'patrol';
    }
  }

  function updateHold(bot, ctx, dt, time) {
    // Sway the view across the lane it guards.
    bot.mover.body.yaw += Math.sin(time * 0.5 + bot.scanPhase) * 0.35 * dt;
  }

  function updatePatrol(bot, ctx, dt, time) {
    if (!bot.route || bot.route.length === 0) return;
    const point = bot.route[bot.routeIndex % bot.route.length];
    const arrived = advance(bot, point, dt);
    turnToward(bot, point, dt);
    if (arrived) {
      bot.routeIndex += 1;
      if (bot.routeIndex >= bot.route.length) {
        // Attackers hold the ground they took; defenders never patrol.
        bot.state = 'hold';
        bot.holdPoint = bot.route[bot.route.length - 1];
        bot.routeIndex = 0;
      }
    }
  }

  const BEHAVIOUR = {
    engage: updateEngage,
    reposition: updateReposition,
    plant: updatePlant,
    defuse: updateDefuse,
    investigate: updateInvestigate,
    hold: updateHold,
    patrol: updatePatrol,
  };

  function stepBot(bot, dt, ctx, time) {
    if (!bot.alive) {
      bot.fall = Math.min(1, bot.fall + dt / 0.4);
      bot.parts.group.rotation.x = -bot.fall * 1.45;
      bot.parts.group.position.y = -bot.fall * 0.08;
      return;
    }
    bot.cooldown = Math.max(0, bot.cooldown - dt);
    decide(bot, ctx, dt, time);
    const update = BEHAVIOUR[bot.state] || updatePatrol;
    update(bot, ctx, dt, time);
    // Sync the visible body to the mover, with a small walk bob.
    const p = bot.mover.body;
    bot.parts.group.position.set(
      p.position.x,
      p.position.y + Math.abs(Math.sin(bot.walkPhase)) * 0.03,
      p.position.z,
    );
    bot.parts.group.rotation.y = p.yaw;
    bot.parts.legL.rotation.x = Math.sin(bot.walkPhase) * 0.5;
    bot.parts.legR.rotation.x = -Math.sin(bot.walkPhase) * 0.5;
  }

  return {
    stepBot,
    damage: applyHit,
    teamName(team) {
      return TEAM_NAMES[team];
    },
    reset(bot, spawn, yaw) {
      bot.mover.body.position.copy(spawn);
      bot.mover.body.velocity.set(0, 0, 0);
      bot.mover.body.yaw = yaw;
      bot.mover.body.pitch = 0;
      bot.health = 100;
      bot.armor = bot.startArmor;
      bot.alive = true;
      bot.state = bot.holdPoint ? 'hold' : 'patrol';
      bot.routeIndex = 0;
      bot.target = null;
      bot.channel = null;
      bot.fall = 0;
      bot.carriesBomb = false;
      bot.burstsFired = 0;
      bot.repositionAt = null;
      bot.returnState = null;
      bot.waitUntil = 0;
      bot.parts.group.rotation.set(0, yaw, 0);
      bot.parts.group.position.copy(spawn);
    },
  };
}
