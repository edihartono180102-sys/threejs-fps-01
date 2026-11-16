// The look plan, in one place: dusk over an industrial yard. Six scene colours plus the
// two team colours; the lighting makes every shade the game needs, so no other colour
// appears in the code. The same names are the CSS custom properties in index.html.
// Helpers here let code derive tints from the plan instead of inventing new hexes.
export const PALETTE = {
  canvas: '#191d29', // sky / fog
  ground: '#2b2622', // yard floor
  wall: '#3a3430', // perimeter and high cover
  crate: '#6b4f2a', // wooden crates
  rust: '#7a3b2e', // red container
  teal: '#2e5a6b', // teal container
  ink: '#f2ede4', // HUD text
  muted: '#9aa3ad', // secondary text
  accent: '#ff7a1a', // EMBER orange, the attackers
  ash: '#5b8fd6', // ASH blue, the defenders
  hazard: '#e8c33a', // bombsite markers
};

export function shade(name) {
  return PALETTE[name];
}

export function teamColor(team) {
  return team === 'ember' ? PALETTE.accent : PALETTE.ash;
}

// '#rrggbb' -> [r, g, b] in 0..1, for lights and materials that need numbers.
export function hexRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

// Mix two palette hexes: t = 0 returns a, t = 1 returns b. Used for tints such as
// the damage flash (ink -> danger) without adding new literal colours.
export function mixHex(a, b, t) {
  const [ar, ag, ab] = hexRgb(a);
  const [br, bg, bb] = hexRgb(b);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const r = clamp(ar + (br - ar) * t);
  const g = clamp(ag + (bg - ag) * t);
  const bl = clamp(ab + (bb - ab) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}
