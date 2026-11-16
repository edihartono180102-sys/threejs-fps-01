// A small deterministic RNG so a capture (`?shot=...&seed=N`) plays the same every time.
// mulberry32: cheap, good enough for bot jitter, spread and map dressing. The helpers
// below all take the same `random` function, so a seeded run stays reproducible.
export function mulberry32(initial) {
  let a = initial | 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(random, min, max) {
  return min + random() * (max - min);
}

export function pick(random, list) {
  return list[Math.floor(random() * list.length) % list.length];
}

export function chance(random, probability) {
  return random() < probability;
}

// Integer in [min, max): a die roll, a bot skill tier, a spawn pick.
export function int(random, min, max) {
  return min + Math.floor(random() * (max - min));
}

// Fisher-Yates on a copy: the caller's list keeps its order (routes, buy lists).
export function shuffle(random, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// Approximately normal, mean 0, standard deviation 1 (Box-Muller): bot aim error
// and spread cluster around the centre instead of spreading uniformly.
export function gauss(random) {
  const u = Math.max(random(), 1e-9);
  const v = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Entries are { weight, value }; returns a value with probability weight / total.
// Used for bot behaviour picks (which lane to push, which site to hold).
export function weightedPick(random, entries) {
  let total = 0;
  for (const entry of entries) total += entry.weight;
  let roll = random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry.value;
  }
  return entries[entries.length - 1].value;
}
