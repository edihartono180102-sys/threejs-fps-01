// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the
// display's rate. Two deterministic modes share the same code as live play:
//   ?shot=start|play|bomb|end&seed=N — scripts a frame, renders it twice,
//     freezes it and sets window.__shotReady, for the screenshots.
//   ?selftest=1 — plays 30 scripted seconds (move, shoot, plant) and writes
//     the results as JSON into #selftest, for headless checks.
// The loop also watches tab visibility: hiding the tab mid-round pauses the
// match, so a player who alt-tabs does not come back to a lost round. The
// selftest reports how fast its own steps ran (steps per second), so a slow
// machine shows up in the result instead of silently passing on fewer
// simulated seconds.
//
// Both scripted modes are tables, not branches: SHOT_SETUPS maps a shot name
// to the scene it stages, and SELFTEST_PHASES lists the selftest's phases in
// order. A new capture or a new check is one more table entry.
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

function buildRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('game').appendChild(renderer.domElement);
  return renderer;
}

const renderer = buildRenderer();

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 24, 62);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createWorld(scene);
const audio = createAudio();
const hud = createHud({
  onBuy: (id) => game.buy(id),
  onMute: () => {
    const muted = audio.toggleMute();
    hud.toast(muted ? 'Sound off (M to unmute)' : 'Sound on');
  },
});
const input = createInput(renderer.domElement, onLockChange);
const game = createSim({ scene, camera, world, hud, audio, input, rng: random, shotMode: Boolean(shot) });
const sim = game.sim;
const playerBody = game.playerMover.body;

let started = false;
let frozen = false;
let accumulator = 0;
let lastTime = performance.now();
let settledSteps = 0; // fixed steps run by settle(): the selftest's own clock

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

// Pausing is one action, used by the lock change and the visibility change
// alike: freeze the sim and tell the player how to resume.
function pauseMatch() {
  sim.paused = true;
  hud.showOverlay('EMBER YARD', 'Paused. Click to resume.', 'Click to resume');
}

function onLockChange(locked) {
  if (shot) return;
  audio.unlock();
  if (locked) {
    started = true;
    sim.paused = false;
    hud.hideOverlay();
    hud.hideBuy();
  } else if (sim.phase === 'live') {
    pauseMatch();
  }
}

// Hiding the tab mid-round pauses the match: without this, the fixed-step loop
// keeps running on the background tab's throttled clock and the round is lost
// to a timer the player never saw. Captures and selftests never hide the tab,
// so they are exempt.
document.addEventListener('visibilitychange', () => {
  if (shot || selftest) return;
  if (document.hidden && sim.phase === 'live') pauseMatch();
});

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

// Advance the simulation by a fixed number of steps, on the selftest's clock.
function settle(steps) {
  settledSteps += steps;
  for (let i = 0; i < steps; i += 1) game.step(FIXED_STEP);
}

// Aim at a point and hold the trigger for a short burst, then release.
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

// Put a bot at a spot, facing a yaw. Captures stage bodies, not rounds.
function stageBot(bot, x, z, yaw) {
  bot.mover.body.position.set(x, 0, z);
  bot.mover.body.yaw = yaw;
}

// -- Screenshot captures --------------------------------------------------------
// Each setup stages one frame: the player, the bots, and a few settled steps.

function setupStart() {
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
}

function setupPlay(ash, ember) {
  // Mid-round firefight on A-long: the player has just dropped one defender
  // and is lining up the next, with a teammate pushing Mid behind.
  playerBody.position.set(-11.5, 0, 4);
  playerBody.yaw = 0;
  playerBody.pitch = 0;
  stageBot(ash[0], -12.2, -3.5, Math.PI);
  stageBot(ash[1], -9.5, -6.5, 2.9);
  stageBot(ember[0], -1.5, 0, 0);
  settle(30);
  // Drop the first defender for real, then line up the second with a live
  // muzzle flash.
  fireAt(botChest(ash[0]));
  fireAt(botChest(ash[0]));
  fireAt(botChest(ash[0]));
  settle(6);
  aimAt(botChest(ash[1]));
  input.state.firing = true;
  settle(8);
  input.state.firing = false;
}

function setupBomb(ash, ember) {
  // The bomb is planted at Furnace with 12 seconds on the fuse; a defender is
  // closing in to defuse while the player covers the site.
  game.debug.plantAtSite('A');
  sim.bomb.fuse = 12;
  playerBody.position.set(-6.5, 0, -4.5);
  playerBody.yaw = 0;
  playerBody.pitch = 0;
  stageBot(ash[2], -9.8, -6.2, -2.0);
  stageBot(ember[1], -13.5, -4, 0.8);
  settle(24);
  aimAt(botChest(ash[2]));
}

function setupEnd() {
  // Round won: every defender is down, the scoreboard reads 1–0.
  game.debug.killAllAsh();
  settle(10);
  playerBody.position.set(-8, 0, -2);
  playerBody.yaw = 0.4;
  playerBody.pitch = 0;
  settle(10);
}

