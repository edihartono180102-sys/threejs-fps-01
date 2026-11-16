// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's
// rate. Two deterministic modes share the same code as live play:
//   ?shot=start|play|bomb|end&seed=N — scripts a frame, renders it twice, freezes it
//     and sets window.__shotReady, for the screenshots.
//   ?selftest=1 — plays 30 scripted seconds (move, shoot, plant) and writes the
//     results as JSON into #selftest, for headless checks.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { mulberry32 } from './rng.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { createSim } from './sim.js';
import { WEAPONS } from './weapons.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const selftest = params.get('selftest') === '1';
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const random = mulberry32(seed);
const errors = [];
window.__errors = errors;
window.__shotReady = false;

function recordError(message) {
  errors.push(String(message));
  const node = document.getElementById('fatal');
  if (node) node.textContent = errors.join(' | ');
}
window.addEventListener('error', (event) => recordError(event.message || 'error'));
window.addEventListener('unhandledrejection', (event) => recordError(`rejected: ${event.reason}`));

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 24, 62);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createWorld(scene);
const audio = createAudio();
const hud = createHud({
  onBuy: (id) => game.buy(id),
});
const input = createInput(renderer.domElement, onLockChange);
const game = createSim({ scene, camera, world, hud, audio, input, rng: random, shotMode: Boolean(shot) });
const sim = game.sim;
const playerBody = game.playerMover.body;

let started = false;
let frozen = false;
let accumulator = 0;
let lastTime = performance.now();

hud.onPlay(() => {
  if (shot) return;
  audio.unlock();
  if (sim.phase === 'menu') {
    game.startMatch();
    input.requestLock();
  } else if (sim.phase === 'matchEnd') {
    game.startMatch();
    input.requestLock();
  } else if (sim.phase === 'roundEnd') {
    hud.hideOverlay();
  }
});

function onLockChange(locked) {
  if (shot) return;
  audio.unlock();
  if (locked) {
    started = true;
    sim.paused = false;
    hud.hideOverlay();
    hud.hideBuy();
  } else if (sim.phase === 'live') {
    sim.paused = true;
    hud.showOverlay('EMBER YARD', 'Paused. Click to resume.', 'Click to resume');
  }
}

function syncCamera() {
  const body = sim.player.alive ? playerBody : sim.spectate ? sim.spectate.mover.body : playerBody;
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
  if (sim.shake > 0) {
    camera.position.x += (random() * 2 - 1) * 0.06 * sim.shake;
    camera.position.y += (random() * 2 - 1) * 0.06 * sim.shake;
    camera.rotation.z += (random() * 2 - 1) * 0.01 * sim.shake;
  }
}

function aimAt(point) {
  const dx = point.x - playerBody.position.x;
  const dy = point.y - (playerBody.position.y + playerBody.eye);
  const dz = point.z - playerBody.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  playerBody.yaw = Math.atan2(-dx, -dz);
  playerBody.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) game.step(FIXED_STEP);
}

