// Room logic checks with fake sockets. Run: npm test
import assert from 'node:assert/strict';
import { Room } from '../public/shared/room.js';
import { MAPS } from '../public/shared/maps.js';
import { MAX_HP, maxHit, WEAPONS } from '../public/shared/config.js';

function conn() {
  const c = { out: [], closed: false, send(s) { this.out.push(JSON.parse(s)); }, close() { this.closed = true; } };
  c.last = (t) => [...c.out].reverse().find((m) => m.t === t);
  c.all = (t) => c.out.filter((m) => m.t === t);
  return c;
}
const say = (room, c, obj) => room.message(c, JSON.stringify(obj));

// --- maps are sane -------------------------------------------------------------------------
for (const map of MAPS) {
  assert.ok(map.spawns.length >= 8, `${map.id} has spawns`);
  assert.equal(map.spawns.filter((s) => s.side === 0).length, map.spawns.filter((s) => s.side === 1).length);
  const solid = (x, y, z) => map.cells[(y * map.d + z) * map.w + x] !== 0;
  for (const s of [...map.spawns, ...map.pickups]) {
    const cx = Math.floor(s.x), cz = Math.floor(s.z), cy = Math.round(s.y / 0.5);
    assert.ok(solid(cx, cy - 1, cz), `${map.id} point ${cx},${cz} stands on something`);
    for (let k = 0; k < 3; k++) assert.ok(!solid(cx, cy + k, cz), `${map.id} point ${cx},${cz} has headroom`);
  }
}

// --- join, spawn, hit, kill ----------------------------------------------------------------
const room = new Room('TEST');
const a = conn(), b = conn();
say(room, a, { t: 'join', name: 'Ada', cls: 'rattler', color: 2, cfg: { mode: 'ffa', map: 1, dur: 180 } });
say(room, b, { t: 'join', name: '<b>Bo</b>', cls: 'nope', color: 99 });
const wa = a.last('welcome'), wb = b.last('welcome');
assert.equal(wa.map, 1); assert.equal(wa.dur, 180); assert.equal(wa.host, wa.id);
assert.equal(wb.players.length, 2);
assert.equal(wb.players[1].n, 'bBo/b');
assert.equal(wb.players[1].cls, 'rattler');
assert.equal(a.last('join').p.id, wb.id);

say(room, a, { t: 'spawn', cls: 'longshot' });
say(room, b, { t: 'spawn', cls: 'scatter' });
assert.equal(b.all('spawn').length, 2);
assert.equal(room.byId(wa.id).cls, 'longshot');

// shielded right after spawning
say(room, a, { t: 'hit', to: wb.id, d: 50, w: 'longshot' });
assert.equal(room.byId(wb.id).hp, MAX_HP);
room.byId(wb.id).shieldUntil = 0; room.byId(wa.id).shieldUntil = 0;

// damage is clamped to what the weapon can do
say(room, a, { t: 'hit', to: wb.id, d: 99999, w: 'sidearm', h: 1 });
assert.equal(room.byId(wb.id).hp, MAX_HP - maxHit('sidearm'));
assert.equal(b.last('dmg').by, wa.id);

// no shooting yourself with a rifle, but rockets hurt their owner
say(room, a, { t: 'hit', to: wa.id, d: 50, w: 'rattler' });
assert.equal(room.byId(wa.id).hp, MAX_HP);
say(room, a, { t: 'hit', to: wa.id, d: 30, w: 'thumper' });
assert.equal(room.byId(wa.id).hp, MAX_HP - 30);

say(room, a, { t: 'hit', to: wb.id, d: 200, w: 'longshot', h: 1 });
const kill = b.last('kill');
assert.equal(kill.k, wa.id); assert.equal(kill.v, wb.id); assert.equal(kill.kk, 1);
assert.equal(room.byId(wb.id).alive, false);

// dead players cannot respawn early
say(room, b, { t: 'spawn' });
assert.equal(room.byId(wb.id).alive, false);
room.byId(wb.id).respawnAt = 0;
say(room, b, { t: 'spawn' });
assert.equal(room.byId(wb.id).alive, true);

// --- pickups ------------------------------------------------------------------------------
const hpIdx = room.map.pickups.findIndex((p) => p.t === 'hp');
room.byId(wa.id).hp = 40;
say(room, a, { t: 'pk', i: hpIdx });
assert.equal(room.byId(wa.id).hp, 90);
say(room, a, { t: 'pk', i: hpIdx });
assert.equal(a.all('pk').length, 1, 'pickup is gone until it respawns');

// --- snapshots and round end -----------------------------------------------------------------
say(room, a, { t: 'st', s: [3, 0.5, 4, 1, 0.1, 0, 1] });
room.tick();
const snap = a.last('s');
assert.ok(snap.p.some((e) => e[0] === wa.id && e[1] === 3 && e[8] === 90));

room.byId(wa.id).k = 24; room.byId(wb.id).shieldUntil = 0;
say(room, a, { t: 'hit', to: wb.id, d: 200, w: 'longshot' });
assert.equal(room.phase, 'end');
assert.equal(a.last('end').next, 2);
room.phaseEnd = 0; room.tick();
assert.equal(room.phase, 'play'); assert.equal(room.mapIdx, 2);
assert.equal(a.last('round').players[0].k, 0);

// --- host-only config, team mode, friendly fire ----------------------------------------------
say(room, b, { t: 'cfg', mode: 'tdm' });
assert.equal(room.mode, 'ffa');
say(room, a, { t: 'cfg', mode: 'tdm', map: 0, rotate: false });
assert.equal(room.mode, 'tdm'); assert.equal(room.mapIdx, 0);
const c = conn();
say(room, c, { t: 'join', name: 'Cy', cls: 'thumper', color: 1 });
const wc = c.last('welcome');
for (const x of [a, b, c]) say(room, x, { t: 'spawn' });
for (const p of room.players.values()) p.shieldUntil = 0;
const pa = room.byId(wa.id), pb = room.byId(wb.id), pc = room.byId(wc.id);
assert.notEqual(pa.tm, pb.tm);
const mate = pc.tm === pa.tm ? pa : pb, foe = pc.tm === pa.tm ? pb : pa;
say(room, c, { t: 'hit', to: mate.id, d: 50, w: 'thumper' });
assert.equal(mate.hp, MAX_HP, 'no friendly fire');
say(room, c, { t: 'hit', to: foe.id, d: 50, w: 'thumper' });
assert.equal(foe.hp, MAX_HP - 50);
assert.ok(WEAPONS.thumper.dmg >= 50);

// --- leaving ----------------------------------------------------------------------------------
room.close(a);
assert.equal(b.last('leave').host, wb.id);
room.close(b); room.close(c);
assert.equal(room.size, 0); assert.equal(room.timer, null);

console.log('room tests passed');
