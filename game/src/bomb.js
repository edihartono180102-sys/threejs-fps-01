// The bomb: carried, dropped, planted, defused or gone off. Planting takes 3 seconds
// of holding E inside a site, the fuse runs 35 seconds with beeps that speed up, and
// defusing takes 5 seconds of holding E on the planted bomb. The bomb is a small
// blinking box; its beep light is the only thing a defender needs to find it by.
import * as THREE from 'three';

export const PLANT_SECONDS = 3;
export const DEFUSE_SECONDS = 5;
export const FUSE_SECONDS = 35;

export function createBomb(scene, world) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.2, 0.24),
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#22262c'), roughness: 0.5, metalness: 0.4 }),
  );
  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 10, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2a1a') }),
  );
  light.position.set(0, 0.13, 0);
  const lamp = new THREE.PointLight(new THREE.Color('#ff2a1a'), 0, 4);
  lamp.position.set(0, 0.2, 0);
  group.add(body, light, lamp);
  group.visible = false;
  scene.add(group);

  const state = {
    status: 'carried', // carried | dropped | planted | defused | exploded
    carrier: null,
    position: new THREE.Vector3(),
    site: null,
    fuse: FUSE_SECONDS,
    beepAt: 0,
    droppedAt: null,
  };

  function placeAt(position) {
    state.position.copy(position);
    group.position.set(position.x, 0.1, position.z);
  }

  return {
    state,
    group,
    carry(carrier) {
      state.status = 'carried';
      state.carrier = carrier;
      group.visible = false;
    },
    drop(position) {
      state.status = 'dropped';
      state.carrier = null;
      state.droppedAt = position.clone();
      placeAt(position);
      group.visible = true;
    },
    plant(position, site) {
      state.status = 'planted';
      state.carrier = null;
      state.site = site;
      state.fuse = FUSE_SECONDS;
      state.beepAt = 0;
      placeAt(position);
      group.visible = true;
    },
    defuse() {
      state.status = 'defused';
      group.visible = false;
    },
    explode() {
      state.status = 'exploded';
      group.visible = false;
    },
    // Returns 'beep' when a fuse beep is due, else null. The beeps speed up as the
    // fuse runs down: every 1.0 s above 20 s left, every 0.5 s below it.
    step(dt, time, onBeep) {
      if (state.status !== 'planted') return null;
      state.fuse -= dt;
      const interval = state.fuse > 20 ? 1.0 : 0.5;
      if (time >= state.beepAt) {
        state.beepAt = time + interval;
        lamp.intensity = 6;
        if (onBeep) onBeep(state.fuse);
        return 'beep';
      }
      lamp.intensity = Math.max(0, lamp.intensity - dt * 20);
      return null;
    },
    reset() {
      state.status = 'carried';
      state.carrier = null;
      state.site = null;
      state.fuse = FUSE_SECONDS;
      state.beepAt = 0;
      state.droppedAt = null;
      group.visible = false;
    },
  };
}
