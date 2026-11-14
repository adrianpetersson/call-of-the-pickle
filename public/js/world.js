// The voxel world: collision and ray queries on the grid, and the visible arena assembled from
// Blender-made building blocks (one instanced mesh per block type, so it stays a few draw calls).
import * as THREE from 'three';
import { CY, COLLIDER } from '../shared/maps.js';

export class World {
  constructor(map) {
    this.map = map;
    this.w = map.w; this.d = map.d; this.h = map.h;
    this.cells = map.cells;
  }

  // movement queries: everything outside the footprint is a wall
  solid(x, y, z) {
    if (x < 0 || z < 0 || x >= this.w || z >= this.d || y < 0) return true;
    if (y >= this.h) return false;
    return this.cells[(y * this.d + z) * this.w + x] !== 0;
  }

  // does a player-sized box at feet position (x,y,z) overlap anything solid?
  boxHits(x, y, z, r, height) {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r - 1e-5);
    const y0 = Math.floor((y + 1e-5) / CY), y1 = Math.floor((y + height - 1e-5) / CY);
    const z0 = Math.floor(z - r), z1 = Math.floor(z + r - 1e-5);
    for (let cy = y0; cy <= y1; cy++) for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      if (this.solid(cx, cy, cz)) return true;
    }
    return false;
  }

  pointSolid(x, y, z) { return this.solid(Math.floor(x), Math.floor(y / CY), Math.floor(z)); }

  // top of the highest solid cell at or below y in this column
  groundY(x, y, z) {
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let cy = Math.min(this.h - 1, Math.floor((y + 0.01) / CY)); cy >= 0; cy--) {
      if (this.solid(cx, cy, cz)) return (cy + 1) * CY;
    }
    return 0;
  }

  // Grid walk. Direction must be unit length; returns { t, hit, nx, ny, nz }.
  raycast(ox, oy, oz, dx, dy, dz, max) {
    oy /= CY; dy /= CY;
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
    let tmz = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tdz : Infinity;
    let t = 0, axis = -1;
    const out = { t: max, hit: false, nx: 0, ny: 0, nz: 0 };
    for (let i = 0; i < 512; i++) {
      if (x < 0 || z < 0 || x >= this.w || z >= this.d || y < 0) { out.t = Math.min(t, max); return out; }
      if (y >= this.h) { if (dy >= 0) return out; }
      else if (this.cells[(y * this.d + z) * this.w + x] !== 0) {
        out.t = t; out.hit = true;
        if (axis === 0) out.nx = -sx; else if (axis === 1) out.ny = -sy; else if (axis === 2) out.nz = -sz;
        return out;
      }
      if (tmx < tmy && tmx < tmz) { t = tmx; tmx += tdx; x += sx; axis = 0; }
      else if (tmy < tmz) { t = tmy; tmy += tdy; y += sy; axis = 1; }
      else { t = tmz; tmz += tdz; z += sz; axis = 2; }
      if (t > max) return out;
    }
    return out;
  }

  // Assemble the arena from kit blocks. `kitModels` is the loaded blocks.glb scene; map.kit says
  // which block style each palette slot uses and map.palette tints it.
  buildBlocks(kitModels) {
    const { w, d, h, cells, map } = this;
    const at = (x, y, z) => cells[(y * d + z) * w + x];
    const filled = (x, y, z) => {
      if (x < 0 || z < 0 || x >= w || z >= d || y < 0) return true;      // outside: never visible
      if (y >= h) return false;
      const v = at(x, y, z);
      return v !== 0 && v !== COLLIDER;
    };
    const exposed = (x, y, z) => !filled(x + 1, y, z) || !filled(x - 1, y, z) || !filled(x, y + 1, z)
      || !filled(x, y - 1, z) || !filled(x, y, z + 1) || !filled(x, y, z - 1);
    const lists = new Map();
    const color = new THREE.Color();
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        const c = at(x, y, z);
        if (!c || c === COLLIDER) { y++; continue; }
        let y1 = y;
        while (y1 < h && at(x, y1, z) === c) y1++;
        const kit = map.kit?.[c] ?? 'Stone';
        const floor = kit.startsWith('Floor');
        for (let yy = y; yy < y1;) {
          const cube = !floor && y1 - yy >= 2;
          const span = cube ? 2 : 1;
          let show = false;
          for (let k = 0; k < span; k++) if (exposed(x, yy + k, z)) show = true;
          if (show) {
            const name = floor ? kit : `${kit}_${cube ? 'cube' : 'slab'}`;
            const hash = (x * 73856093) ^ (yy * 19349663) ^ (z * 83492791);
            const alt = floor && ((x + z) & 1);
            color.setHex(alt && map.floorAlt != null ? map.floorAlt : map.palette[c] ?? 0x888888);
            const lift = 0.88 + 0.12 * Math.min(1, yy / 6);                 // lower blocks sit a touch darker
            const jitter = 0.93 + ((hash >>> 3) % 16) / 16 * 0.12;
            color.multiplyScalar(lift * jitter * (alt && map.floorAlt == null ? 0.86 : 1));
            const rot = floor ? (kit === 'FloorPaver' ? (x + z) & 1 : 0) : (hash >>> 8) & 3;
            let list = lists.get(name);
            if (!list) lists.set(name, list = []);
            list.push({ x, y: yy, z, rot, r: color.r, g: color.g, b: color.b });
          }
          yy += span;
        }
        y = y1;
      }
    }
    const group = new THREE.Group();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    let tris = 0;
    for (const [name, list] of lists) {
      const src = kitModels.getObjectByName(name);
      if (!src) continue;
      src.traverse((mesh) => {
        if (!mesh.isMesh) return;
        const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
        const tint = mesh.material.name.startsWith('Kit');
        list.forEach((b, i) => {
          pos.set(b.x + 0.5, b.y * CY, b.z + 0.5);
          q.setFromAxisAngle(up, b.rot * Math.PI / 2);
          im.setMatrixAt(i, m4.compose(pos, q, one));
          if (tint) im.setColorAt(i, color.setRGB(b.r, b.g, b.b));
        });
        im.castShadow = true; im.receiveShadow = true;
        im.frustumCulled = false;
        tris += (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3 * list.length;
        group.add(im);
      });
    }
    group.userData.tris = Math.round(tris);
    return group;
  }
}
