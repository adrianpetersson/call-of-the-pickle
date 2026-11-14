// Sample-based sound. The clips in assets/sfx are cut from recorded game-audio libraries by
// tools/build_sfx.sh. Each play gets a little pitch variation; distant sounds are duller and wetter.

const FILES = [
  'rattler', 'sidearm', 'scatter', 'longshot', 'thumper', 'fizz', 'boom', 'splash', 'hit', 'head', 'kill', 'hurt', 'die',
  'impact', 'reload', 'ready', 'empty', 'swap', 'bounce', 'step0', 'step1', 'step2', 'step3', 'jump', 'land',
  'pickup', 'spawn', 'round', 'streak', 'ui', 'chat',
];
// name -> [base gain, pitch variation]
const MIX = {
  rattler: [0.5, 0.04], sidearm: [0.5, 0.04], scatter: [0.75, 0.03], longshot: [0.8, 0.02], thumper: [0.8, 0.04], fizz: [0.4, 0.06],
  boom: [1, 0.05], splash: [0.95, 0.05], hit: [0.7, 0.08], head: [0.8, 0.04], kill: [0.5, 0], hurt: [0.7, 0.08], die: [0.8, 0.07],
  impact: [0.3, 0.14], reload: [0.6, 0.03], ready: [0.5, 0.04], empty: [0.5, 0], swap: [0.45, 0.05], bounce: [0.45, 0.1],
  step: [0.26, 0.1], jump: [0.25, 0.08], land: [0.5, 0.08], pickup: [0.5, 0], spawn: [0.45, 0.03], round: [0.5, 0], streak: [0.5, 0],
  ui: [0.3, 0.04], chat: [0.35, 0.04],
};

export class Sound {
  constructor() {
    this.volume = 0.6;
    this.buffers = new Map();
    this.last = new Map();
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = AC ? new AC() : null;
    if (!this.ctx) return;
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(ctx.destination);
    // a short synthetic room so shots have a tail instead of stopping dead
    const len = Math.floor(ctx.sampleRate * 1.1), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.reverb.connect(wet); wet.connect(this.master);
    this.ready = this.load();
  }

  async load() {
    await Promise.all(FILES.map(async (name) => {
      try {
        const res = await fetch(`assets/sfx/${name}.mp3`);
        this.buffers.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()));
      } catch { /* a missing clip is just silent */ }
    }));
  }

  // must be called from a user gesture
  unlock() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  // vol 0..1, pan -1..1, far 0..1 (how distant: duller and more reverb)
  play(name, vol = 1, pan = 0, far = 0) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.volume <= 0 || vol < 0.01) return;
    const mix = MIX[name] ?? [0.6, 0];
    const key = name === 'step' ? 'step' + Math.floor(Math.random() * 4) : name;
    const buf = this.buffers.get(key);
    if (!buf) return;
    const now = ctx.currentTime;
    if (now - (this.last.get(name) ?? -1) < 0.025) return;     // don't stack identical hits in one frame
    this.last.set(name, now);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * mix[1];
    const g = ctx.createGain();
    g.gain.value = vol * mix[0];
    let node = src;
    if (far > 0.05) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900 + 15000 * Math.pow(1 - far, 2);
      node.connect(lp); node = lp;
    }
    node.connect(g);
    let out = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p); out = p;
    }
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.12 + far * 0.35;
    out.connect(send); send.connect(this.reverb);
    src.start();
  }

  // positional helper: listener = {x,y,z,yaw}
  at(name, pos, listener, vol = 1, range = 55) {
    const dx = pos.x - listener.x, dy = pos.y - listener.y, dz = pos.z - listener.z;
    const dist = Math.hypot(dx, dy, dz);
    const k = Math.max(0, 1 - dist / range);
    if (k <= 0) return;
    const pan = dist > 0.5 ? (dx * Math.cos(listener.yaw) - dz * Math.sin(listener.yaw)) / dist : 0;
    this.play(name, vol * k * k, pan * 0.8, Math.min(1, dist / range));
  }
}