const SHOT_SETUPS = { start: setupStart, play: setupPlay, bomb: setupBomb, end: setupEnd };

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
  const setup = SHOT_SETUPS[name] || setupEnd;
  setup(ash, ember);
  hud.setHealth(sim.player.health, sim.player.armor);
  hud.setAmmo(game.weaponView.state.mag, game.weaponView.state.reserve, game.weaponView.state.def.name);
  paintTwiceThenReady();
}

// -- Selftest -------------------------------------------------------------------
// One phase per entry, run in order; each records what it proved into the
// result. The phases share the firing range and the far corner, so the
// shooting check and the plant check do not fight each other.

const FIRING_LINE = [
  [-12.2, -3.5], [-9.5, -6.5], [-10.5, -9], [-7.5, -8.5],
];
const FAR_CORNER = [14, 11];

function moveDefendersTo(spots, yaw) {
  for (const bot of game.sim.bots.filter((b) => b.team === 'ash')) {
    bot.mover.body.position.set(spots[0], 0, spots[1]);
    bot.mover.body.yaw = yaw;
  }
}

function selftestWalk() {
  // Walk forward for 2 seconds: movement, collision, and the buy-to-live
  // transition all run before any shooting.
  input.state.keys.add('KeyW');
  settle(120);
  input.state.keys.delete('KeyW');
}

function selftestShooting(result) {
  // Firing range on A-long: the player and the defenders face each other down
  // a clear lane, so the shooting check tests aim and damage — not whether a
  // strafing bot happened to drift behind the mid pillar's sightline, which
  // the old mid-map setup let happen and made the check a coin flip.
  const ash = game.sim.bots.filter((b) => b.team === 'ash');
  playerBody.position.set(-11.5, 0, 4);
  playerBody.yaw = 0;
  playerBody.pitch = 0;
  ash.forEach((bot, i) => {
    bot.mover.body.position.set(FIRING_LINE[i][0], 0, FIRING_LINE[i][1]);
    bot.mover.body.yaw = Math.PI;
  });
  settle(10);
  // Shoot the nearest defenders until two drop, or the player drops first.
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
  result.shots = sim.stats.shots;
  result.hits = sim.stats.hits;
  result.kills = sim.stats.kills;
  result.headshots = sim.stats.headshots;
  result.damage = Math.round(sim.stats.damage);
}

function selftestPlant(result) {
  // Walk to site A and plant the bomb for real. The defenders are sent to the
  // far corner first: they stood on the firing line a few metres from the
  // site, and would otherwise gun the planter down mid-channel — the plant
  // check is about the channel, not about surviving a firing squad.
  moveDefendersTo(FAR_CORNER, Math.PI);
  playerBody.position.set(-11, 0, -6);
  input.state.keys.add('KeyE');
  settle(200);
  input.state.keys.delete('KeyE');
  result.bombStatus = sim.bomb.status;
}

function selftestBotCarry(result) {
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
  moveDefendersTo(FAR_CORNER, Math.PI);
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
  result.fuse = Math.round(sim.bomb.fuse * 10) / 10;
}

const SELFTEST_PHASES = [
  { name: 'walk', run: () => selftestWalk() },
  { name: 'shooting', run: (result) => selftestShooting(result) },
  { name: 'plant', run: (result) => selftestPlant(result) },
  { name: 'bot-carry', run: (result) => selftestBotCarry(result) },
];

function runSelftest() {
  const startedAt = performance.now();
  const result = { ok: true, shots: 0, hits: 0, kills: 0, errors, phases: [] };
  try {
    game.startMatch();
    sim.phase = 'live';
    sim.timer = 90;
    hud.hideBuy();
    for (const phase of SELFTEST_PHASES) {
      phase.run(result);
      result.phases.push(phase.name);
    }
    result.phase = sim.phase;
    result.round = sim.round;
    result.wins = { ...sim.wins };
    result.playerAlive = sim.player.alive;
    result.playerHealth = Math.round(sim.player.health);
    result.botsAlive = game.sim.bots.filter((b) => b.alive).length;
    result.botsTotal = game.sim.bots.length;
    result.errors = errors;
    result.ok = errors.length === 0;
  } catch (error) {
    result.ok = false;
    result.errors = errors.concat([String(error && error.message ? error.message : error)]);
  }
  // How fast the scripted steps ran: a selftest that took 30 simulated seconds
  // in 3 wall seconds ran at 600 steps/s; one that took 30 wall seconds is a
  // machine the game would stutter on, and the number says so.
  const wallMs = Math.max(1, Math.round(performance.now() - startedAt));
  result.wallMs = wallMs;
  result.steps = settledSteps;
  result.stepsPerSecond = Math.round((settledSteps / wallMs) * 1000);
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
