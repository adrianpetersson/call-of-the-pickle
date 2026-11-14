// Pickle fighters and their gear. Models come from Blender (assets.js); they face -Z like the camera.
import * as THREE from 'three';
import { part } from './assets.js';

// Where the right and left glove sit on each weapon, in the weapon's own space.
const HANDS = {
  rattler: [[0, -0.075, 0.045], [-0.015, -0.035, -0.4]],
  scatter: [[0, -0.05, 0.075], [-0.015, -0.035, -0.36]],
  longshot: [[0, -0.075, 0.07], [-0.015, -0.03, -0.36]],
  thumper: [[0, -0.11, -0.02], [-0.01, -0.1, -0.3]],
  sidearm: [[0, -0.08, 0.012], [-0.05, -0.09, 0.0]],
};

export function makeTint(hex = 0xff6b4a) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, metalness: 0 });
}

// A weapon pointing down -Z with its grip near the origin. Pass a tint material to add gloves.
export function makeGun(id, tint) {
  const g = part(id);
  g.userData.muzzle = new THREE.Vector3(0, 0.04, -0.7);
  g.traverse((o) => { if (o.name.startsWith('Muzzle')) g.userData.muzzle.copy(o.position); });
  if (tint) {
    const [r, l] = HANDS[id] ?? HANDS.rattler;
    const hr = part('pickle', 'Hand', tint), hl = part('pickle', 'Hand', tint);
    hr.position.set(r[0], r[1], r[2]);
    hl.position.set(l[0], l[1], l[2]); hl.scale.x = -1;
    g.add(hr, hl);
  }
  return g;
}

export function makeGrenadeMesh() { return part('bomb', 'Bomb'); }
export function makeRocketMesh() { return part('jar', 'Jar'); }
export function makePickup(type) {
  const o = part('pickups', type === 'hp' ? 'HealthJar' : 'AmmoCrate');
  o.scale.setScalar(type === 'hp' ? 0.95 : 1);
  return o;
}

function nameTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 30px Rubik, system-ui, sans-serif';
  const tw = Math.min(236, g.measureText(text).width);
  const bw = tw + 28, x = (256 - bw) / 2;
  g.fillStyle = 'rgba(14,17,26,0.72)';
  g.beginPath(); g.roundRect(x, 10, bw, 44, 12); g.fill();
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 33, 236);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Bot {
  constructor() {
    this.group = new THREE.Group();
    this.tint = makeTint();
    this.body = part('pickle', 'Body', this.tint);
    this.footL = part('pickle', 'Foot', this.tint);
    this.footR = part('pickle', 'Foot', this.tint);
    this.footL.position.x = -0.15; this.footR.position.x = 0.15;

    this.gunPivot = new THREE.Group();
    this.gunPivot.position.set(0.35, 0.74, -0.1);
    this.gun = null; this.gunId = null;

    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xb8ff6a, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    this.shield.position.y = 0.82; this.shield.visible = false;

    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    this.tag.scale.set(1.5, 0.375, 1); this.tag.position.y = 1.9;

    this.group.add(this.body, this.footL, this.footR, this.gunPivot, this.shield, this.tag);
    this.phase = Math.random() * 6;
  }

  setColor(hex) { this.tint.color.setHex(hex); }

  setName(text, cssColor = '#ffffff') {
    const key = text + cssColor;
    if (this._tagKey === key) return;
    this._tagKey = key;
    this.tag.material.map?.dispose();
    this.tag.material.map = nameTexture(text, cssColor);
    this.tag.material.needsUpdate = true;
  }

  setWeapon(id) {
    if (this.gunId === id) return;
    if (this.gun) this.gunPivot.remove(this.gun);
    this.gun = makeGun(id, this.tint); this.gunId = id;
    this.gunPivot.add(this.gun);
  }

  muzzleWorld(out) {
    if (!this.gun) return out.copy(this.group.position);
    this.group.updateMatrixWorld(true);
    return out.copy(this.gun.userData.muzzle).applyMatrix4(this.gun.matrixWorld);
  }

  // speed in units/s, pitch in radians
  animate(dt, speed, pitch, grounded) {
    this.phase += dt * Math.min(speed, 8) * 2.3;
    const swing = Math.min(1, speed / 5) * (grounded ? 1 : 0.35);
    const s = Math.sin(this.phase) * swing;
    this.footL.position.z = -s * 0.2; this.footR.position.z = s * 0.2;
    this.footL.position.y = Math.max(0, s) * 0.09; this.footR.position.y = Math.max(0, -s) * 0.09;
    this.footL.rotation.x = -s * 0.5; this.footR.rotation.x = s * 0.5;
    const idle = Math.sin(this.phase * 0.5 + performance.now() / 600) * 0.012;
    this.body.position.y = Math.abs(Math.cos(this.phase)) * 0.04 * swing + idle;
    this.body.rotation.x = pitch * 0.2 - 0.09 * swing;
    this.body.rotation.z = Math.sin(this.phase) * 0.06 * swing;
    this.gunPivot.position.set(0.35, 0.74 + this.body.position.y, -0.1);
    this.gunPivot.rotation.set(pitch, 0, 0);
  }
}
