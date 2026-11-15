// The game itself: scene, local player, weapons, remote players, projectiles and the
// handlers for everything the room server sends.
import * as THREE from 'three';
import { MAPS, CY, LOBBY, LOBBY_PERIOD } from '../shared/maps.js';
import {
  PLAYER, AIM, WEAPONS, CLASSES, COLORS, TEAM_COLORS, TEAM_NAMES, MAX_HP, MAX_GRENADES, RESPAWN_MS, MODES,
} from '../shared/config.js';
import { World } from './world.js';
import { part, models } from './assets.js';
import { Bot, makeGun, makeGrenadeMesh, makeRocketMesh, makePickup, makeTint } from './avatar.js';
import { FX } from './fx.js';

const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const r2 = (v) => Math.round(v * 100) / 100;
const HALF = 0.36;                       // hit box half-width
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();

// Ray vs axis-aligned box. Returns entry distance, or -1.
function rayBox(o, d, x0, y0, z0, x1, y1, z1, max) {
  let tmin = 0, tmax = max, t1, t2;
  if (Math.abs(d.x) < 1e-9) { if (o.x < x0 || o.x > x1) return -1; }
  else { t1 = (x0 - o.x) / d.x; t2 = (x1 - o.x) / d.x; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
  if (Math.abs(d.y) < 1e-9) { if (o.y < y0 || o.y > y1) return -1; }
  else { t1 = (y0 - o.y) / d.y; t2 = (y1 - o.y) / d.y; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
  if (Math.abs(d.z) < 1e-9) { if (o.z < z0 || o.z > z1) return -1; }
  else { t1 = (z0 - o.z) / d.z; t2 = (z1 - o.z) / d.z; if (t1 > t2) { const s = t1; t1 = t2; t2 = s; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
  return tmin;
}

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Game {
  constructor(canvas, hud, sound, settings) {
    this.canvas = canvas; this.hud = hud; this.sound = sound; this.settings = settings;
    this.net = null;
    this.noLock = new URLSearchParams(location.search).has('nolock');
    this.onLock = null; this.onDisconnect = null; this.onRoster = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;        // the arena is static: render sun shadows once per map

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.08, 700);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x3a4256, 1.25);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(500, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vDir; void main(){ float h = clamp(vDir.y * 1.25 + 0.1, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.6)), 1.0);\n#include <colorspace_fragment>\n}',
      }),
    );
    this.scene.add(this.sky);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshLambertMaterial({ color: 0x333333 }));
    this.ground.rotation.x = -Math.PI / 2; this.ground.position.y = 0.46;
    this.scene.add(this.ground);

    // first-person weapon gets its own scene so it never clips into walls or changes with zoom
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(56, 1, 0.01, 10);
    const vl = new THREE.DirectionalLight(0xffffff, 2); vl.position.set(0.4, 1, 0.6);
    this.vmScene.add(new THREE.HemisphereLight(0xffffff, 0x505a70, 1.9), vl);
    this.vm = new THREE.Group();
    this.vmScene.add(this.vm);
    this.vmGun = null; this.vmKick = 0; this.vmFlashUntil = 0; this.vmTint = makeTint();
    this.vmFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: null, color: 0xffd28a, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    this.vmFlash.scale.setScalar(0.26); this.vmFlash.visible = false;
    this.vm.scale.setScalar(0.5);

    this.fx = new FX(this.scene);
    this.vmFlash.material.map = this.fx.flashes[0].s.material.map;
    this.blobTex = blobTexture();

    this.world = null; this.worldMesh = null; this.mapIdx = -1;
    this.pickMeshes = []; this.pickState = []; this.pickAsk = 0;
    this.remotes = new Map(); this.roster = new Map(); this.projectiles = [];
    this.inRoom = false; this.locked = false; this.typing = false;
    this.mode = 'ffa'; this.phase = 'play'; this.phaseEndAt = 0; this.hostId = 0; this.dur = 300; this.rotate = true; this.code = '';
    this.keys = {}; this.mouse0 = false; this.mouse2 = false; this.clickAt = 0;
    this.pidSeq = 0; this.shake = 0; this.zoomNow = 1; this.menuT = 0; this.deathAng = 0; this.emptyAt = 0;
    this.lastSend = 0; this.lastSent = '';
    this.nextCls = settings.cls;
    this.me = {
      id: 0, alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, recoil: 0, recoilYaw: 0, burst: 0, lastShot: 0,
      onGround: false, hp: 0, cls: settings.cls, weapons: [], cur: 0, grenades: 0, bloom: 0, scopeT: 0,
      stepOff: 0, bobPhase: 0, stepDist: 0, swapEnd: 0, nadeAt: 0, respawnAt: 0, spawnAskAt: 0, shield: false,
      deathPos: new THREE.Vector3(),
    };

    this.preview = new Bot();
    this.preview.tag.visible = false;
    this.scene.add(this.preview.group);

    this.previewShadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false }));
    this.previewShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.previewShadow);
    this.lobbyZ = 30;
    this.loadMap(-1);
    this.setPreview(settings.color, settings.cls);
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.last = performance.now();
    const loop = () => { requestAnimationFrame(loop); this.frame(); };
    loop();
  }

  // ---- setup --------------------------------------------------------------------------
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.vmCamera.aspect = w / h;
    this.camera.updateProjectionMatrix(); this.vmCamera.updateProjectionMatrix();
    this.viewDirty = true;
  }

  loadMap(idx) {
    if (this.worldMesh) { this.scene.remove(this.worldMesh); for (const im of this.worldMesh.children) im.dispose(); }
    for (const p of this.pickMeshes) this.scene.remove(p.g, p.ring);
    this.pickMeshes = [];
    for (const o of this.propMeshes ?? []) this.scene.remove(o);
    this.propMeshes = [];
    const map = idx < 0 ? LOBBY : MAPS[idx];      // -1 is the lobby alley behind the menu
    this.mapIdx = idx;
    this.world = new World(map);
    this.fx.world = this.world;
    this.worldMesh = this.world.buildBlocks(models.blocks);
    this.scene.add(this.worldMesh);
    const sky = map.sky;
    this.sky.material.uniforms.top.value.setHex(sky.top);
    this.sky.material.uniforms.bottom.value.setHex(sky.bottom);
    this.scene.fog = new THREE.Fog(sky.fog, sky.fogNear ?? 28, sky.fogFar ?? 150);
    this.hemi.intensity = idx < 0 ? 0.62 : 1.25; this.sun.intensity = idx < 0 ? 2.2 : 2.7;
    this.hemi.color.setHex(sky.ambient); this.sun.color.setHex(sky.sun);
    const cx = map.w / 2, cz = map.d / 2, half = Math.max(map.w, map.d) * 0.78;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + 0.62 * 60, 0.74 * 60, cz + 0.4 * 60);
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 1; sc.far = 140;
    sc.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
    this.ground.material.color.setHex(map.palette[1]).multiplyScalar(0.55);

    map.pickups.forEach((def) => {
      const g = makePickup(def.t);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.34, 0.46, 24),
        new THREE.MeshBasicMaterial({ color: def.t === 'hp' ? 0x4fe07a : 0xffc04a, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2; ring.position.set(def.x, def.y + 0.03, def.z);
      g.position.set(def.x, def.y + 0.32, def.z);
      this.scene.add(g, ring);
      this.pickMeshes.push({ g, ring, baseY: def.y + 0.32 });
    });
    this.pickState = map.pickups.map(() => 1);
    // dressing: solid props, wall decoration, and the giant kitchen things watching from outside
    for (const p of [...map.props, ...(map.scenery ?? [])]) {
      let o;
      if (p.m === 'Pickle') {
        const fan = new Bot();
        fan.setColor(COLORS[p.c ?? 0]); fan.tag.visible = false; fan.animate(0, 0, 0.1, true);
        o = fan.group;
      } else o = part('props', p.m);
      o.position.set(p.x, p.y, p.z);
      o.rotation.set(p.tilt ?? 0, p.rot ?? 0, 0, 'YXZ');
      o.scale.setScalar(p.s ?? 1);
      if (!p.s) o.traverse((n) => { if (n.isMesh) { n.castShadow = !n.material.transparent; n.receiveShadow = true; } });
      this.scene.add(o);
      this.propMeshes.push(o);
    }
  }

  setPreview(colorIdx, cls) {
    this.preview.setColor(COLORS[colorIdx]);
    this.preview.setWeapon(cls);
  }

  bindInput() {
    const c = this.canvas;
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      if (!this.locked) this.clearInput();
      this.onLock?.(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.active() || !this.me.alive) return;
      const k = (0.0022 * this.settings.sens) / this.zoomNow;
      this.me.yaw -= e.movementX * k;
      this.me.pitch = clamp(this.me.pitch - e.movementY * k, -1.5, 1.5);
    });
    c.addEventListener('mousedown', (e) => {
      if (!this.active()) return;
      if (e.button === 0) { this.mouse0 = true; this.clickAt = performance.now(); }
      if (e.button === 2) this.mouse2 = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse0 = false;
      if (e.button === 2) this.mouse2 = false;
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', () => { if (this.active() && this.me.alive) this.switchTo(this.me.cur ? 0 : 1); }, { passive: true });
    document.addEventListener('keydown', (e) => this.onKey(e, true));
    document.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.clearInput());
  }

  clearInput() { this.keys = {}; this.mouse0 = false; this.mouse2 = false; this.clickAt = 0; }
  active() { return this.inRoom && (this.locked || this.noLock) && !this.typing; }
  requestLock() { if (!this.noLock) this.canvas.requestPointerLock?.(); }

  onKey(e, down) {
    if (!this.inRoom || this.typing) return;
    if (e.code === 'Tab') { e.preventDefault(); this.hud.showScoreboard(down ? this.scoreData() : null); return; }
    if (!this.active()) return;
    if (down && e.code === 'Enter') {
      e.preventDefault();
      this.typing = true; this.clearInput();
      this.hud.openChat((text) => { if (text) this.net?.send({ t: 'chat', m: text }); }, () => { this.typing = false; });
      return;
    }
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.keys[e.code] = down;
    if (!down || e.repeat) return;
    const me = this.me;
    if (!me.alive) {
      const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      if (i >= 0) this.setClass(CLASSES[i].id);
      return;
    }
    switch (e.code) {
      case 'Digit1': this.switchTo(0); break;
      case 'Digit2': this.switchTo(1); break;
      case 'KeyQ': this.switchTo(me.cur ? 0 : 1); break;
      case 'KeyR': this.reload(); break;
      case 'KeyG': case 'KeyF': this.throwGrenade(); break;
      default: break;
    }
  }

  // give up this life and come back with the loadout picked in the menu
  redeploy() { if (this.inRoom && this.me.alive && this.phase === 'play') this.net?.send({ t: 'redeploy' }); }

  setClass(id) {
    this.nextCls = id; this.settings.cls = id;
    this.hud.setDeathClass(id);
    this.onRoster?.();
  }

  // ---- room lifecycle -----------------------------------------------------------------
  attach(net) {
    this.net = net;
    net.on('s', (m) => this.onSnapshot(m));
    net.on('join', (m) => { this.roster.set(m.p.id, m.p); this.ensureRemote(m.p.id); this.hud.feedNote(`${m.p.n} joined`); this.onRoster?.(); });
    net.on('leave', (m) => {
      const p = this.roster.get(m.id);
      if (p) this.hud.feedNote(`${p.n} left`);
      this.roster.delete(m.id); this.dropRemote(m.id); this.hostId = m.host; this.onRoster?.();
    });
    net.on('spawn', (m) => this.onSpawn(m));
    net.on('fire', (m) => this.onRemoteFire(m));
    net.on('dmg', (m) => this.onDamage(m));
    net.on('kill', (m) => this.onKill(m));
    net.on('proj', (m) => this.onRemoteProjectile(m));
    net.on('ex', (m) => this.onRemoteExplosion(m));
    net.on('pk', (m) => this.onPickup(m));
    net.on('pkr', (m) => { this.pickState[m.i] = 1; });
    net.on('chat', (m) => { const p = this.roster.get(m.id); if (p) { this.hud.chat(p.n, this.cssOf(p), m.m); this.sound.play('chat'); } });
    net.on('round', (m) => { this.setupRound(m); this.sound.play('round'); this.hud.toast('New round', `${MAPS[m.map].name} · ${MODES[m.mode].name}`); });
    net.on('end', (m) => this.onRoundEnd(m));
  }

  enterRoom(welcome) {
    this.inRoom = true;
    this.me.id = welcome.id; this.code = welcome.code;
    this.preview.group.visible = false; this.previewShadow.visible = false;
    this.camera.clearViewOffset();
    this.setupRound(welcome);
    this.hud.setInGame(true);
  }

  leaveRoom() {
    this.inRoom = false;
    this.net?.close(); this.net = null;
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    this.roster.clear(); this.clearProjectiles();
    this.me.alive = false; this.clearInput();
    if (this.mapIdx !== -1) this.loadMap(-1);
    this.preview.group.visible = true; this.previewShadow.visible = true;
    this.viewDirty = true;
    this.hud.setInGame(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setupRound(info) {
    this.mode = info.mode; this.hostId = info.host; this.dur = info.dur; this.rotate = info.rotate;
    if (this.mapIdx !== info.map) this.loadMap(info.map);
    this.phase = info.phase; this.phaseEndAt = performance.now() + info.left;
    this.roster.clear();
    for (const p of info.players) this.roster.set(p.id, p);
    for (const id of [...this.remotes.keys()]) if (!this.roster.has(id)) this.dropRemote(id);
    for (const p of info.players) {
      if (p.id === this.me.id) continue;
      const r = this.ensureRemote(p.id);
      r.alive = !!p.a; r.buf.length = 0; r.bot.group.visible = false; r.shadow.visible = false;
      this.styleRemote(r);
    }
    this.pickState = info.pickups.slice();
    this.clearProjectiles();
    this.me.alive = false; this.me.respawnAt = 0; this.me.spawnAskAt = 0;
    this.deathAng = Math.random() * 6;
    this.me.deathPos.set(this.world.w / 2, 1, this.world.d / 2);
    this.hud.showEnd(null); this.hud.showDeath(null);
    this.onRoster?.();
  }

  ensureRemote(id) {
    let r = this.remotes.get(id);
    if (r) return r;
    const bot = new Bot();
    bot.group.visible = false;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.visible = false;
    this.scene.add(bot.group, shadow);
    r = { id, bot, shadow, buf: [], pos: new THREE.Vector3(), yaw: 0, pitch: 0, slot: 0, fl: 0, alive: false, speed: 0 };
    this.remotes.set(id, r);
    this.styleRemote(r);
    return r;
  }

  dropRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.bot.group, r.shadow);
    r.bot.tag.material.map?.dispose();
    this.remotes.delete(id);
  }

  styleRemote(r) {
    const p = this.roster.get(r.id);
    if (!p) return;
    r.bot.setColor(this.mode === 'tdm' ? TEAM_COLORS[p.tm] : COLORS[p.c]);
    r.bot.setName(p.n, this.mode === 'tdm' ? css(TEAM_COLORS[p.tm]) : '#ffffff');
    r.bot.setWeapon(r.slot ? 'sidearm' : p.cls);
  }

  cssOf(p) { return css(this.mode === 'tdm' ? TEAM_COLORS[p.tm] : COLORS[p.c]); }
  isMate(id) {
    if (this.mode !== 'tdm') return false;
    const a = this.roster.get(id), b = this.roster.get(this.me.id);
    return !!a && !!b && a.tm === b.tm;
  }
  teamScore(tm) { let s = 0; for (const p of this.roster.values()) if (p.tm === tm) s += p.k; return s; }

  scoreData() {
    const rows = [...this.roster.values()].map((p) => ({
      id: p.id, n: p.n, css: this.cssOf(p), cls: CLASSES.find((c) => c.id === p.cls)?.title ?? '', k: p.k, d: p.d, tm: p.tm,
      me: p.id === this.me.id, host: p.id === this.hostId,
    })).sort((a, b) => b.k - a.k || a.d - b.d || a.id - b.id);
    return {
      mode: this.mode, modeName: MODES[this.mode].name, mapName: MAPS[this.mapIdx].name, code: this.code, rows,
      teams: this.mode === 'tdm' ? [0, 1].map((tm) => ({ name: TEAM_NAMES[tm], css: css(TEAM_COLORS[tm]), score: this.teamScore(tm) })) : null,
      limit: MODES[this.mode].limit,
    };
  }

  // ---- server messages ----------------------------------------------------------------
  onSnapshot(m) {
    const now = performance.now();
    for (const e of m.p) {
      const p = this.roster.get(e[0]);
      if (p) p.hp = e[8];
      if (e[0] === this.me.id) { if (this.me.alive) { this.me.hp = e[8]; this.me.shield = !!(e[7] & 2); } continue; }
      const r = this.remotes.get(e[0]);
      if (!r || !r.alive) continue;
      r.buf.push({ t: now, x: e[1], y: e[2], z: e[3], yaw: e[4], pitch: e[5] });
      if (r.buf.length > 12) r.buf.shift();
      if (r.slot !== e[6]) { r.slot = e[6]; this.styleRemote(r); }
      r.fl = e[7];
    }
  }

  onSpawn(m) {
    const p = this.roster.get(m.id);
    if (p) { p.a = 1; p.cls = m.cls; p.hp = MAX_HP; }
    if (m.id === this.me.id) { this.spawnMe(m.p, m.yaw, m.cls); return; }
    const r = this.remotes.get(m.id);
    if (!r) return;
    r.alive = true; r.slot = 0; r.fl = 2; r.speed = 0;
    r.buf.length = 0;
    r.buf.push({ t: performance.now() - 200, x: m.p[0], y: m.p[1], z: m.p[2], yaw: m.yaw, pitch: 0 });
    this.styleRemote(r);
    va.set(m.p[0], m.p[1] + 0.8, m.p[2]);
    this.fx.burst(va, 14, 0xb8ff6a, 3, 0, 1, 0, 0.5);
    this.sound.at('spawn', va, this.listener(), 0.5, 30);
  }

  onRemoteFire(m) {
    const r = this.remotes.get(m.id);
    if (!r || !Array.isArray(m.e) || !WEAPONS[m.w]) return;
    const from = r.alive && r.bot.group.visible ? r.bot.muzzleWorld(va) : va.set(m.o[0], m.o[1], m.o[2]);
    this.fx.flash(from, 0.6);
    for (const e of m.e.slice(0, 12)) {
      vb.set(e[0], e[1], e[2]);
      this.fx.tracer(from, vb);
      this.fx.burst(vb, 3, 0xffd9a0, 3, 0, 0, 0, 0.2);
    }
    this.sound.at(m.w, from, this.listener(), 0.8);
  }

  onDamage(m) {
    const me = this.me;
    const victim = this.roster.get(m.to);
    if (victim) victim.hp = m.hp;
    if (m.to === me.id) {
      me.hp = m.hp;
      this.sound.play('hurt', 0.9);
      let angle = null;
      const a = this.remotes.get(m.by);
      if (a && m.by !== me.id) {
        const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
        const f = dx * -Math.sin(me.yaw) + dz * -Math.cos(me.yaw), s = dx * Math.cos(me.yaw) - dz * Math.sin(me.yaw);
        angle = Math.atan2(s, f);
      }
      this.hud.hurt(angle);
      this.shake = Math.max(this.shake, 0.05);
      return;
    }
    const r = this.remotes.get(m.to);
    if (!r) return;
    va.copy(r.pos); va.y += m.h ? 1.3 : 0.85;
    this.fx.burst(va, 9, 0x9be38a, 4, 0, 0.3, 0, 0.35);
    if (m.by === me.id) {
      this.sound.play(m.h ? 'head' : 'hit', 0.8);
      this.hud.hitmarker(!!m.h, m.hp <= 0);
      va.y += 0.35;
      va.project(this.camera);
      if (va.z < 1) this.hud.damageNumber((va.x * 0.5 + 0.5) * window.innerWidth, (-va.y * 0.5 + 0.5) * window.innerHeight, m.d, !!m.h);
    }
  }

  onKill(m) {
    const me = this.me;
    const killer = this.roster.get(m.k), victim = this.roster.get(m.v);
    if (killer) killer.k = m.kk;
    if (victim) { victim.d = m.vd; victim.a = 0; victim.hp = 0; }
    const wname = WEAPONS[m.w]?.name ?? '';
    const redeploy = m.w === 'redeploy';
    if (redeploy && victim) this.hud.feedNote(`${victim.n} redeployed`);
    else if (killer && victim) {
      this.hud.feedKill(m.k === m.v ? null : killer.n, this.cssOf(killer), victim.n, this.cssOf(victim), wname, !!m.h, m.k === me.id || m.v === me.id);
    }
    if (m.v === me.id) {
      me.alive = false; me.respawnAt = performance.now() + RESPAWN_MS; me.spawnAskAt = 0;
      me.deathPos.copy(me.pos); this.clearInput();
      this.fx.shards(me.pos, this.vmTint.color.getHex(), 22);
      va.copy(me.pos); va.y += 0.8; this.fx.burst(va, 26, 0x9be38a, 6, 0, 0.5, 0, 0.6);
      this.sound.play('die');
      this.hud.showDeath({ killer: m.k === m.v ? null : killer?.n, css: killer ? this.cssOf(killer) : '#fff', weapon: wname, head: !!m.h, cls: this.nextCls, redeploy });
    } else {
      const r = this.remotes.get(m.v);
      if (r) {
        r.alive = false; r.bot.group.visible = false; r.shadow.visible = false;
        const p = this.roster.get(m.v);
        this.fx.shards(r.pos, p ? (this.mode === 'tdm' ? TEAM_COLORS[p.tm] : COLORS[p.c]) : 0xffffff, 18);
        va.copy(r.pos); va.y += 0.8;
        this.fx.burst(va, 26, 0x9be38a, 6, 0, 0.5, 0, 0.6);
        this.sound.at('die', va, this.listener(), 0.8, 45);
      }
      if (m.k === me.id) {
        this.sound.play('kill');
        const streak = m.st >= 3 && (m.st % 2 === 1 || m.st >= 8);
        if (streak) this.sound.play('streak');
        this.hud.toast(`Pickled ${victim?.n ?? ''}`, streak ? `${m.st} in a row` : m.h ? 'Headshot' : '');
      }
    }
    this.onRoster?.();
  }

  onPickup(m) {
    this.pickState[m.i] = 0;
    const def = MAPS[this.mapIdx].pickups[m.i];
    const p = this.roster.get(m.by);
    if (p) p.hp = m.hp;
    if (!def) return;
    va.set(def.x, def.y + 0.6, def.z);
    this.fx.burst(va, 10, def.t === 'hp' ? 0x4fe07a : 0xffc04a, 3, 0, 1, 0, 0.4);
    if (m.by !== this.me.id) return;
    this.sound.play('pickup');
    if (def.t === 'hp') { this.me.hp = m.hp; this.hud.toast('', 'Fresh brine +50'); }
    else {
      for (const w of this.me.weapons) w.reserve = w.def.reserve;
      this.me.grenades = Math.min(MAX_GRENADES, this.me.grenades + 1);
      this.hud.toast('', 'Ammo restocked');
    }
  }

  onRoundEnd(m) {
    this.phase = 'end'; this.phaseEndAt = performance.now() + m.left;
    for (const p of m.players) this.roster.set(p.id, p);
    this.me.alive = false; this.clearInput(); this.clearProjectiles();
    for (const r of this.remotes.values()) { r.alive = false; r.bot.group.visible = false; r.shadow.visible = false; }
    this.me.deathPos.set(this.world.w / 2, 1, this.world.d / 2);
    this.hud.showDeath(null);
    const data = this.scoreData();
    data.next = MAPS[m.next].name;
    this.hud.showEnd(data);
    this.sound.play('round');
  }

  // ---- local player -------------------------------------------------------------------
  mkWeapon(id) {
    const def = WEAPONS[id];
    return { id, def, ammo: def.mag, reserve: def.reserve, nextFire: 0, reloadEnd: 0, reloadStart: 0 };
  }
  curWeapon() { return this.me.weapons[this.me.cur]; }
  listener() { const m = this.me; return { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: m.yaw }; }

  spawnMe(p, yaw, cls) {
    const me = this.me;
    me.alive = true; me.pos.set(p[0], p[1], p[2]); me.vel.set(0, 0, 0);
    me.yaw = yaw; me.pitch = 0; me.recoil = 0; me.recoilYaw = 0; me.burst = 0; me.hp = MAX_HP; me.cls = cls; me.shield = true;
    me.weapons = [this.mkWeapon(cls), this.mkWeapon('sidearm')]; me.cur = 0; me.grenades = 1;
    me.bloom = 0; me.scopeT = 0; me.stepOff = 0; me.swapEnd = 0; me.onGround = false;
    this.lastSent = '';
    const mine = this.roster.get(me.id);
    this.vmTint.color.setHex(this.mode === 'tdm' && mine ? TEAM_COLORS[mine.tm] : COLORS[this.settings.color]);
    this.setViewModel(cls);
    this.hud.showDeath(null);
    this.sound.play('spawn', 0.6);
  }

  setViewModel(id) {
    if (this.vmGun) this.vm.remove(this.vmGun);
    this.vmGun = makeGun(id, this.vmTint);
    this.vmGun.add(this.vmFlash);
    this.vmFlash.position.copy(this.vmGun.userData.muzzle);
    this.vm.add(this.vmGun);
  }

  switchTo(slot) {
    const me = this.me, now = performance.now();
    if (!me.alive || slot === me.cur || !me.weapons[slot]) return;
    this.curWeapon().reloadEnd = 0;
    me.cur = slot; me.swapEnd = now + 280; me.scopeT = 0; me.bloom = 0;
    this.setViewModel(me.weapons[slot].id);
    this.sound.play('swap');
  }

  reload() {
    const w = this.curWeapon(), now = performance.now();
    if (!this.me.alive || !w || w.reloadEnd || w.ammo >= w.def.mag || w.reserve <= 0) return;
    w.reloadStart = now; w.reloadEnd = now + w.def.reload;
    this.sound.play('reload');
  }

  aim() {
    const me = this.me, p = me.pitch + me.recoil, yaw = me.yaw + me.recoilYaw, cp = Math.cos(p);
    fwd.set(-Math.sin(yaw) * cp, Math.sin(p), -Math.cos(yaw) * cp);
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    up.crossVectors(right, fwd);
  }

  spread() {
    const me = this.me, w = this.curWeapon(), d = w.def;
    const moving = Math.hypot(me.vel.x, me.vel.z) / PLAYER.speed;
    if (d.pellets > 1) return d.spread;
    if (d.scope && me.scopeT > 0.9) return d.scopedSpread + moving * 0.012 + (me.onGround ? 0 : 0.03);
    let s = (d.spread + me.bloom) * (1 + moving * AIM.movePenalty);
    if (!me.onGround) s *= AIM.airPenalty;
    return s * lerp(1, AIM.aimBonus, me.scopeT);
  }

  // closest thing along a ray: world or an enemy bot
  castShot(o, d) {
    const rc = this.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 240);
    let best = rc.t, target = null;
    for (const r of this.remotes.values()) {
      if (!r.alive || !r.bot.group.visible || this.isMate(r.id)) continue;
      const t = rayBox(o, d, r.pos.x - HALF, r.pos.y, r.pos.z - HALF, r.pos.x + HALF, r.pos.y + PLAYER.height, r.pos.z + HALF, best);
      if (t >= 0 && t < best) { best = t; target = r; }
    }
    const end = new THREE.Vector3().copy(o).addScaledVector(d, best);
    return { end, target, head: !!target && end.y > target.pos.y + 1.06, dist: best, wall: !target && rc.hit, rc };
  }

  tryFire(now) {
    const me = this.me, w = this.curWeapon(), d = w.def;
    if (w.reloadEnd || now < w.nextFire) return false;
    if (w.ammo <= 0) {
      if (w.reserve > 0) this.reload();
      else if (now > this.emptyAt) { this.sound.play('empty'); this.emptyAt = now + 300; }
      return false;
    }
    w.ammo--; w.nextFire = now + d.rate;
    this.aim();
    const origin = va.set(me.pos.x, me.pos.y + PLAYER.eye, me.pos.z).clone();
    const muzzle = origin.clone().addScaledVector(fwd, 0.7).addScaledVector(right, 0.2).addScaledVector(up, -0.16);
    const sp = this.spread();
    this.sound.play(w.id, 0.9);
    this.vmKick = 1; this.vmFlashUntil = now + 55; this.vmFlash.material.rotation = Math.random() * 6.28;

    if (d.kind === 'rocket') {
      const dir = fwd.clone();
      const near = this.world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 0.9);
      const start = origin.clone().addScaledVector(dir, near.hit ? Math.max(0, near.t - 0.1) : 0.7);
      const pid = ++this.pidSeq;
      const vel = dir.multiplyScalar(d.speed);
      this.addProjectile({ kind: w.id, mine: true, owner: me.id, pid, pos: start, vel });
      this.net?.send({ t: 'proj', k: w.id, pid, o: [r2(start.x), r2(start.y), r2(start.z)], v: [r2(vel.x), r2(vel.y), r2(vel.z)] });
    } else {
      const ends = [], hits = new Map();
      for (let i = 0; i < d.pellets; i++) {
        const ang = Math.random() * Math.PI * 2, rad = sp * Math.sqrt(Math.random());
        const dir = vb.copy(fwd).addScaledVector(right, Math.cos(ang) * rad).addScaledVector(up, Math.sin(ang) * rad).normalize();
        const res = this.castShot(origin, dir);
        ends.push([r2(res.end.x), r2(res.end.y), r2(res.end.z)]);
        this.fx.tracer(muzzle, res.end);
        if (res.target) {
          const [full, minAt, minScale] = d.falloff;
          const scale = lerp(1, minScale, clamp((res.dist - full) / (minAt - full), 0, 1));
          const h = hits.get(res.target.id) ?? { d: 0, h: 0 };
          h.d += d.dmg * scale * (res.head ? d.head : 1); h.h = h.h || (res.head ? 1 : 0);
          hits.set(res.target.id, h);
        } else if (res.wall) {
          this.fx.burst(res.end, 5, 0xffd9a0, 4, res.rc.nx, res.rc.ny, res.rc.nz, 0.25);
          if (i === 0) this.sound.at('impact', res.end, this.listener(), 0.7, 30);
        }
      }
      this.net?.send({ t: 'fire', w: w.id, o: [r2(muzzle.x), r2(muzzle.y), r2(muzzle.z)], e: ends });
      for (const [to, h] of hits) this.net?.send({ t: 'hit', to, d: Math.max(1, Math.round(h.d)), w: w.id, h: h.h });
    }
    // recoil: mostly a steady climb, plus a sideways sway that follows the same S-curve every burst
    if (now - me.lastShot > 320) me.burst = 0;
    me.lastShot = now; me.burst++;
    me.recoil = Math.min(d.kick * AIM.kickCap, me.recoil + d.kick * (0.88 + Math.random() * 0.24));
    me.recoilYaw += d.kick * (d.side ?? 0.2) * (Math.sin(me.burst * 0.75) + (Math.random() - 0.5) * 0.3);
    me.bloom = Math.min(d.maxBloom, me.bloom + d.bloom);
    return true;
  }

  throwGrenade() {
    const me = this.me, now = performance.now(), d = WEAPONS.fizz;
    if (!me.alive || me.grenades <= 0 || now < me.nadeAt) return;
    me.grenades--; me.nadeAt = now + 700;
    this.aim();
    const start = new THREE.Vector3(me.pos.x, me.pos.y + PLAYER.eye - 0.1, me.pos.z).addScaledVector(fwd, 0.35);
    if (this.world.pointSolid(start.x, start.y, start.z)) start.set(me.pos.x, me.pos.y + PLAYER.eye - 0.1, me.pos.z);
    const vel = fwd.clone().multiplyScalar(d.speed); vel.y += 3.4; vel.addScaledVector(me.vel, 0.4);
    const pid = ++this.pidSeq;
    this.addProjectile({ kind: 'fizz', mine: true, owner: me.id, pid, pos: start, vel });
    this.net?.send({ t: 'proj', k: 'fizz', pid, o: [r2(start.x), r2(start.y), r2(start.z)], v: [r2(vel.x), r2(vel.y), r2(vel.z)] });
    this.sound.play('fizz');
  }

  updateMe(dt, now) {
    const me = this.me, k = this.keys, act = this.active();
    let f = 0, s = 0;
    if (act) {
      f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
      s = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    }
    const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
    let wx = -sin * f + cos * s, wz = -cos * f - sin * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const w = this.curWeapon();
    const speed = PLAYER.speed * (me.scopeT > 0.5 ? (w.def.scope ? 0.45 : 0.75) : 1);
    const a = 1 - Math.exp(-(me.onGround ? 14 : 2.2) * dt);
    me.vel.x += (wx * speed - me.vel.x) * a; me.vel.z += (wz * speed - me.vel.z) * a;
    if (act && k.Space && me.onGround) { me.vel.y = PLAYER.jump; me.onGround = false; this.sound.play('jump'); }
    me.vel.y = Math.max(-40, me.vel.y - PLAYER.gravity * dt);
    this.moveMe(dt);

    const flat = Math.hypot(me.vel.x, me.vel.z);
    if (me.onGround && flat > 1) {
      me.bobPhase += flat * dt * 1.5; me.stepDist += flat * dt;
      if (me.stepDist > 2.4) { me.stepDist = 0; this.sound.play('step', 0.5); }
    }
    me.stepOff *= Math.exp(-14 * dt);
    if (now - me.lastShot > AIM.settleDelay) {
      const fade = Math.exp(-AIM.recoilFade * dt);
      me.recoil *= fade; me.recoilYaw *= fade;
      me.bloom *= Math.exp(-AIM.bloomFade * dt);
    }

    // weapon handling
    if (w.reloadEnd && now >= w.reloadEnd) {
      const take = Math.min(w.def.mag - w.ammo, w.reserve);
      w.ammo += take; w.reserve -= take; w.reloadEnd = 0;
      this.sound.play('ready', 0.7);
    }
    const ready = now >= me.swapEnd;
    const wantScope = act && this.mouse2 && !w.reloadEnd && ready;
    me.scopeT += ((wantScope ? 1 : 0) - me.scopeT) * (1 - Math.exp(-16 * dt));
    if (act && ready) {
      if (w.def.auto ? this.mouse0 : (this.clickAt && now - this.clickAt < 160)) {
        if (this.tryFire(now) || !w.def.auto) this.clickAt = 0;
      }
    }
    if (w.ammo === 0 && !w.reloadEnd && w.reserve > 0 && now >= w.nextFire - w.def.rate + 250) this.reload();

    // pickups
    if (now > this.pickAsk) {
      const defs = MAPS[this.mapIdx].pickups;
      for (let i = 0; i < defs.length; i++) {
        if (!this.pickState[i]) continue;
        const d = defs[i];
        if (Math.hypot(d.x - me.pos.x, d.z - me.pos.z) > 0.95 || Math.abs(d.y - me.pos.y) > 1.3) continue;
        if (d.t === 'hp' && me.hp >= MAX_HP) continue;
        if (d.t === 'ammo' && me.grenades >= MAX_GRENADES && me.weapons.every((x) => x.reserve >= x.def.reserve)) continue;
        this.net?.send({ t: 'pk', i }); this.pickAsk = now + 400;
        break;
      }
    }

    // tell the room where we are
    if (now - this.lastSend >= 66) {
      const fl = (me.onGround ? 1 : 0) | (me.scopeT > 0.5 ? 4 : 0);
      const st = [r2(me.pos.x), r2(me.pos.y), r2(me.pos.z), r2(me.yaw), r2(me.pitch + me.recoil), me.cur, fl];
      const key = st.join(',');
      if (key !== this.lastSent || now - this.lastSend > 1000) {
        this.net?.send({ t: 'st', s: st });
        this.lastSent = key; this.lastSend = now;
      }
    }
  }

  moveMe(dt) {
    const me = this.me, w = this.world, r = PLAYER.radius, h = PLAYER.height, p = me.pos;
    const wasGround = me.onGround, fall = me.vel.y;
    let dx = me.vel.x * dt, dy = me.vel.y * dt, dz = me.vel.z * dt;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.15));
    dx /= n; dy /= n; dz /= n;
    me.onGround = false;
    let grounded = wasGround;
    for (let i = 0; i < n; i++) {
      if (dx) {
        p.x += dx;
        if (w.boxHits(p.x, p.y, p.z, r, h)) {
          if (grounded && !w.boxHits(p.x, p.y + CY, p.z, r, h) && !w.boxHits(p.x - dx, p.y + CY, p.z, r, h)) { p.y += CY; me.stepOff += CY; }
          else { p.x -= dx; me.vel.x = 0; dx = 0; }
        }
      }
      if (dz) {
        p.z += dz;
        if (w.boxHits(p.x, p.y, p.z, r, h)) {
          if (grounded && !w.boxHits(p.x, p.y + CY, p.z, r, h) && !w.boxHits(p.x, p.y + CY, p.z - dz, r, h)) { p.y += CY; me.stepOff += CY; }
          else { p.z -= dz; me.vel.z = 0; dz = 0; }
        }
      }
      if (dy) {
        p.y += dy;
        if (w.boxHits(p.x, p.y, p.z, r, h)) {
          if (dy < 0) { p.y = (Math.floor(p.y / CY) + 1) * CY; me.onGround = true; grounded = true; }
          else p.y -= dy;
          me.vel.y = 0; dy = 0;
        } else if (dy < 0) grounded = false;
      }
    }
    if (!wasGround && me.onGround && fall < -8) { this.sound.play('land'); me.stepOff -= Math.min(0.12, -fall * 0.008); }
  }

  // ---- projectiles --------------------------------------------------------------------
  addProjectile(p) {
    p.mesh = p.kind === 'fizz' ? makeGrenadeMesh() : makeRocketMesh();
    p.mesh.position.copy(p.pos);
    p.born = performance.now(); p.speed = p.vel.length();
    p.dir = p.vel.clone().normalize();
    if (p.kind !== 'fizz') p.mesh.quaternion.setFromUnitVectors(va.set(0, 0, -1), p.dir);
    this.scene.add(p.mesh);
    this.projectiles.push(p);
  }

  clearProjectiles() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.projectiles.length = 0;
  }

  onRemoteProjectile(m) {
    if (!WEAPONS[m.k] || WEAPONS[m.k].kind === 'hitscan' || !Array.isArray(m.o) || !Array.isArray(m.v)) return;
    const pos = new THREE.Vector3(m.o[0], m.o[1], m.o[2]);
    this.addProjectile({ kind: m.k, mine: false, owner: m.id, pid: m.pid, pos, vel: new THREE.Vector3(m.v[0], m.v[1], m.v[2]) });
    this.sound.at(m.k, pos, this.listener(), 0.8);
  }

  onRemoteExplosion(m) {
    const def = WEAPONS[m.k];
    if (!def || !def.radius || !Array.isArray(m.p)) return;
    const i = this.projectiles.findIndex((p) => p.owner === m.id && p.pid === m.pid);
    if (i >= 0) { this.scene.remove(this.projectiles[i].mesh); this.projectiles.splice(i, 1); }
    this.boom(new THREE.Vector3(m.p[0], m.p[1], m.p[2]), def.radius, m.k);
  }

  boom(e, radius, kind) {
    const me = this.me;
    this.fx.explosion(e, radius);
    this.sound.at(kind === 'fizz' ? 'splash' : 'boom', e, this.listener(), 1, 75);
    const dist = Math.hypot(e.x - this.camera.position.x, e.y - this.camera.position.y, e.z - this.camera.position.z);
    this.shake = Math.max(this.shake, clamp(1 - dist / 18, 0, 1) * 0.22);
    if (!me.alive) return;
    vc.set(me.pos.x - e.x, me.pos.y + 0.75 - e.y, me.pos.z - e.z);
    const d = vc.length();
    if (d < radius) {
      const k = 1 - d / radius;
      vc.divideScalar(Math.max(d, 0.001)); vc.y += 0.35;
      me.vel.addScaledVector(vc, k * 13);
      me.onGround = false;
    }
  }

  explodeMine(p) {
    const def = WEAPONS[p.kind], e = p.pos;
    this.boom(e, def.radius, p.kind);
    this.net?.send({ t: 'ex', k: p.kind, pid: p.pid, p: [r2(e.x), r2(e.y), r2(e.z)] });
    const splash = (id, c, self) => {
      if (p.directId === id && def.direct) { this.net?.send({ t: 'hit', to: id, d: def.direct, w: p.kind }); return; }   // struck by the jar itself
      vc.subVectors(c, e);
      const dist = vc.length();
      if (dist > def.radius) return;
      if (dist > 0.5) {
        vc.divideScalar(dist);
        const rc = this.world.raycast(e.x, e.y, e.z, vc.x, vc.y, vc.z, dist);
        if (rc.hit && rc.t < dist - 0.45) return;       // behind cover
      }
      let dmg = def.dmg * Math.max(0, 1 - Math.pow(dist / def.radius, 1.4));
      if (self) dmg *= def.selfScale;
      if (dmg >= 1) this.net?.send({ t: 'hit', to: id, d: Math.round(dmg), w: p.kind });
    };
    for (const r of this.remotes.values()) {
      if (!r.alive || this.isMate(r.id)) continue;
      splash(r.id, va.set(r.pos.x, r.pos.y + 0.75, r.pos.z), false);
    }
    if (this.me.alive) splash(this.me.id, va.set(this.me.pos.x, this.me.pos.y + 0.75, this.me.pos.z), true);
  }

  updateProjectiles(dt, now) {
    const w = this.world;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      let done = false;
      if (p.kind === 'fizz') {
        p.vel.y -= 18 * dt;
        const nx = p.pos.x + p.vel.x * dt, ny = p.pos.y + p.vel.y * dt, nz = p.pos.z + p.vel.z * dt;
        let bounced = false;
        if (w.pointSolid(nx, p.pos.y, p.pos.z)) { p.vel.x *= -0.45; bounced = true; } else p.pos.x = nx;
        if (w.pointSolid(p.pos.x, p.pos.y, nz)) { p.vel.z *= -0.45; bounced = true; } else p.pos.z = nz;
        if (w.pointSolid(p.pos.x, ny - 0.1, p.pos.z) || w.pointSolid(p.pos.x, ny + 0.1, p.pos.z)) {
          if (Math.abs(p.vel.y) > 2.5) bounced = true;
          p.vel.y *= -0.4; p.vel.x *= 0.72; p.vel.z *= 0.72;
          if (Math.abs(p.vel.y) < 0.8) p.vel.y = 0;
        } else p.pos.y = ny;
        if (bounced && p.speed > 0) this.sound.at('bounce', p.pos, this.listener(), 0.9, 28);
        p.mesh.rotation.x += dt * 9; p.mesh.rotation.z += dt * 6;
        if (Math.random() < dt * 30) this.fx.trail(p.pos, 0xffa64d);
        const age = now - p.born;
        if (p.mine && age >= WEAPONS.fizz.fuse) { this.explodeMine(p); done = true; }
        else if (!p.mine && age > WEAPONS.fizz.fuse + 1500) done = true;
      } else {
        const step = p.speed * dt;
        if (p.mine) {
          const rc = w.raycast(p.pos.x, p.pos.y, p.pos.z, p.dir.x, p.dir.y, p.dir.z, step);
          let t = rc.t, hit = rc.hit || rc.t < step - 1e-4;
          for (const r of this.remotes.values()) {
            if (!r.alive || !r.bot.group.visible || this.isMate(r.id)) continue;
            const tb = rayBox(p.pos, p.dir, r.pos.x - HALF - 0.1, r.pos.y - 0.05, r.pos.z - HALF - 0.1, r.pos.x + HALF + 0.1, r.pos.y + PLAYER.height + 0.1, r.pos.z + HALF + 0.1, t);
            if (tb >= 0 && tb <= t) { t = tb; hit = true; p.directId = r.id; }
          }
          if (hit || now - p.born > 4000) { p.pos.addScaledVector(p.dir, Math.max(0, t - 0.08)); this.explodeMine(p); done = true; }
          else p.pos.addScaledVector(p.dir, step);
        } else {
          p.pos.addScaledVector(p.dir, step);
          if (w.pointSolid(p.pos.x, p.pos.y, p.pos.z)) p.mesh.visible = false;
          if (now - p.born > 5000) done = true;
        }
        if (!done) { this.fx.trail(p.pos, 0x9be38a); this.fx.trail(p.pos, 0xeaffc0); p.mesh.rotateZ(dt * 9); }
      }
      if (done) { this.scene.remove(p.mesh); this.projectiles.splice(i, 1); }
      else p.mesh.position.copy(p.pos);
    }
  }

  // ---- remote players -----------------------------------------------------------------
  updateRemotes(dt, now) {
    const rt = now - 115;
    for (const r of this.remotes.values()) {
      if (!r.alive) continue;
      const b = r.buf;
      if (!b.length) continue;
      while (b.length > 2 && b[1].t <= rt) b.shift();
      let x, y, z, yaw, pitch;
      if (b.length === 1 || rt <= b[0].t) ({ x, y, z, yaw, pitch } = b[0]);
      else {
        const a = b[0], c = b[1], k = clamp((rt - a.t) / Math.max(1, c.t - a.t), 0, 1);
        let dy = c.yaw - a.yaw;
        dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        x = lerp(a.x, c.x, k); y = lerp(a.y, c.y, k); z = lerp(a.z, c.z, k); yaw = a.yaw + dy * k; pitch = lerp(a.pitch, c.pitch, k);
      }
      const moved = Math.hypot(x - r.pos.x, z - r.pos.z) / Math.max(dt, 0.001);
      r.speed = r.bot.group.visible ? lerp(r.speed, Math.min(moved, 12), 0.25) : 0;
      r.pos.set(x, y, z); r.yaw = yaw; r.pitch = pitch;
      r.bot.group.position.copy(r.pos);
      r.bot.group.rotation.y = yaw;
      r.bot.group.visible = true;
      r.bot.animate(dt, r.speed, pitch, r.fl & 1);
      r.bot.shield.visible = !!(r.fl & 2);
      const gy = this.world.groundY(x, y + 0.2, z);
      r.shadow.visible = true;
      r.shadow.position.set(x, gy + 0.025, z);
      r.shadow.material.opacity = clamp(1 - (y - gy) / 4, 0.15, 1);
    }
  }

  // ---- frame --------------------------------------------------------------------------
  frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const me = this.me, cam = this.camera;

    if (!this.inRoom) {
      // lobby: the fighter walks down an endless alley toward a camera that backs away
      this.menuT += dt;
      this.lobbyZ -= 2.2 * dt;
      if (this.lobbyZ < 24) this.lobbyZ += LOBBY_PERIOD;
      const x = 5.5, z = this.lobbyZ, pv = this.preview;
      pv.group.position.set(x, 0.5, z);
      pv.group.rotation.y = 0.16 + Math.sin(this.menuT * 0.5) * 0.05;
      pv.animate(dt, 3.3, 0, true);
      // patrol carry: weapon held across the body instead of pointing at the camera
      pv.gunPivot.position.set(0.1, 0.66 + pv.body.position.y, -0.34);
      pv.gunPivot.rotation.set(0.12 + Math.sin(this.menuT * 4.6) * 0.02, 1.05, 0.3);
      this.previewShadow.position.set(x, 0.53, z);
      const narrow = window.innerWidth < 720;
      cam.position.set(x + Math.sin(this.menuT * 0.3) * 0.3, 1.2 + Math.sin(this.menuT * 4.4) * 0.012, z - (narrow ? 6.2 : 4.7));
      cam.lookAt(x, narrow ? 0.55 : 0.98, z);
      this.setFov(38);
      if (this.viewDirty) { this.viewDirty = false; cam.clearViewOffset(); }
      if (Math.random() < dt * 16) {                 // drifting embers
        this.fx.spark(x + (Math.random() - 0.5) * 7, 0.6 + Math.random() * 2.6, z - 3 + Math.random() * 14,
          (Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3, 2.4 + Math.random() * 1.5, 1, 0.5, 0.16, -0.12);
      }
    } else {
      if (me.alive && this.phase === 'play') this.updateMe(dt, now);
      else if (this.phase === 'play' && now >= me.respawnAt && now >= me.spawnAskAt) {
        this.net?.send({ t: 'spawn', cls: this.nextCls });
        me.spawnAskAt = now + 600;
      }
      this.updateRemotes(dt, now);
      this.updateProjectiles(dt, now);

      if (me.alive) {
        const w = this.curWeapon();
        this.zoomNow = lerp(1, w.def.zoom, me.scopeT);
        const bob = me.onGround ? Math.sin(me.bobPhase * 2) * 0.022 * Math.min(1, Math.hypot(me.vel.x, me.vel.z) / PLAYER.speed) : 0;
        cam.position.set(me.pos.x, me.pos.y + PLAYER.eye - me.stepOff + bob, me.pos.z);
        cam.rotation.set(me.pitch + me.recoil, me.yaw + me.recoilYaw, 0);
        this.setFov((2 * Math.atan(Math.tan((this.settings.fov * Math.PI) / 360) / this.zoomNow) * 180) / Math.PI);
        this.updateViewModel(dt, now, w);
      } else {
        // orbit the spot where we fell (or the map centre between rounds)
        this.zoomNow = 1;
        this.deathAng += dt * (this.phase === 'end' ? 0.15 : 0.35);
        const wide = this.phase === 'end' || me.respawnAt === 0;
        const far = wide ? Math.max(this.world.w, this.world.d) * 0.62 : 4.2;
        const t = vb.copy(me.deathPos); t.y += wide ? 1 : 0.9;
        vc.set(Math.cos(this.deathAng), wide ? 0.8 : 0.55, Math.sin(this.deathAng)).normalize();
        let dist = far;
        if (!wide) { const rc = this.world.raycast(t.x, t.y, t.z, vc.x, vc.y, vc.z, far); if (rc.hit) dist = Math.max(0.6, rc.t - 0.3); }
        cam.position.copy(t).addScaledVector(vc, dist);
        cam.lookAt(t);
        this.setFov(this.settings.fov);
      }
      if (this.shake > 0.001) {
        cam.position.x += (Math.random() - 0.5) * this.shake; cam.position.y += (Math.random() - 0.5) * this.shake;
        this.shake *= Math.exp(-9 * dt);
      }
      this.updateHud(now);
    }

    // pickups spin and bob
    for (let i = 0; i < this.pickMeshes.length; i++) {
      const pm = this.pickMeshes[i], on = !!this.pickState[i];
      pm.g.visible = on; pm.ring.material.opacity = on ? 0.55 : 0.12;
      if (on) { pm.g.rotation.y += dt * 1.6; pm.g.position.y = pm.baseY + Math.sin(now / 420 + i) * 0.08; }
    }

    this.fx.update(dt);
    this.sky.position.copy(cam.position);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    if (this.inRoom && me.alive && this.vm.visible) {
      this.renderer.clearDepth();
      this.renderer.render(this.vmScene, this.vmCamera);
    }
  }

  setFov(f) {
    if (Math.abs(this.camera.fov - f) < 0.01) return;
    this.camera.fov = f; this.camera.updateProjectionMatrix();
  }

  updateViewModel(dt, now, w) {
    const me = this.me, vm = this.vm;
    this.vmKick *= Math.exp(-16 * dt);
    const moveK = me.onGround ? Math.min(1, Math.hypot(me.vel.x, me.vel.z) / PLAYER.speed) : 0;
    let x = 0.15 + Math.cos(me.bobPhase) * 0.006 * moveK;
    let y = -0.15 - Math.abs(Math.sin(me.bobPhase)) * 0.008 * moveK - clamp(me.vel.y * 0.003, -0.025, 0.025);
    let z = -0.44 + this.vmKick * 0.05, rx = this.vmKick * 0.1, rz = 0;
    if (w.reloadEnd) {
      const dip = Math.sin(clamp((now - w.reloadStart) / w.def.reload, 0, 1) * Math.PI);
      y -= dip * 0.14; rx -= dip * 0.6; rz = dip * 0.35;
    }
    if (now < me.swapEnd) { const k = (me.swapEnd - now) / 280; y -= k * 0.22; rx -= k * 0.6; }
    const s = me.scopeT;
    x = lerp(x, 0, s); y = lerp(y, -0.085, s); z = lerp(z, -0.3 + this.vmKick * 0.04, s);
    vm.position.set(x, y, z); vm.rotation.set(rx, 0, rz);
    vm.visible = !(w.def.scope && s > 0.8);
    this.vmFlash.visible = now < this.vmFlashUntil;
  }

  updateHud(now) {
    const me = this.me, hud = this.hud;
    const left = Math.max(0, this.phaseEndAt - now);
    hud.setTimer(this.phase === 'play' ? Math.ceil(left / 1000) : 0);
    hud.setPing(this.net ? this.net.ping : 0);
    hud.setAlive(me.alive);
    if (me.alive) {
      const w = this.curWeapon();
      hud.setHealth(me.hp, me.shield);
      hud.setAmmo(w.def.name, w.ammo, w.reserve, w.reloadEnd ? clamp((now - w.reloadStart) / w.def.reload, 0, 1) : -1, me.cur);
      hud.setGrenades(me.grenades);
      const scoped = !!w.def.scope && me.scopeT > 0.8;
      hud.setScope(scoped);
      const px = (this.spread() / Math.tan((this.camera.fov * Math.PI) / 360)) * (window.innerHeight / 2);
      hud.setCrosshair(3 + px, !scoped);
    } else {
      hud.setScope(false);
      if (this.phase === 'play' && me.respawnAt) hud.setDeathCountdown(clamp(1 - (me.respawnAt - now) / RESPAWN_MS, 0, 1));
    }
    if (this.phase === 'end') hud.setEndCountdown(Math.ceil(left / 1000));
    // score strip
    const mine = this.roster.get(me.id);
    if (!mine) return;
    if (this.mode === 'tdm') {
      hud.setTop({
        a: { label: TEAM_NAMES[0], value: this.teamScore(0), css: css(TEAM_COLORS[0]), mine: mine.tm === 0 },
        b: { label: TEAM_NAMES[1], value: this.teamScore(1), css: css(TEAM_COLORS[1]), mine: mine.tm === 1 },
      });
    } else {
      let lead = null, rank = 1;
      for (const p of this.roster.values()) {
        if (p.id !== me.id && (!lead || p.k > lead.k)) lead = p;
        if (p.k > mine.k) rank++;
      }
      hud.setTop({
        a: { label: `You · #${rank}`, value: mine.k, css: css(COLORS[mine.c]), mine: true },
        b: lead ? { label: lead.n, value: lead.k, css: css(COLORS[lead.c]), mine: false } : { label: 'Waiting for rivals', value: '–', css: '#8a94a8', mine: false },
      });
    }
  }
}
