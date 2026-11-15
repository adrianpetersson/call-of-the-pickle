// Loadout picker: one weapon at a time, slowly turning in 3D, with previous/next arrows.
// Used in the lobby's Loadout tab and as the main view of the in-game menu.
import * as THREE from 'three';
import { makeGun } from './avatar.js';
import { CLASSES, WEAPONS, STAT_LABELS } from '../shared/config.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class Carousel {
  constructor(root, onPick) {
    this.root = root; this.onPick = onPick; this.index = 0; this.spin = 0; this.pop = 1;
    root.classList.add('car');

    const stageRow = el('div', 'car-row');
    this.prev = el('button', 'car-arrow', '‹'); this.prev.type = 'button'; this.prev.setAttribute('aria-label', 'Previous loadout');
    this.next = el('button', 'car-arrow', '›'); this.next.type = 'button'; this.next.setAttribute('aria-label', 'Next loadout');
    this.stage = el('div', 'car-stage');
    this.canvas = el('canvas');
    this.stage.append(this.canvas);
    stageRow.append(this.prev, this.stage, this.next);

    const info = el('div', 'car-info');
    const head = el('div', 'car-head');
    this.title = el('b'); this.weapon = el('span');
    head.append(this.title, this.weapon);
    this.blurb = el('p');
    this.stats = el('div', 'stats');
    this.bars = STAT_LABELS.map((label) => {
      const bar = el('i');
      this.stats.append(el('span', '', label), bar);
      return bar;
    });
    this.dots = el('div', 'car-dots');
    CLASSES.forEach((c, i) => {
      const d = el('button'); d.type = 'button'; d.setAttribute('aria-label', c.title);
      d.addEventListener('click', () => this.go(i));
      this.dots.append(d);
    });
    info.append(head, this.blurb, this.stats, this.dots);
    root.append(stageRow, info);

    this.prev.addEventListener('click', () => this.step(-1));
    this.next.addEventListener('click', () => this.step(1));

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 2, 0.1, 20);
    this.camera.position.set(0, 0.32, 3.4);
    this.camera.lookAt(0, 0, 0);
    const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(1.5, 2.5, 3);
    const rim = new THREE.DirectionalLight(0xb9e24a, 2.2); rim.position.set(-2.5, 1, -2.5);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2b3a22, 1.5), key, rim);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.model = null;

    this.last = performance.now();
    const loop = () => { requestAnimationFrame(loop); this.frame(); };
    loop();
    this.show();
  }

  set(id) {
    const i = CLASSES.findIndex((c) => c.id === id);
    if (i < 0 || (i === this.index && this.model)) return;
    this.index = i;
    this.show();
  }
  go(i) { this.index = (i + CLASSES.length) % CLASSES.length; this.show(); this.onPick?.(CLASSES[this.index].id); }
  step(dir) { this.go(this.index + dir); }

  show() {
    const c = CLASSES[this.index];
    this.title.textContent = c.title;
    this.weapon.textContent = WEAPONS[c.id].name;
    this.blurb.textContent = c.blurb;
    c.stats.forEach((v, i) => this.bars[i].style.setProperty('--v', v + '%'));
    [...this.dots.children].forEach((d, i) => d.setAttribute('aria-current', String(i === this.index)));
    if (this.model) this.pivot.remove(this.model);
    // centre the weapon on its own middle and size it to fill the stage
    const gun = makeGun(c.id);
    const box = new THREE.Box3().setFromObject(gun);
    const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    gun.position.sub(centre);
    this.model = new THREE.Group();
    this.model.add(gun);
    this.model.scale.setScalar(1 / Math.max(size.x, size.y, size.z));        // normalised to 1 unit long
    this.pivot.add(this.model);
    this.pop = 0;
  }

  frame() {
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.root.offsetParent) return;                       // hidden: don't draw
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (w && h && (this.w !== w || this.h !== h)) {
      this.w = w; this.h = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }
    this.spin += dt * 0.7;
    this.pop += (1 - this.pop) * (1 - Math.exp(-10 * dt));
    this.pivot.rotation.set(0.12, this.spin, 0);
    // fill most of the stage whatever its shape
    const visH = 2 * this.camera.position.z * Math.tan((this.camera.fov * Math.PI) / 360), visW = visH * this.camera.aspect;
    this.pivot.scale.setScalar(Math.min(visW * 0.8, visH * 2.4) * (0.82 + 0.18 * this.pop));
    this.renderer.render(this.scene, this.camera);
  }
}
