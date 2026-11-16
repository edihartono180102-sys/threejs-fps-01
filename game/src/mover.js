// A humanoid body moving against the world's boxes: acceleration, friction, gravity,
// crouch and jump, resolved as a box against the colliders one axis at a time, so a
// wall never swallows the body. The player and every bot share this one mover.
// Landing impact is recorded on the body (fallSpeed at touchdown) so the simulation
// can react to hard landings without the mover knowing about sound or the HUD.
import * as THREE from 'three';

const RADIUS = 0.34;
const STAND_HEIGHT = 1.72;
const CROUCH_HEIGHT = 1.12;
const STAND_EYE = 1.6;
const CROUCH_EYE = 1.02;
const WALK_SPEED = 5.2;
const CROUCH_SPEED = 2.4;
const GROUND_ACCEL = 42;
const AIR_ACCEL = 9;
const FRICTION = 9;
const GRAVITY = 20;
const JUMP_SPEED = 6.2;
const STEP_UP_HEIGHT = 0.55; // a top this tall is a step, not a wall
const MAX_FALL_SPEED = 30;
const EYE_LERP = 12; // how fast the eye height follows a crouch/stand

export function createMover(colliders, start, yaw = 0) {
  const body = {
    position: start.clone(),
    velocity: new THREE.Vector3(),
    yaw,
    pitch: 0,
    eye: STAND_EYE,
    onGround: true,
    crouching: false,
    height: STAND_HEIGHT,
    // Speed the body was falling at the moment it last landed (0 on the floor).
    // The sim reads it to judge a landing; the mover only records it.
    fallSpeed: 0,
  };
  const probe = new THREE.Box3();
  const wish = new THREE.Vector3();

  // lift keeps the feet and the crown out of the horizontal tests, so standing on the
  // floor is not read as walking into a wall.
  function overlaps(x, y, z, height, lift) {
    probe.min.set(x - RADIUS, y + lift, z - RADIUS);
    probe.max.set(x + RADIUS, y + height - lift, z + RADIUS);
    for (let i = 0; i < colliders.length; i += 1) {
      if (probe.intersectsBox(colliders[i])) return colliders[i];
    }
    return null;
  }

  function look(dx, dy, sensitivity = 0.0022) {
    body.yaw -= dx * sensitivity;
    body.pitch = Math.max(-1.45, Math.min(1.45, body.pitch - dy * sensitivity));
  }

  function recoil(pitchKick, yawKick) {
    body.pitch = Math.min(1.45, body.pitch + pitchKick);
    body.yaw += yawKick;
  }

  // Try to move along one horizontal axis; if a box blocks it, try stepping up onto
  // a low top, otherwise stop. Returns nothing; the body is where it may be.
  function moveAxis(axis, next) {
    const x = axis === 'x' ? next : body.position.x;
    const z = axis === 'z' ? next : body.position.z;
    if (!overlaps(x, body.position.y, z, body.height, 0.04)) {
      if (axis === 'x') body.position.x = next;
      else body.position.z = next;
      return;
    }
    // Step up: a low top the body can climb (the mid platform is 0.5 m) is
    // not a wall. Without this a body walking diagonally into the platform's
    // corner wedges there forever: both axes report a block from the same
    // 4 cm overlap sliver, so nothing ever slides it free.
    const hit = overlaps(x, body.position.y, z, body.height, 0.04);
    const stepTop = hit ? hit.max.y - body.position.y : 0;
    if (hit && stepTop > 0 && stepTop <= STEP_UP_HEIGHT
      && !overlaps(x, hit.max.y, z, body.height, 0.02)) {
      body.position.y = hit.max.y;
      if (axis === 'x') body.position.x = next;
      else body.position.z = next;
    } else if (axis === 'x') {
      body.velocity.x = 0;
    } else {
      body.velocity.z = 0;
    }
  }

  // wishX/wishZ is a unit wish direction in world space (or zero). jump is a boolean.
  function step(dt, wishX, wishZ, wantJump, wantCrouch) {
    if (wantCrouch && !body.crouching) {
      body.crouching = true;
      body.height = CROUCH_HEIGHT;
    } else if (!wantCrouch && body.crouching && !overlaps(body.position.x, body.position.y, body.position.z, STAND_HEIGHT, 0.02)) {
      body.crouching = false;
      body.height = STAND_HEIGHT;
    }
    const eyeTarget = body.crouching ? CROUCH_EYE : STAND_EYE;
    body.eye += (eyeTarget - body.eye) * Math.min(1, dt * EYE_LERP);

    wish.set(wishX, 0, wishZ);
    if (wish.lengthSq() > 1) wish.normalize();
    const speed = body.crouching ? CROUCH_SPEED : WALK_SPEED;
    const blend = Math.min(1, ((body.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt) / speed);
    body.velocity.x += (wish.x * speed - body.velocity.x) * blend;
    body.velocity.z += (wish.z * speed - body.velocity.z) * blend;
    if (body.onGround && !wish.lengthSq()) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      body.velocity.x *= damp;
      body.velocity.z *= damp;
    }

    if (wantJump && body.onGround) {
      body.velocity.y = JUMP_SPEED;
      body.onGround = false;
    }
    body.velocity.y -= GRAVITY * dt;

    moveAxis('x', body.position.x + body.velocity.x * dt);
    moveAxis('z', body.position.z + body.velocity.z * dt);

    // Vertical: land on a top, bump a ceiling, or rest on the floor. The fall speed
    // at the landing moment is kept on the body for the step that just ended.
    const falling = body.velocity.y;
    body.position.y += body.velocity.y * dt;
    body.onGround = false;
    const hit = overlaps(body.position.x, body.position.y, body.position.z, body.height, 0);
    if (hit && body.velocity.y <= 0) {
      body.position.y = hit.max.y;
      body.fallSpeed = Math.max(0, -falling);
      body.velocity.y = 0;
      body.onGround = true;
    } else if (hit) {
      body.position.y = hit.min.y - body.height;
      body.velocity.y = 0;
      body.fallSpeed = 0;
    } else {
      body.fallSpeed = 0;
    }
    if (body.position.y < 0) {
      body.position.y = 0;
      body.fallSpeed = Math.max(0, -falling);
      body.velocity.y = 0;
      body.onGround = true;
    }
    body.velocity.y = Math.max(-MAX_FALL_SPEED, body.velocity.y);
  }

  function groundSpeed() {
    return Math.hypot(body.velocity.x, body.velocity.z);
  }

  return { body, step, look, recoil, groundSpeed };
}
