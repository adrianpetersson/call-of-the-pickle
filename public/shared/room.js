// One game room. Runtime-agnostic: the Node server and the Cloudflare Durable Object both
// feed sockets into this class. A "conn" is anything with send(string) and close().
//
// Trust model: this is a relay with a referee, built for a group of colleagues, not for
// strangers. Each client simulates its own movement and reports its own hits; the room owns
// health, deaths, scores, spawns, pickups and the round clock.

import { MAPS } from './maps.js';
import {
  TICK_MS, MAX_PLAYERS, MAX_HP, RESPAWN_MS, SHIELD_MS, ROUND_END_MS, REGEN_DELAY_MS, REGEN_PER_SEC,
  WEAPONS, CLASSES, COLORS, MODES, DURATIONS, PICKUP_RESPAWN_MS, HEALTH_PACK, maxHit, cleanName,
} from './config.js';

const CLASS_IDS = CLASSES.map((c) => c.id);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r2 = (v) => Math.round(v * 100) / 100;

export class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // conn -> player
    this.nextId = 1;
    this.timer = null;
    this.reset();
  }

  reset() {
    this.mode = 'ffa';
    this.mapIdx = 0;
    this.duration = 300;
    this.rotate = true;
    this.phase = 'play';
    this.phaseEnd = 0;
    this.pickups = [];
    this.tickN = 0;
  }

  get map() { return MAPS[this.mapIdx]; }
  get size() { return this.players.size; }
  hostId() { let h = 0; for (const p of this.players.values()) if (!h || p.id < h) h = p.id; return h; }
  byId(id) { for (const p of this.players.values()) if (p.id === id) return p; return null; }

  // ---- transport ----------------------------------------------------------------------
  sendTo(conn, obj) { try { conn.send(JSON.stringify(obj)); } catch { /* socket gone */ } }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const conn of this.players.keys()) {
      if (conn === except) continue;
      try { conn.send(s); } catch { /* socket gone */ }
    }
  }

  message(conn, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const p = this.players.get(conn);
    if (!p) { if (m.t === 'join') this.onJoin(conn, m); return; }
    switch (m.t) {
      case 'st': this.onState(p, m); break;
      case 'spawn': this.onSpawn(p, m); break;
      case 'fire': if (p.alive) this.broadcast({ t: 'fire', id: p.id, w: m.w, o: m.o, e: m.e }, conn); break;
      case 'hit': this.onHit(p, m); break;
      case 'proj': if (p.alive) this.broadcast({ t: 'proj', id: p.id, k: m.k, pid: m.pid, o: m.o, v: m.v }, conn); break;
      case 'ex': this.broadcast({ t: 'ex', id: p.id, k: m.k, pid: m.pid, p: m.p }, conn); break;
      case 'pk': this.onPickup(p, m); break;
      case 'chat': {
        const text = String(m.m ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 140);
        if (text) this.broadcast({ t: 'chat', id: p.id, m: text });
        break;
      }
      case 'pi': this.sendTo(conn, { t: 'po', c: m.c }); break;
      case 'cfg': this.onConfig(p, m); break;
      case 'restart': if (p.id === this.hostId()) this.startRound(); break;
      case 'redeploy': this.onRedeploy(p); break;
      default: break;
    }
  }

  close(conn) {
    const p = this.players.get(conn);
    if (!p) return;
    this.players.delete(conn);
    if (this.players.size === 0) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.reset();
      return;
    }
    this.broadcast({ t: 'leave', id: p.id, host: this.hostId() });
  }

  // ---- joining ------------------------------------------------------------------------
  onJoin(conn, m) {
    if (this.players.size >= MAX_PLAYERS) {
      this.sendTo(conn, { t: 'full' });
      try { conn.close(); } catch { /* ignore */ }
      return;
    }
    const first = this.players.size === 0;
    if (first && m.cfg) this.applyConfig(m.cfg);
    const counts = [0, 0];
    for (const q of this.players.values()) counts[q.tm]++;
    const p = {
      id: this.nextId++,
      n: cleanName(m.name),
      c: Math.max(0, Math.min(COLORS.length - 1, num(m.color) | 0)),
      cls: CLASS_IDS.includes(m.cls) ? m.cls : CLASS_IDS[0],
      tm: counts[0] <= counts[1] ? 0 : 1,
      k: 0, d: 0, streak: 0,
      hp: 0, alive: false,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: 0, fl: 0,
      respawnAt: 0, shieldUntil: 0, lastHurt: 0,
    };
    this.players.set(conn, p);
    if (first) {
      this.startRound(true);
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }
    this.sendTo(conn, { t: 'welcome', id: p.id, code: this.code, ...this.roundInfo() });
    this.broadcast({ t: 'join', p: this.pub(p) }, conn);
  }

  pub(p) { return { id: p.id, n: p.n, c: p.c, cls: p.cls, tm: p.tm, k: p.k, d: p.d, a: p.alive ? 1 : 0, hp: p.hp }; }

  roundInfo() {
    const now = Date.now();
    return {
      mode: this.mode, map: this.mapIdx, dur: this.duration, rotate: this.rotate,
      phase: this.phase, left: Math.max(0, this.phaseEnd - now), host: this.hostId(),
      players: [...this.players.values()].map((p) => this.pub(p)),
      pickups: this.pickups.map((at) => (at <= now ? 1 : 0)),
    };
  }

  applyConfig(c) {
    if (c.mode in MODES) this.mode = c.mode;
    const mi = num(c.map, -1) | 0;
    if (mi >= 0 && mi < MAPS.length) this.mapIdx = mi;
    if (DURATIONS.includes(c.dur)) this.duration = c.dur;
    if (typeof c.rotate === 'boolean') this.rotate = c.rotate;
  }

  onConfig(p, m) {
    if (p.id !== this.hostId()) return;
    this.applyConfig(m);
    this.startRound();
  }

  // ---- rounds -------------------------------------------------------------------------
  startRound(silent) {
    const now = Date.now();
    this.phase = 'play';
    this.phaseEnd = now + this.duration * 1000;
    this.pickups = this.map.pickups.map(() => 0);
    const list = [...this.players.values()].sort((a, b) => a.id - b.id);
    list.forEach((p, i) => {
      p.k = 0; p.d = 0; p.streak = 0; p.hp = 0; p.alive = false; p.respawnAt = 0;
      if (this.mode === 'tdm') p.tm = i % 2;
    });
    if (!silent) this.broadcast({ t: 'round', ...this.roundInfo() });
  }

  endRound() {
    this.phase = 'end';
    this.phaseEnd = Date.now() + ROUND_END_MS;
    for (const p of this.players.values()) { p.alive = false; p.hp = 0; }
    const next = this.rotate ? (this.mapIdx + 1) % MAPS.length : this.mapIdx;
    this.broadcast({ t: 'end', next, left: ROUND_END_MS, players: [...this.players.values()].map((p) => this.pub(p)) });
  }

  teamScore(tm) { let s = 0; for (const p of this.players.values()) if (p.tm === tm) s += p.k; return s; }

  checkLimit() {
    const limit = MODES[this.mode].limit;
    if (this.mode === 'tdm') { if (this.teamScore(0) >= limit || this.teamScore(1) >= limit) this.endRound(); }
    else for (const p of this.players.values()) if (p.k >= limit) { this.endRound(); return; }
  }

  // ---- play ---------------------------------------------------------------------------
  onState(p, m) {
    const s = m.s;
    if (!p.alive || !Array.isArray(s)) return;
    p.x = num(s[0]); p.y = num(s[1]); p.z = num(s[2]);
    p.yaw = num(s[3]); p.pitch = num(s[4]); p.w = num(s[5]) | 0; p.fl = num(s[6]) | 0;
  }

  onSpawn(p, m) {
    const now = Date.now();
    if (this.phase !== 'play' || p.alive || now < p.respawnAt) return;
    if (CLASS_IDS.includes(m.cls)) p.cls = m.cls;
    const sp = this.pickSpawn(p);
    p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw; p.pitch = 0; p.w = 0; p.fl = 0;
    p.hp = MAX_HP; p.alive = true; p.shieldUntil = now + SHIELD_MS; p.lastHurt = 0;
    this.broadcast({ t: 'spawn', id: p.id, p: [sp.x, sp.y, sp.z], yaw: r2(sp.yaw), cls: p.cls });
  }

  pickSpawn(p) {
    let list = this.map.spawns;
    if (this.mode === 'tdm') list = list.filter((s) => s.side === p.tm);
    const foes = [...this.players.values()].filter((q) => q !== p && q.alive && (this.mode !== 'tdm' || q.tm !== p.tm));
    const scored = list.map((s) => {
      let near = 1e9;
      for (const q of foes) near = Math.min(near, (q.x - s.x) ** 2 + (q.z - s.z) ** 2);
      return { s, near };
    }).sort((a, b) => b.near - a.near);
    const top = scored.slice(0, Math.min(3, scored.length));
    return top[Math.floor(Math.random() * top.length)].s;
  }

  onHit(p, m) {
    if (this.phase !== 'play') return;
    const def = WEAPONS[m.w];
    if (!def) return;
    const explosive = def.kind !== 'hitscan';
    if (!p.alive && !explosive) return;           // a rocket may land after its owner fell
    const target = this.byId(m.to);
    if (!target || !target.alive) return;
    const now = Date.now();
    if (now < target.shieldUntil) return;
    if (target === p && !explosive) return;
    if (this.mode === 'tdm' && target !== p && target.tm === p.tm) return;
    const dmg = Math.max(1, Math.min(maxHit(m.w), Math.round(num(m.d))));
    target.hp = Math.max(0, target.hp - dmg);
    target.lastHurt = now;
    const head = m.h ? 1 : 0;
    this.broadcast({ t: 'dmg', to: target.id, by: p.id, d: dmg, hp: target.hp, h: head, w: m.w });
    if (target.hp > 0) return;
    target.alive = false; target.d++; target.streak = 0; target.respawnAt = now + RESPAWN_MS;
    if (target !== p) { p.k++; p.streak++; }
    this.broadcast({ t: 'kill', k: p.id, v: target.id, w: m.w, h: head, kk: p.k, vd: target.d, st: p.streak });
    this.checkLimit();
  }

  // A player gives up their current life to come back with another loadout. Costs a death.
  onRedeploy(p) {
    if (this.phase !== 'play' || !p.alive) return;
    p.alive = false; p.hp = 0; p.d++; p.streak = 0; p.respawnAt = Date.now() + RESPAWN_MS;
    this.broadcast({ t: 'kill', k: p.id, v: p.id, w: 'redeploy', h: 0, kk: p.k, vd: p.d, st: 0 });
  }

  onPickup(p, m) {
    const i = num(m.i, -1) | 0;
    const def = this.map.pickups[i];
    const now = Date.now();
    if (!def || !p.alive || this.pickups[i] > now) return;
    if (def.t === 'hp') {
      if (p.hp >= MAX_HP) return;
      p.hp = Math.min(MAX_HP, p.hp + HEALTH_PACK);
    }
    this.pickups[i] = now + PICKUP_RESPAWN_MS[def.t];
    this.broadcast({ t: 'pk', i, by: p.id, hp: p.hp });
  }

  tick() {
    const now = Date.now();
    this.tickN++;
    if (this.phase === 'play') {
      if (now >= this.phaseEnd) { this.endRound(); return; }
      const regen = this.tickN % 15 === 0;
      const snap = [];
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (regen && p.hp < MAX_HP && now - p.lastHurt > REGEN_DELAY_MS) p.hp = Math.min(MAX_HP, p.hp + REGEN_PER_SEC);
        const fl = (p.fl & ~2) | (now < p.shieldUntil ? 2 : 0);
        snap.push([p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), p.w, fl, p.hp]);
      }
      if (snap.length) this.broadcast({ t: 's', p: snap });
      for (let i = 0; i < this.pickups.length; i++) {
        if (this.pickups[i] && this.pickups[i] <= now) { this.pickups[i] = 0; this.broadcast({ t: 'pkr', i }); }
      }
    } else if (now >= this.phaseEnd) {
      if (this.rotate) this.mapIdx = (this.mapIdx + 1) % MAPS.length;
      this.startRound();
    }
  }
}
