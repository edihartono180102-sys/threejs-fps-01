// The look plan, in one place: dusk over an industrial yard. Six scene colours plus the
// two team colours; the lighting makes every shade the game needs, so no other colour
// appears in the code. The same names are the CSS custom properties in index.html.
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
