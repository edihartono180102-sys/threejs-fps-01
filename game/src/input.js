// Keyboard and mouse, and the pointer lock that turns the mouse into look. Plain browser
// APIs only: the game asks the canvas for pointer lock and reads movementX/Y while it
// holds it. Keys are exposed as a Set of event.code values so the simulation can read
// them once per fixed step without allocating. Mouse sensitivity is a multiplier on
// the look delta, adjustable at runtime (the HUD mute button and a settings key use
// the same plumbing); the default matches the original feel.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const state = { keys, locked: false, firing: false, lookX: 0, lookY: 0 };
  const pressed = new Set();
  let sensitivity = 1;

  function setKey(event, down) {
    if (down) {
      if (!keys.has(event.code)) pressed.add(event.code);
      keys.add(event.code);
    } else {
      keys.delete(event.code);
    }
    if (event.code === 'Space') event.preventDefault();
  }

  window.addEventListener('keydown', (event) => setKey(event, true));
  window.addEventListener('keyup', (event) => setKey(event, false));
  window.addEventListener('blur', () => {
    keys.clear();
    state.firing = false;
  });
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (state.locked && event.button === 0) state.firing = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      state.firing = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    // Look delta with sensitivity applied; the raw deltas are consumed either way.
    takeLook() {
      const x = state.lookX * sensitivity;
      const y = state.lookY * sensitivity;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    // Edge-triggered keys: true once for the step after the key went down.
    takePressed() {
      const out = pressed;
      pressed.clear();
      return out;
    },
    setSensitivity(value) {
      sensitivity = Math.max(0.2, Math.min(3, value));
      return sensitivity;
    },
    getSensitivity() {
      return sensitivity;
    },
  };
}
