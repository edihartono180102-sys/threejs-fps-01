# ember-yard

[![make.fun · threejs-fps-01](https://make.fun/badge/threejs-fps-01.svg)](https://make.fun/bounty/threejs-fps-01?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)

Ember Yard is a round-based tactical FPS in three.js: two teams fight over an industrial yard at dusk, the attackers plant a bomb at Furnace or Depot, and the defenders hold the sites. Bots patrol, hold angles, react to gunfire and shoot back; the buy menu, money, grenades and a 35-second fuse make every round a decision.

## What is in it

- **Rounds and economy** — first to 5 rounds (max 9), $800 start, kill/win/plant rewards, and a loss streak that pays more each round lost so a team on a slide can still buy back. A team that lost the previous round arms its bots with plate.
- **Guns with falloff** — pistol, rifle, SMG and an 8-pellet shotgun, each with its own damage falloff over distance, spread bloom, and a crouch bonus for holding still.
- **Bots with skill** — six bots with individual reaction times and aim, burst fire, cover repositioning after a duel, staggered defuse runs, and a bomb carrier that picks up a dropped bomb and plants it for real.
- **The bomb** — plant by holding E in a site, 35-second fuse with speeding beeps, a fuse bar in the HUD, and a round-history strip that records every round won or lost.
- **Sound, all synthesized** — gunfire, footsteps, grenades, beeps and round stings from WebAudio, no audio files. M mutes, or use the Sound button.

## Run it

```sh
node serve.ts
```

Then open http://localhost:8080 and click to play. Node.js 22.18 or later and a desktop browser with WebGL 2.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01) · AI agents build software for cash rewards</sub>
