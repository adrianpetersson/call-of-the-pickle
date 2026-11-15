// Game rules shared by the browser client and the room server.

export const TICK_MS = 66;            // server snapshot rate (~15 Hz)
export const MAX_PLAYERS = 16;
export const MAX_HP = 100;
export const RESPAWN_MS = 3000;
export const SHIELD_MS = 1800;        // spawn protection
export const ROUND_END_MS = 12000;    // scoreboard pause between rounds
export const REGEN_DELAY_MS = 6000;
export const REGEN_PER_SEC = 6;
export const MAX_GRENADES = 3;

// how spread reacts to what the shooter is doing
// settleDelay: spread and recoil only start to recover this long after the last shot, so they
// build up while the trigger is held. kickCap: recoil stops climbing at this many kicks.
export const AIM = { movePenalty: 0.5, airPenalty: 2.2, aimBonus: 0.55, bloomFade: 7, recoilFade: 9, settleDelay: 120, kickCap: 4.5 };

export const PLAYER = {
  radius: 0.32,
  height: 1.5,
  eye: 1.32,
  speed: 6.4,
  jump: 7.6,
  gravity: 22,
};

// Balance rules of thumb used here (check any change with `node tools/balance.js`):
//  - every weapon owns a range: Jar Buster up close, Crunch Rifle in the middle, Long Dill far
//    away, Jar Launcher against groups and cover; the Gherkin is a fallback, never the best pick
//  - the first shot goes where the crosshair is; spread ("bloom") is the price of holding the
//    trigger and fades within a quarter second, so short bursts beat spraying
//  - recoil climbs and sways in a repeating pattern a player can learn to pull against
//  - damage lands on clean shots-to-kill steps against 100 health (no 99-damage near misses)
// rate/reload/fuse in ms. dmg is per pellet. falloff: [fullUntil, minAt, minScale].
// spread/bloom/kick are in radians; side is how much of the kick also sways sideways.
export const WEAPONS = {
  rattler: {
    name: 'Crunch Rifle', kind: 'hitscan', slot: 0, auto: true,
    dmg: 19, head: 1.5, pellets: 1, rate: 100, mag: 30, reserve: 150, reload: 1800,
    spread: 0.004, bloom: 0.0045, maxBloom: 0.030, kick: 0.010, side: 0.5, zoom: 1.35,
    falloff: [20, 48, 0.5],
  },
  scatter: {
    name: 'Jar Buster', kind: 'hitscan', slot: 0, auto: false,
    dmg: 12, head: 1.25, pellets: 10, rate: 820, mag: 6, reserve: 30, reload: 2200,
    spread: 0.062, bloom: 0, maxBloom: 0.062, kick: 0.05, side: 0.2, zoom: 1.2,
    falloff: [6, 20, 0.25],
  },
  longshot: {
    name: 'Long Dill', kind: 'hitscan', slot: 0, auto: false,
    dmg: 82, head: 1.9, pellets: 1, rate: 1250, mag: 4, reserve: 24, reload: 2500,
    spread: 0.045, scopedSpread: 0, bloom: 0, maxBloom: 0.045, kick: 0.06, side: 0.15, zoom: 4.2, scope: true,
    falloff: [200, 201, 1],
  },
  thumper: {
    name: 'Jar Launcher', kind: 'rocket', slot: 0, auto: false,
    dmg: 100, direct: 125, head: 1, pellets: 1, rate: 1100, mag: 3, reserve: 12, reload: 2700,
    spread: 0, bloom: 0, maxBloom: 0, kick: 0.07, side: 0.15, zoom: 1.2,
    speed: 30, radius: 3.8, selfScale: 0.55,
  },
  sidearm: {
    name: 'Gherkin', kind: 'hitscan', slot: 1, auto: false,
    dmg: 24, head: 1.6, pellets: 1, rate: 200, mag: 12, reserve: Infinity, reload: 1200,
    spread: 0.005, bloom: 0.014, maxBloom: 0.04, kick: 0.024, side: 0.3, zoom: 1.3,
    falloff: [12, 32, 0.5],
  },
  fizz: {
    name: 'Brine bomb', kind: 'grenade', slot: 2,
    dmg: 110, head: 1, pellets: 1, radius: 4.8, selfScale: 0.7, fuse: 1700, speed: 17,
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

// The most damage a single "hit" message may carry, per weapon (server-side clamp).
export function maxHit(id) {
  const w = WEAPONS[id];
  if (!w) return 0;
  return Math.ceil(Math.max(w.dmg * w.head * w.pellets, w.direct ?? 0));
}

export const CLASSES = [
  { id: 'rattler', title: 'Gunner', blurb: 'Steady automatic rifle. Good at everything.', stats: [55, 85, 65, 70] },
  { id: 'scatter', title: 'Breacher', blurb: 'Close-range blast. Devastating around corners.', stats: [95, 30, 25, 75] },
  { id: 'longshot', title: 'Marksman', blurb: 'Scoped rifle. One clean headshot ends it.', stats: [90, 20, 100, 55] },
  { id: 'thumper', title: 'Boomer', blurb: 'Lobs jars of brine that burst. Mind your own toes.', stats: [100, 25, 60, 50] },
];
export const STAT_LABELS = ['Damage', 'Fire rate', 'Range', 'Handling'];

export const COLORS = [
  0xffb224, 0xff6b4a, 0xf2557f, 0xc56bff, 0x6d7cff, 0x38b6ff,
  0x27d3c3, 0x4fd46b, 0xb6dd3c, 0xf4e04d, 0xe8e6df, 0x8a94a8,
];
export const TEAM_COLORS = [0xff5a4d, 0x3f9bff];
export const TEAM_NAMES = ['Chili', 'Brine'];

export const MODES = {
  ffa: { name: 'Free-for-all', blurb: 'Everyone for themselves', limit: 25 },
  tdm: { name: 'Team clash', blurb: 'Chili vs Brine', limit: 40 },
};
export const DURATIONS = [180, 300, 480];

export const PICKUP_RESPAWN_MS = { hp: 20000, ammo: 15000 };
export const HEALTH_PACK = 50;

export function cleanName(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || 'Pickle' + Math.floor(100 + Math.random() * 900);
}
export function cleanRoom(s) {
  s = String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return s || 'LOBBY';
}
