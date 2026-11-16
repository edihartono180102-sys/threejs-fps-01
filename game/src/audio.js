// Every sound is synthesized with WebAudio: no audio files, no network, nothing to
// license. The context is created lazily on the first user gesture (pointer lock), so
// the page never needs an autoplay permission it does not have. All sounds go through
// one master gain, so mute and volume are one switch each. Footsteps are quiet
// filtered noise so a sprinting bot is audible before it is visible.
export function createAudio() {
  let context = null;
  let master = null;
  let muted = false;
  let volume = 0.5;
  let noiseBuffer = null;

  function ensure() {
    if (context) {
      if (context.state === 'suspended') context.resume();
      return context;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(context.destination);
    const length = context.sampleRate;
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return context;
  }

  function burst(when, duration, filterType, frequency, gainValue, quality = 1) {
    const ctx = ensure();
    if (!ctx || muted) return;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = quality;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(when);
    source.stop(when + duration + 0.02);
  }

  function tone(when, duration, type, from, to, gainValue) {
    const ctx = ensure();
    if (!ctx || muted) return;
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, when);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), when + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.02);
  }

  function now() {
    const ctx = ensure();
    return ctx ? ctx.currentTime : 0;
  }

  return {
    unlock() {
      ensure();
    },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : volume;
      return muted;
    },
    isMuted() {
      return muted;
    },
    setVolume(value) {
      volume = Math.max(0, Math.min(1, value));
      if (master) master.gain.value = muted ? 0 : volume;
      return volume;
    },
    shot(kind) {
      const t = now();
      if (kind === 'shotgun') {
        burst(t, 0.22, 'lowpass', 900, 0.9);
        tone(t, 0.16, 'sine', 160, 45, 0.7);
      } else if (kind === 'smg') {
        burst(t, 0.09, 'bandpass', 2400, 0.55, 1.4);
        tone(t, 0.07, 'square', 220, 90, 0.18);
      } else if (kind === 'pistol') {
        burst(t, 0.12, 'bandpass', 1800, 0.7, 1.2);
        tone(t, 0.09, 'sine', 190, 60, 0.4);
      } else {
        burst(t, 0.14, 'bandpass', 1400, 0.8, 1.1);
        tone(t, 0.11, 'sine', 150, 50, 0.55);
      }
    },
    enemyShot(distance) {
      const t = now();
      const gain = Math.max(0.08, 0.5 - distance * 0.012);
      burst(t, 0.1, 'bandpass', 1100, gain, 1.1);
    },
    hit() {
      tone(now(), 0.05, 'square', 1400, 1400, 0.12);
    },
    kill() {
      const t = now();
      tone(t, 0.07, 'square', 880, 880, 0.14);
      tone(t + 0.07, 0.1, 'square', 1318, 1318, 0.14);
    },
    reload() {
      const t = now();
      tone(t, 0.04, 'square', 500, 300, 0.1);
      tone(t + 0.25, 0.04, 'square', 700, 400, 0.1);
    },
    dryFire() {
      tone(now(), 0.03, 'square', 300, 200, 0.1);
    },
    grenadeThrow() {
      const t = now();
      burst(t, 0.08, 'bandpass', 900, 0.25, 2);
    },
    explosion() {
      const t = now();
      burst(t, 0.9, 'lowpass', 320, 1.0);
      tone(t, 0.8, 'sine', 120, 28, 0.9);
      burst(t + 0.05, 0.3, 'highpass', 2500, 0.3);
    },
    beep(high) {
      tone(now(), high ? 0.16 : 0.08, 'sine', high ? 1200 : 880, high ? 1200 : 880, 0.16);
    },
    plant() {
      const t = now();
      tone(t, 0.06, 'sine', 990, 990, 0.15);
      tone(t + 0.12, 0.06, 'sine', 990, 990, 0.15);
    },
    defuse() {
      tone(now(), 0.09, 'sine', 660, 660, 0.14);
    },
    buy() {
      const t = now();
      tone(t, 0.05, 'square', 1046, 1046, 0.1);
      tone(t + 0.05, 0.07, 'square', 1568, 1568, 0.1);
    },
    hurt() {
      tone(now(), 0.12, 'sawtooth', 180, 70, 0.16);
    },
    // A soft step: lowpass noise, quiet enough to be a cue rather than a sound
    // effect. gain scales with distance; the sim calls it on hard landings too.
    footstep(gainValue = 0.1) {
      burst(now(), 0.06, 'lowpass', 500, Math.max(0.02, Math.min(0.3, gainValue)));
    },
    // UI click for the buy menu and buttons: one short tick, no fanfare.
    click() {
      tone(now(), 0.03, 'square', 900, 900, 0.08);
    },
    // Round start: a two-note rise, quieter than the round-end stings.
    roundStart() {
      const t = now();
      tone(t, 0.1, 'triangle', 440, 440, 0.12);
      tone(t + 0.1, 0.14, 'triangle', 660, 660, 0.12);
    },
    roundWin() {
      const t = now();
      tone(t, 0.12, 'triangle', 523, 523, 0.2);
      tone(t + 0.12, 0.12, 'triangle', 659, 659, 0.2);
      tone(t + 0.24, 0.2, 'triangle', 784, 784, 0.2);
    },
    roundLose() {
      const t = now();
      tone(t, 0.14, 'triangle', 392, 392, 0.18);
      tone(t + 0.14, 0.14, 'triangle', 330, 330, 0.18);
      tone(t + 0.28, 0.22, 'triangle', 262, 262, 0.18);
    },
  };
}