function fireAt(point) {
  aimAt(point);
  input.state.firing = true;
  settle(7);
  input.state.firing = false;
  settle(2);
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      if (shot) document.title = 'SHOT_READY';
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

function botChest(bot) {
  const p = bot.mover.body.position;
  return new THREE.Vector3(p.x, p.y + 1.15, p.z);
}

function runShot(name) {
  hud.hideOverlay();
  hud.hideBuy();
  game.startMatch();
  sim.phase = 'live';
  sim.timer = 90;
  hud.hideBuy();
  // The capture loadout: the player bought the VK-47 before the round.
  sim.player.primary = 'rifle';
  sim.player.owned.rifle = true;
  game.weaponView.equip(WEAPONS.rifle);
  const ash = game.sim.bots.filter((b) => b.team === 'ash');
  const ember = game.sim.bots.filter((b) => b.team === 'ember');

  if (name === 'start') {
    playerBody.position.set(0, 0, 11.5);
    playerBody.yaw = 0;
    playerBody.pitch = 0;
    settle(20);
    syncCamera();
    hud.showOverlay(
      'EMBER YARD',
      'Tactical FPS: two teams, five rounds, one bomb. Plant it at Furnace or Depot — or drop every defender. Click to play.',
      'Click to play',
    );
  } else if (name === 'play') {
    // Mid-round firefight on A-long: the player has just dropped one defender and is
    // lining up the next, with a teammate pushing Mid behind.
    playerBody.position.set(-11.5, 0, 4);
    playerBody.yaw = 0;
    playerBody.pitch = 0;
    ash[0].mover.body.position.set(-12.2, 0, -3.5);
    ash[0].mover.body.yaw = Math.PI;
    ash[1].mover.body.position.set(-9.5, 0, -6.5);
    ash[1].mover.body.yaw = 2.9;
    ember[0].mover.body.position.set(-1.5, 0, 0);
    ember[0].mover.body.yaw = 0;
    settle(30);
    // Drop the first defender for real, then line up the second with a live muzzle flash.
    fireAt(botChest(ash[0]));
    fireAt(botChest(ash[0]));
    fireAt(botChest(ash[0]));
    settle(6);
    aimAt(botChest(ash[1]));
    input.state.firing = true;
    settle(8);
    input.state.firing = false;
  } else if (name === 'bomb') {
    // The bomb is planted at Furnace with 12 seconds on the fuse; a defender is
    // closing in to defuse while the player covers the site.
    game.debug.plantAtSite('A');
    sim.bomb.fuse = 12;
    playerBody.position.set(-6.5, 0, -4.5);
    playerBody.yaw = 0;
    playerBody.pitch = 0;
    ash[2].mover.body.position.set(-9.8, 0, -6.2);
    ash[2].mover.body.yaw = -2.0;
    ember[1].mover.body.position.set(-13.5, 0, -4);
    ember[1].mover.body.yaw = 0.8;
    settle(24);
    aimAt(botChest(ash[2]));
  } else {
    // Round won: every defender is down, the scoreboard reads 1–0.
    game.debug.killAllAsh();
    settle(10);
    playerBody.position.set(-8, 0, -2);
    playerBody.yaw = 0.4;
    playerBody.pitch = 0;
    settle(10);
  }
  hud.setHealth(sim.player.health, sim.player.armor);
  hud.setAmmo(game.weaponView.state.mag, game.weaponView.state.reserve, game.weaponView.state.def.name);
  paintTwiceThenReady();
}

function runSelftest() {
  const result = { ok: true, shots: 0, hits: 0, kills: 0, errors, phases: [] };
  try {
    game.startMatch();
    sim.phase = 'live';
    sim.timer = 90;
    hud.hideBuy();
    // Walk forward for 2 seconds.
    input.state.keys.add('KeyW');
    settle(120);
    input.state.keys.delete('KeyW');
    // Shoot the nearest defenders until two drop, or the player drops first.
    const ash = game.sim.bots.filter((b) => b.team === 'ash');
    const killsAtStart = sim.stats.kills;
    for (const bot of ash) {
      let guard = 0;
      while (bot.alive && guard < 40 && sim.player.alive) {
        fireAt(botChest(bot));
        guard += 1;
      }
      if (sim.stats.kills - killsAtStart >= 2) break;
      if (!sim.player.alive) break;
    }
    // Walk to site A and plant the bomb for real.
    playerBody.position.set(-11, 0, -6);
    input.state.keys.add('KeyE');
    settle(200);
    input.state.keys.delete('KeyE');
    result.bombStatus = sim.bomb.status;
    // Bot carry: a fresh round, the player dies mid-map and drops the bomb, an
    // Ember bot picks it up and plants it for real. This is the path the
    // revision fixed: a bot plant used to only play a sound, and no bot ever
    // picked a dropped bomb up.
    game.startRound();
    sim.phase = 'live';
    sim.timer = 90;
    hud.hideBuy();
    playerBody.position.set(-6, 0, 2);
    // Defenders hold the far south-east corner, backs turned, so the carry is
    // a mechanics check and not a 1v4 the carrier usually loses. The carrier
    // walks west to Furnace, away from them.
    for (const bot of game.sim.bots.filter((b) => b.team === 'ash')) {
      bot.mover.body.position.set(14, 0, 11);
      bot.mover.body.yaw = Math.PI;
    }
    const ember1 = game.sim.bots.find((b) => b.id === 'ember-1');
    ember1.mover.body.position.set(-5.5, 0, 2.5);
    game.debug.killPlayer();
    settle(30);
    result.botPickup = ember1.carriesBomb === true;
    result.bombStatusAfterDrop = sim.bomb.status;
    // Walk to a site (~4 s) plus the 3 s plant channel, with room for a duel.
    settle(900);
    result.botPlantStatus = sim.bomb.status;
    result.botPlantSite = sim.bomb.site ? sim.bomb.site.name : null;
    result.phase = sim.phase;
    result.round = sim.round;
    result.wins = { ...sim.wins };
    result.playerAlive = sim.player.alive;
    result.playerHealth = Math.round(sim.player.health);
    result.botsAlive = game.sim.bots.filter((b) => b.alive).length;
    result.botsTotal = game.sim.bots.length;
    result.shots = sim.stats.shots;
    result.hits = sim.stats.hits;
    result.kills = sim.stats.kills;
    result.headshots = sim.stats.headshots;
    result.damage = Math.round(sim.stats.damage);
    result.errors = errors;
    result.ok = errors.length === 0;
  } catch (error) {
    result.ok = false;
    result.errors = errors.concat([String(error && error.message ? error.message : error)]);
  }
  const node = document.getElementById('selftest');
  if (node) node.textContent = JSON.stringify(result);
  document.title = 'SELFTEST_DONE';
  window.__selftest = result;
  paintTwiceThenReady();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    if (sim.player.alive && sim.phase === 'live') game.playerMover.look(look.x, look.y);
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      game.step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCamera();
if (shot) runShot(shot);
else if (selftest) runSelftest();
else {
  hud.showOverlay(
    'EMBER YARD',
    'Tactical FPS: two teams, five rounds, one bomb. Plant it at Furnace or Depot — or drop every defender. Click to play.',
    'Click to play',
  );
  requestAnimationFrame(frame);
}
