// Pooled visual effects: tracers, sparks, muzzle flashes, explosions and debris.
import * as THREE from 'three';

const N_PART = 700, N_DEBRIS = 180, N_TRACER = 48, N_FLASH = 16, N_BOOM = 6;
const tmpV = new THREE.Vector3(), tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();
const tmpE = new THREE.Euler(), tmpC = new THREE.Color();

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,220,150,0.7)'); grad.addColorStop(1, 'rgba(255,160,60,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.world = null;
    const glow = glowTexture();

    // sparks
    this.pPos = new Float32Array(N_PART * 3).fill(-999);
    this.pCol = new Float32Array(N_PART * 3);
    this.pVel = new Float32Array(N_PART * 3);
    this.pBase = new Float32Array(N_PART * 3);
    this.pLife = new Float32Array(N_PART); this.pMax = new Float32Array(N_PART); this.pGrav = new Float32Array(N_PART);
    this.pNext = 0;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({
      size: 0.16, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);

    // debris
    this.debris = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.5, 0.32, 10), new THREE.MeshLambertMaterial({ color: 0xffffff }), N_DEBRIS);
    this.debris.frustumCulled = false;
    this.dState = [];
    for (let i = 0; i < N_DEBRIS; i++) {
      this.dState.push({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Vector3(), rv: new THREE.Vector3(), s: 0.1 });
      tmpM.makeScale(0, 0, 0); this.debris.setMatrixAt(i, tmpM); this.debris.setColorAt(i, tmpC.setHex(0xffffff));
    }
    this.dNext = 0;
    scene.add(this.debris);

    // tracers
    this.tracers = [];
    const tGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < N_TRACER; i++) {
      const m = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.visible = false; m.frustumCulled = false; scene.add(m);
      this.tracers.push({ m, on: false, a: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0, s: 0 });
    }
    this.tNext = 0;

    // flashes
    this.flashes = [];
    for (let i = 0; i < N_FLASH; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.visible = false; scene.add(s);
      this.flashes.push({ s, life: 0, max: 0.06, size: 1 });
    }
    this.fNext = 0;

    // explosions
    this.booms = [];
    const bGeo = new THREE.SphereGeometry(1, 18, 12);
    for (let i = 0; i < N_BOOM; i++) {
      const m = new THREE.Mesh(bGeo, new THREE.MeshBasicMaterial({ color: 0x9fd94a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.visible = false; scene.add(m);
      this.booms.push({ m, life: 0, r: 1 });
    }
    this.bNext = 0;
    this.lights = [0, 1].map(() => {
      const l = new THREE.PointLight(0xc8f070, 0, 16, 1.6);
      scene.add(l);
      return { l, life: 0 };
    });
    this.lNext = 0;
  }

  spark(x, y, z, vx, vy, vz, life, r, g, b, grav = 9) {
    const i = this.pNext; this.pNext = (i + 1) % N_PART;
    const j = i * 3;
    this.pPos[j] = x; this.pPos[j + 1] = y; this.pPos[j + 2] = z;
    this.pVel[j] = vx; this.pVel[j + 1] = vy; this.pVel[j + 2] = vz;
    this.pBase[j] = r; this.pBase[j + 1] = g; this.pBase[j + 2] = b;
    this.pLife[i] = this.pMax[i] = life; this.pGrav[i] = grav;
  }

  // burst of sparks around a normal (or in all directions when no normal is given)
  burst(pos, n, hex, speed = 5, nx = 0, ny = 0, nz = 0, life = 0.35) {
    tmpC.setHex(hex);
    for (let k = 0; k < n; k++) {
      const vx = (Math.random() - 0.5) * 2 + nx * 1.2, vy = (Math.random() - 0.5) * 2 + ny * 1.2 + 0.3, vz = (Math.random() - 0.5) * 2 + nz * 1.2;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.spark(pos.x, pos.y, pos.z, vx * s, vy * s, vz * s, life * (0.5 + Math.random()), tmpC.r, tmpC.g, tmpC.b);
    }
  }

  trail(pos, hex) {
    tmpC.setHex(hex);
    this.spark(pos.x + (Math.random() - 0.5) * 0.08, pos.y + (Math.random() - 0.5) * 0.08, pos.z + (Math.random() - 0.5) * 0.08,
      (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6, 0.45, tmpC.r, tmpC.g, tmpC.b, -1);
  }

  tracer(a, b, hex = 0xffe2a0) {
    const t = this.tracers[this.tNext]; this.tNext = (this.tNext + 1) % N_TRACER;
    t.a.copy(a); t.dir.subVectors(b, a); t.dist = t.dir.length();
    if (t.dist < 0.5) return;
    t.dir.divideScalar(t.dist); t.s = Math.min(3, t.dist * 0.3); t.on = true;
    t.m.material.color.setHex(hex);
    t.m.quaternion.setFromUnitVectors(tmpV.set(0, 0, 1), t.dir);
    t.m.visible = true;
    this._placeTracer(t);
  }

  _placeTracer(t) {
    const head = Math.min(t.s, t.dist), tail = Math.max(0, t.s - 7);
    if (tail >= t.dist) { t.on = false; t.m.visible = false; return; }
    t.m.position.copy(t.a).addScaledVector(t.dir, (head + tail) / 2);
    t.m.scale.set(0.035, 0.035, Math.max(0.01, head - tail));
  }

  flash(pos, size = 0.7, life = 0.06) {
    const f = this.flashes[this.fNext]; this.fNext = (this.fNext + 1) % N_FLASH;
    f.s.position.copy(pos); f.life = f.max = life; f.size = size;
    f.s.material.rotation = Math.random() * 6.28; f.s.material.opacity = 1;
    f.s.scale.setScalar(size); f.s.visible = true;
  }

  explosion(pos, radius) {
    const b = this.booms[this.bNext]; this.bNext = (this.bNext + 1) % N_BOOM;
    b.m.position.copy(pos); b.life = 0.32; b.r = radius * 0.62; b.m.visible = true;
    const l = this.lights[this.lNext]; this.lNext = (this.lNext + 1) % this.lights.length;
    l.l.position.copy(pos); l.life = 0.3; l.l.intensity = 60;
    this.burst(pos, 46, 0xa8e05a, 11, 0, 0.4, 0, 0.6);
    this.burst(pos, 24, 0xeaffc0, 5, 0, 0.6, 0, 0.9);
    this.flash(pos, radius * 1.6, 0.14);
  }

  // pickle slices, for when a fighter gets pickled
  shards(pos, hex, n = 16) {
    for (let k = 0; k < n; k++) {
      const d = this.dState[this.dNext]; const i = this.dNext; this.dNext = (this.dNext + 1) % N_DEBRIS;
      d.life = 1.6 + Math.random() * 1.2;
      d.p.set(pos.x + (Math.random() - 0.5) * 0.4, pos.y + 0.3 + Math.random() * 0.9, pos.z + (Math.random() - 0.5) * 0.4);
      d.v.set((Math.random() - 0.5) * 7, 2.5 + Math.random() * 5, (Math.random() - 0.5) * 7);
      d.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      d.rv.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      d.s = 0.14 + Math.random() * 0.2;
      const pick = k % 3;
      this.debris.setColorAt(i, tmpC.setHex(pick === 0 ? 0x86bb3c : pick === 1 ? 0x5c982d : hex));
    }
    this.debris.instanceColor.needsUpdate = true;
  }

  update(dt) {
    // sparks
    for (let i = 0; i < N_PART; i++) {
      if (this.pLife[i] <= 0) continue;
      const j = i * 3;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) { this.pPos[j + 1] = -999; this.pCol[j] = this.pCol[j + 1] = this.pCol[j + 2] = 0; continue; }
      this.pVel[j + 1] -= this.pGrav[i] * dt;
      this.pPos[j] += this.pVel[j] * dt; this.pPos[j + 1] += this.pVel[j + 1] * dt; this.pPos[j + 2] += this.pVel[j + 2] * dt;
      const k = this.pLife[i] / this.pMax[i];
      this.pCol[j] = this.pBase[j] * k; this.pCol[j + 1] = this.pBase[j + 1] * k; this.pCol[j + 2] = this.pBase[j + 2] * k;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;

    // debris
    let moved = false;
    for (let i = 0; i < N_DEBRIS; i++) {
      const d = this.dState[i];
      if (d.life <= 0) continue;
      moved = true;
      d.life -= dt;
      if (d.life <= 0) { tmpM.makeScale(0, 0, 0); this.debris.setMatrixAt(i, tmpM); continue; }
      d.v.y -= 20 * dt;
      const nx = d.p.x + d.v.x * dt, ny = d.p.y + d.v.y * dt, nz = d.p.z + d.v.z * dt;
      if (this.world && this.world.pointSolid(nx, ny, nz)) {
        if (!this.world.pointSolid(nx, d.p.y, nz)) { d.v.y *= -0.38; d.v.x *= 0.7; d.v.z *= 0.7; d.rv.multiplyScalar(0.6); d.p.x = nx; d.p.z = nz; }
        else { d.v.x *= -0.4; d.v.z *= -0.4; }
      } else d.p.set(nx, ny, nz);
      d.r.addScaledVector(d.rv, dt);
      const s = d.s * Math.min(1, d.life * 2.5);
      tmpM.compose(d.p, tmpQ.setFromEuler(tmpE.set(d.r.x, d.r.y, d.r.z)), tmpS.set(s, s, s));
      this.debris.setMatrixAt(i, tmpM);
    }
    if (moved) this.debris.instanceMatrix.needsUpdate = true;

    for (const t of this.tracers) { if (!t.on) continue; t.s += 260 * dt; this._placeTracer(t); }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.s.visible = false; continue; }
      f.s.material.opacity = f.life / f.max;
    }
    for (const b of this.booms) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.m.visible = false; continue; }
      const k = 1 - b.life / 0.32;
      b.m.scale.setScalar(b.r * (0.25 + 0.75 * Math.sqrt(k)));
      b.m.material.opacity = 0.75 * (1 - k);
    }
    for (const l of this.lights) {
      if (l.life <= 0) continue;
      l.life -= dt;
      l.l.intensity = l.life > 0 ? 60 * (l.life / 0.3) : 0;
    }
  }
}
