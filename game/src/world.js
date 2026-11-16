// Ember Yard: a 32 x 26 m industrial yard at dusk, built from boxes. Every box is a
// collider for movement and a surface a bullet stops on. Two bombsites, three lanes:
// A-long along the west wall, Mid through the crate yard, B-short along the east wall.
// The attackers spawn south, the defenders north. Plain geometry only, no models,
// no textures, nothing fetched over the network.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const SITE_RADIUS = 4;

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of ['ground', 'wall', 'crate', 'rust', 'teal', 'hazard']) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'hazard' ? 0.5 : 0.92,
      metalness: 0.04,
    });
  }
  const siteMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.hazard),
    roughness: 0.6,
    metalness: 0.1,
    emissive: new THREE.Color(PALETTE.hazard),
    emissiveIntensity: 0.35,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#22262c'),
    roughness: 0.55,
    metalness: 0.5,
  });

  const colliders = [];
  const shootables = [];

  function box(width, height, depth, x, y, z, material, collider = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials[material] || darkMetal);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collider) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
    }
    return mesh;
  }

  function cylinder(radius, height, x, z, material) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 12), materials[material] || darkMetal);
    mesh.position.set(x, height / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    return mesh;
  }

  // Floor and perimeter, 5 m walls, open to the dusk sky.
  box(32.4, 0.4, 26.4, 0, -0.2, 0, 'ground');
  box(0.4, 5, 26.4, -16.2, 2.5, 0, 'wall');
  box(0.4, 5, 26.4, 16.2, 2.5, 0, 'wall');
  box(32.4, 5, 0.4, 0, 2.5, -13.2, 'wall');
  box(32.4, 5, 0.4, 0, 2.5, 13.2, 'wall');

  // Site A "Furnace", west-north: a rust container, crates and a furnace stack.
  box(4.4, 2.6, 2.2, -13.2, 1.3, -9.6, 'rust');
  box(1.2, 1.1, 1.2, -9.4, 0.55, -10.6, 'crate');
  box(1.2, 1.1, 1.2, -9.4, 0.55, -7.4, 'crate');
  box(2.2, 1.1, 1.2, -11.6, 0.55, -5.2, 'crate');
  cylinder(0.9, 4.4, -14.2, -5.6, 'rust');
  // Site B "Depot", east-north: a teal container, a stack and barrels.
  box(4.4, 2.6, 2.2, 13.2, 1.3, -9.6, 'teal');
  box(1.2, 1.1, 1.2, 9.4, 0.55, -10.6, 'crate');
  box(1.2, 1.1, 1.2, 9.4, 0.55, -7.4, 'crate');
  box(2.2, 1.1, 1.2, 11.6, 0.55, -5.2, 'crate');
  cylinder(0.7, 1.1, 14.4, -5.4, 'rust');
  cylinder(0.7, 1.1, 14.4, -4.2, 'teal');

  // Mid: a crate corridor and a low platform to jump onto, plus a pillar pair.
  box(1.2, 1.1, 3.4, -2.2, 0.55, 2.0, 'crate');
  box(1.2, 1.1, 3.4, 2.2, 0.55, 2.0, 'crate');
  box(3.4, 0.5, 2.2, 0, 0.25, -1.4, 'wall');
  box(1.2, 3.4, 1.2, -5.2, 1.7, -4.6, 'wall');
  box(1.2, 3.4, 1.2, 5.2, 1.7, -4.6, 'wall');
  // A-long cover: crates and a low wall near the west lane.
  box(1.2, 1.1, 1.2, -12.4, 0.55, 2.0, 'crate');
  box(1.2, 1.1, 1.2, -12.4, 0.55, 6.4, 'crate');
  box(3.0, 1.0, 0.8, -10.6, 0.5, -1.2, 'wall');
  // B-short cover: crates and a low wall near the east lane.
  box(1.2, 1.1, 1.2, 12.4, 0.55, 2.0, 'crate');
  box(1.2, 1.1, 1.2, 12.4, 0.55, 6.4, 'crate');
  box(3.0, 1.0, 0.8, 10.6, 0.5, -1.2, 'wall');
  // Attacker-side cover and a mid connector.
  box(2.4, 0.9, 1.2, -4.6, 0.45, 8.2, 'crate');
  box(2.4, 0.9, 1.2, 4.6, 0.45, 8.2, 'crate');
  box(1.2, 1.1, 1.2, 0, 0.55, 5.6, 'crate');
  cylinder(0.7, 1.1, -8.0, 9.6, 'teal');
  cylinder(0.7, 1.1, 8.0, 9.6, 'rust');

  // Bombsite markers: a flat glowing ring on the floor, no collider.
  function siteRing(x, z) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(SITE_RADIUS - 0.35, SITE_RADIUS, 40),
      siteMaterial,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.02, z);
    group.add(ring);
    return ring;
  }
  siteRing(-11, -8);
  siteRing(11, -8);

  // Light: a low warm dusk sun from the west, a cool fill from the east, a sky gradient.
  const sky = new THREE.HemisphereLight(new THREE.Color('#46587e'), new THREE.Color('#2a1f18'), 1.0);
  scene.add(sky);
  const key = new THREE.DirectionalLight(new THREE.Color('#ffb36b'), 2.4);
  key.position.set(-14, 12, 9);
  key.target.position.set(2, 0, -4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -22;
  key.shadow.camera.right = 22;
  key.shadow.camera.top = 22;
  key.shadow.camera.bottom = -22;
  key.shadow.camera.far = 60;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(new THREE.Color('#6b8cff'), 0.5);
  fill.position.set(12, 10, 8);
  scene.add(fill);

  return {
    colliders,
    shootables,
    group,
    bounds: { minX: -15.6, maxX: 15.6, minZ: -12.6, maxZ: 12.6 },
    sites: {
      A: { name: 'Furnace', center: new THREE.Vector3(-11, 0, -8), radius: SITE_RADIUS },
      B: { name: 'Depot', center: new THREE.Vector3(11, 0, -8), radius: SITE_RADIUS },
    },
    spawnAttacker: [
      new THREE.Vector3(-3, 0, 11),
      new THREE.Vector3(0, 0, 11.5),
      new THREE.Vector3(3, 0, 11),
    ],
    spawnDefender: [
      new THREE.Vector3(-6, 0, -11),
      new THREE.Vector3(-1, 0, -11.5),
      new THREE.Vector3(3, 0, -11),
      new THREE.Vector3(8, 0, -11),
    ],
    // Waypoints: lanes the bots walk. Each list is a route from south to a site.
    routes: {
      toA: [
        new THREE.Vector3(-3, 0, 11), new THREE.Vector3(-9, 0, 6), new THREE.Vector3(-12.5, 0, 0),
        new THREE.Vector3(-12.5, 0, -5), new THREE.Vector3(-11, 0, -8),
      ],
      toB: [
        new THREE.Vector3(3, 0, 11), new THREE.Vector3(9, 0, 6), new THREE.Vector3(12.5, 0, 0),
        new THREE.Vector3(12.5, 0, -5), new THREE.Vector3(11, 0, -8),
      ],
      toMid: [
        new THREE.Vector3(0, 0, 11), new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -4), new THREE.Vector3(0, 0, -8),
      ],
      holdA: [new THREE.Vector3(-9.4, 0, -10.6), new THREE.Vector3(-11.6, 0, -5.2), new THREE.Vector3(-13.2, 0, -9.6)],
      holdB: [new THREE.Vector3(9.4, 0, -10.6), new THREE.Vector3(11.6, 0, -5.2), new THREE.Vector3(13.2, 0, -9.6)],
      holdMid: [new THREE.Vector3(-5.2, 0, -4.6), new THREE.Vector3(5.2, 0, -4.6), new THREE.Vector3(0, 0, -8)],
    },
  };
}
