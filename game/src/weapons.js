// Weapons: four guns and one grenade. Each definition owns its numbers; the simulation
// owns the ray and the damage. The view model is boxes on the camera, with a muzzle
// flash plane and a flash light. Spread grows with movement speed and with sustained
// fire, so stopping to aim pays.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9', price: 0, kind: 'pistol',
    mag: 12, reserve: Infinity, fireGap: 0.16, reloadTime: 1.3,
    damage: 26, headDamage: 78, auto: false, pellets: 1,
    spreadStill: 0.004, spreadMoving: 0.02, spreadBloom: 0.004, maxBloom: 0.02,
    range: 60,
  },
  rifle: {
    id: 'rifle', name: 'VK-47', price: 2700, kind: 'rifle',
    mag: 30, reserve: 90, fireGap: 0.1, reloadTime: 1.9,
    damage: 34, headDamage: 100, auto: true, pellets: 1,
    spreadStill: 0.0022, spreadMoving: 0.028, spreadBloom: 0.0035, maxBloom: 0.03,
    range: 90,
  },
  smg: {
    id: 'smg', name: 'Hornet-9', price: 1500, kind: 'smg',
    mag: 32, reserve: 96, fireGap: 0.08, reloadTime: 1.6,
    damage: 22, headDamage: 66, auto: true, pellets: 1,
    spreadStill: 0.004, spreadMoving: 0.03, spreadBloom: 0.003, maxBloom: 0.028,
    range: 55,
  },
  shotgun: {
    id: 'shotgun', name: 'Breach-12', price: 1200, kind: 'shotgun',
    mag: 6, reserve: 24, fireGap: 0.85, reloadTime: 2.4,
    damage: 12, headDamage: 30, auto: false, pellets: 8,
    spreadStill: 0.02, spreadMoving: 0.035, spreadBloom: 0.01, maxBloom: 0.04,
    range: 30,
  },
};

export const GRENADE = { name: 'Spark-9', price: 300, maxDamage: 90, radius: 6, fuse: 1.6 };

export function createWeaponView(camera) {
  const grip = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.wall), roughness: 0.7, metalness: 0.2 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.5, metalness: 0.2 });

  const model = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.4), grip);
  barrel.position.set(0, 0.025, -0.38);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), grip);
  stock.position.set(0, -0.02, 0.3);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.02, 0.2), accent);
  stripe.position.set(0, 0.055, -0.05);
  model.add(receiver, barrel, stock, stripe);
  model.position.set(0.24, -0.2, -0.42);
  camera.add(model);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.26),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 6);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  const state = { mag: 12, reserve: Infinity, cooldown: 0, reloadLeft: 0, flash: 0, kick: 0, bloom: 0, def: WEAPONS.pistol };

  function equip(def) {
    state.def = def;
    state.mag = def.mag;
    state.reserve = def.reserve;
    state.cooldown = 0;
    state.reloadLeft = 0;
    state.flash = 0;
    state.kick = 0;
    state.bloom = 0;
  }

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.bloom = Math.max(0, state.bloom - dt * 0.05);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    model.position.z = -0.42 + state.kick;
    model.rotation.x = state.kick * 2.2;
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      model.rotation.x = -0.55 * Math.min(1, (state.def.reloadTime - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const need = state.def.mag - state.mag;
        const take = state.reserve === Infinity ? need : Math.min(need, state.reserve);
        state.mag += take;
        if (state.reserve !== Infinity) state.reserve -= take;
      }
    }
  }

  return {
    state,
    step,
    equip,
    ready() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      state.cooldown = state.def.fireGap;
      state.flash = 0.06;
      state.kick = 0.055;
      state.bloom = Math.min(state.def.maxBloom, state.bloom + state.def.spreadBloom);
    },
    takeRound() {
      if (state.mag <= 0) return false;
      state.mag -= 1;
      return true;
    },
    reload() {
      if (state.reloadLeft > 0 || state.mag === state.def.mag) return false;
      if (state.reserve === 0) return false;
      state.reloadLeft = state.def.reloadTime;
      return true;
    },
    spread(speed) {
      const moving = Math.min(1, speed / 5.2) * state.def.spreadMoving;
      return state.def.spreadStill + moving + state.bloom;
    },
    refill() {
      state.mag = state.def.mag;
      state.reserve = state.def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      state.bloom = 0;
    },
  };
}
