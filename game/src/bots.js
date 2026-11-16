// Bots: a body that walks the map's routes, holds a site, and shoots back. Each bot is
// a small state machine — hold, patrol, push, engage, investigate, plant, defuse — with
// staggered vision checks (line of sight against the world's boxes only), a reaction
// delay before its first shot, and burst fire with spread, so it reads as a player
// that sees, decides and misses sometimes. Bots never allocate in the hot loop: one
// raycaster and a handful of scratch vectors serve them all.
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

const TEAM_COLORS = { ember: PALETTE.accent, ash: PALETTE.ash };
const TEAM_NAMES = { ember: 'EMBER', ash: 'ASH' };

function buildMesh(team) {
  const color = new THREE.Color(TEAM_COLORS[team]);
  const dark = new THREE.Color('#22262c');
  const torsoMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
  const headMat = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.5, metalness: 0.2 });
  const legMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#2e3238'), roughness: 0.85 });
  const gunMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#111318'), roughness: 0.5, metalness: 0.4 });

  const group = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.78, 0.3), torsoMat);
  torso.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 12), headMat);
  head.position.y = 1.53;
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.62, 0.2), legMat);
  legL.position.set(-0.14, 0.31, 0);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.62, 0.2), legMat);
  legR.position.set(0.14, 0.31, 0);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.55), gunMat);
  gun.position.set(0.2, 1.15, -0.3);
  group.add(torso, head, legL, legR, gun);
  group.traverse((mesh) => {
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
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
    armor: 0,
    alive: true,
    state: options.holdPoint ? 'hold' : 'patrol',
    route: options.route || null,
    routeIndex: 0,
    holdPoint: options.holdPoint || null,
    def: options.def,
    yaw: options.yaw || 0,
    target: null,
    lastSeen: new THREE.Vector3(),
    lastSeenAt: -99,
    reactionAt: 0,
    burstLeft: 0,
    burstPause: 0,
    cooldown: 0,
    visionAt: range(rng, 0, 0.15),
    scanPhase: range(rng, 0, Math.PI * 2),
    investigateAt: null,
    investigateUntil: 0,
    channel: null, // { kind: 'plant'|'defuse', left: seconds }
    fall: 0,
    walkPhase: range(rng, 0, Math.PI * 2),
    carriesBomb: false,
    hasActed: false,
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
  const toTarget = new THREE.Vector3();
  const chest = new THREE.Vector3();
  const wish = new THREE.Vector3();

  function eyeOf(bot) {
    eye.set(bot.mover.body.position.x, bot.mover.body.position.y + bot.mover.body.eye, bot.mover.body.position.z);
    return eye;
  }

  function chestOf(body) {
    chest.set(body.position.x, body.position.y + 1.15, body.position.z);
    return chest;
  }

  // True when nothing solid stands between the bot's eye and the other body's chest.
  function sees(bot, body) {
    const from = eyeOf(bot);
    const to = chestOf(body);
    toTarget.copy(to).sub(from);
    const distance = toTarget.length();
    if (distance > VISION_RANGE) return false;
    const forward = new THREE.Vector3(-Math.sin(bot.mover.body.yaw), 0, -Math.cos(bot.mover.body.yaw));
    const flat = toTarget.clone().setY(0).normalize();
    if (forward.dot(flat) < Math.cos(VISION_HALF_FOV) && distance > 3) return false;
    raycaster.set(from, toTarget.normalize());
    raycaster.far = distance;
    const hit = raycaster.intersectObjects(world.shootables, false)[0];
    return !hit || hit.distance > distance - 0.6;
  }

  function faceToward(bot, point, dt) {
    const dx = point.x - bot.mover.body.position.x;
    const dz = point.z - bot.mover.body.position.z;
    const want = Math.atan2(-dx, -dz);
    let diff = want - bot.mover.body.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turn = Math.max(-3.2 * dt, Math.min(3.2 * dt, diff));
    bot.mover.body.yaw += turn;
    return Math.abs(diff);
  }

  function walkToward(bot, point, dt) {
    const dx = point.x - bot.mover.body.position.x;
    const dz = point.z - bot.mover.body.position.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) return true;
    wish.set(dx / length, 0, dz / length);
    const speed = BOT_SPEED / 5.2;
    bot.mover.step(dt, wish.x * speed, wish.z * speed, false, false);
    bot.walkPhase += dt * 9;
    return false;
  }

  function damage(bot, amount, part) {
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

  function stepBot(bot, dt, ctx, time) {
    const body = bot.mover.body;
    if (!bot.alive) {
      bot.fall = Math.min(1, bot.fall + dt / 0.4);
      bot.parts.group.rotation.x = -bot.fall * 1.45;
      bot.parts.group.position.y = -bot.fall * 0.08;
      return;
    }
    bot.cooldown = Math.max(0, bot.cooldown - dt);

    // Staggered vision: each bot re-checks what it can see about 7 times a second.
    bot.visionAt -= dt;
    if (bot.visionAt <= 0) {
      bot.visionAt = 0.15;
      let best = null;
      let bestDistance = Infinity;
      for (const enemy of ctx.enemies(bot)) {
        if (!enemy.alive) continue;
        const distance = body.position.distanceTo(enemy.body.position);
        if (distance < bestDistance && sees(bot, enemy.body)) {
          best = enemy;
          bestDistance = distance;
        }
      }
      if (best) {
        bot.target = best;
        bot.lastSeen.copy(best.body.position);
        bot.lastSeenAt = time;
        if (bot.state !== 'engage') {
          bot.reactionAt = time + range(ctx.rng, REACTION_MIN, REACTION_MAX);
          bot.burstLeft = 0;
          bot.burstPause = 0;
        }
        bot.state = 'engage';
      } else if (bot.state === 'engage' && time - bot.lastSeenAt > LOST_SIGHT_SECONDS) {
        bot.target = null;
        bot.state = 'investigate';
        bot.investigateAt = bot.lastSeen.clone();
        bot.investigateUntil = time + 4;
      }
    }

    // A loud noise nearby pulls a holding bot to look at it.
    if (ctx.noise && bot.state !== 'engage' && bot.state !== 'plant' && bot.state !== 'defuse') {
      const distance = body.position.distanceTo(ctx.noise.position);
      if (distance < 25 && time - ctx.noise.at < 1.5) {
        bot.state = 'investigate';
        bot.investigateAt = ctx.noise.position.clone();
        bot.investigateUntil = time + 3;
      }
    }

    // A dropped bomb is a job for the attackers: an Ember bot that is not
    // fighting walks to it, so a dead carrier does not stall the round on a
    // bomb no one will ever reach. The sim picks it up within 1.2 m.
    if (ctx.bombDropped && bot.team === 'ember' && bot.state !== 'engage' && bot.state !== 'plant' && bot.state !== 'defuse') {
      bot.state = 'investigate';
      bot.investigateAt = ctx.bombDropped.clone();
      bot.investigateUntil = time + 5;
    }

    // Bomb duty overrides wandering: the carrier plants, a defender defuses.
    if (ctx.bombPlanted && bot.team === 'ash' && bot.state !== 'engage') {
      bot.state = 'defuse';
    }
    if (bot.carriesBomb && !ctx.bombPlanted && bot.state !== 'engage') {
      bot.state = 'plant';
    }

    switch (bot.state) {
      case 'engage': {
        const targetAlive = bot.target.isPlayer ? ctx.playerAlive() : bot.target.bot.alive;
        if (!bot.target || !targetAlive) {
          bot.state = 'investigate';
          bot.investigateAt = bot.lastSeen.clone();
          bot.investigateUntil = time + 3;
          break;
        }
        const targetBody = bot.target.body;
        faceToward(bot, targetBody.position, dt);
        // Strafe a little so a duel is not two statues.
        const strafe = Math.sin(time * 0.9 + bot.scanPhase) * 0.4;
        const sin = Math.sin(body.yaw);
        const cos = Math.cos(body.yaw);
        bot.mover.step(dt, cos * strafe * 0.5, -sin * strafe * 0.5, false, false);
        if (time >= bot.reactionAt && bot.cooldown === 0) {
          if (bot.burstLeft <= 0) {
            if (bot.burstPause > 0) {
              bot.burstPause -= dt;
              break;
            }
            bot.burstLeft = 3 + Math.floor(ctx.rng() * 3);
            bot.burstPause = range(ctx.rng, 0.8, 1.6);
          }
          const aimError = 0.05 + targetBody.position.distanceTo(body.position) * 0.002;
          ctx.fire(bot, aimError);
          bot.burstLeft -= 1;
          bot.cooldown = bot.def.fireGap;
        }
        break;
      }
      case 'plant': {
        const site = ctx.nearestSite(body.position);
        if (!site) break;
        // Planting starts inside the site ring, not at its exact centre: the
        // centre is walled by crates and the container, and a bot walking the
        // straight line to it wedges on their corners a metre short.
        const arrived = body.position.distanceTo(site.center) < site.radius
          || walkToward(bot, site.center, dt);
        faceToward(bot, site.center, dt);
        if (arrived) {
          if (!bot.channel) bot.channel = { kind: 'plant', left: 3 };
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
        break;
      }
      case 'defuse': {
        if (!ctx.bombPosition) break;
        // Same corner wedge as planting: defusing starts next to the bomb,
        // not pressed against its exact spot.
        const arrived = body.position.distanceTo(ctx.bombPosition) < 1.5
          || walkToward(bot, ctx.bombPosition, dt);
        faceToward(bot, ctx.bombPosition, dt);
        if (arrived) {
          if (!bot.channel) bot.channel = { kind: 'defuse', left: 5 };
          bot.channel.left -= dt;
          if (bot.channel.left <= 0) {
            bot.channel = null;
            ctx.onDefused(bot);
          }
        } else {
          bot.channel = null;
        }
        break;
      }
      case 'investigate': {
        if (bot.investigateAt) {
          const arrived = walkToward(bot, bot.investigateAt, dt);
          faceToward(bot, bot.investigateAt, dt);
          if (arrived || time > bot.investigateUntil) {
            bot.state = bot.holdPoint ? 'hold' : 'patrol';
            bot.investigateAt = null;
          }
        } else {
          bot.state = bot.holdPoint ? 'hold' : 'patrol';
        }
        break;
      }
      case 'hold': {
        // Sway the view across the lane it guards.
        bot.mover.body.yaw += Math.sin(time * 0.5 + bot.scanPhase) * 0.35 * dt;
        break;
      }
      case 'patrol':
      default: {
        if (bot.route && bot.route.length > 0) {
          const point = bot.route[bot.routeIndex % bot.route.length];
          const arrived = walkToward(bot, point, dt);
          faceToward(bot, point, dt);
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
        break;
      }
    }

    // Sync the visible body to the mover, with a small walk bob.
    const p = bot.mover.body;
    bot.parts.group.position.set(p.position.x, p.position.y + Math.abs(Math.sin(bot.walkPhase)) * 0.03, p.position.z);
    bot.parts.group.rotation.y = p.yaw;
    bot.parts.legL.rotation.x = Math.sin(bot.walkPhase) * 0.5;
    bot.parts.legR.rotation.x = -Math.sin(bot.walkPhase) * 0.5;
  }

  return {
    stepBot,
    damage,
    teamName(team) {
      return TEAM_NAMES[team];
    },
    reset(bot, spawn, yaw) {
      bot.mover.body.position.copy(spawn);
      bot.mover.body.velocity.set(0, 0, 0);
      bot.mover.body.yaw = yaw;
      bot.mover.body.pitch = 0;
      bot.health = 100;
      bot.armor = 0;
      bot.alive = true;
      bot.state = bot.holdPoint ? 'hold' : 'patrol';
      bot.routeIndex = 0;
      bot.target = null;
      bot.channel = null;
      bot.fall = 0;
      bot.carriesBomb = false;
      bot.parts.group.rotation.set(0, yaw, 0);
      bot.parts.group.position.copy(spawn);
    },
  };
}
