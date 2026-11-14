// Voxel maps. Cells are 1 x 0.5 x 1 world units (half-height cells make walkable stairs).
// Every structure is placed twice, rotated 180 degrees about the map centre, so both sides are fair.
// Shared by client (rendering, collision) and server (spawn points, pickups).

export const CY = 0.5;
const HALF_PI = Math.PI / 2;

// palette slots
const F = 1, W = 2, P = 3, S = 4, C = 5, A = 6, B = 7, T = 8, L = 9, C2 = 10;
// An invisible solid cell: gives a prop (barrel, stall, vat...) collision without drawing a block.
export const COLLIDER = 255;
// Footprint and height of each solid prop, in cells: [wide, deep, half-units tall]
const PROP_SIZE = { Barrel: [1, 1, 2], JarBig: [1, 1, 3], Crate: [1, 1, 1], Stall: [2, 1, 2], Vat: [2, 2, 3] };

class Builder {
  constructor(w, d, h) {
    this.w = w; this.d = d; this.h = h;
    this.cells = new Uint8Array(w * d * h);
    this._spawns = []; this._pickups = []; this._props = [];
    this.raw(0, 0, w, d, 0, 1, F);
  }
  raw(x, z, w, d, y0, y1, c) {
    for (let y = y0; y < y1; y++) for (let k = z; k < z + d; k++) for (let i = x; i < x + w; i++) {
      if (i < 0 || k < 0 || y < 0 || i >= this.w || k >= this.d || y >= this.h) continue;
      this.cells[(y * this.d + k) * this.w + i] = c;
    }
  }
  box(x, z, w, d, y0, y1, c) {
    this.raw(x, z, w, d, y0, y1, c);
    this.raw(this.w - x - w, this.d - z - d, w, d, y0, y1, c);
  }
  // solid block standing on the floor, `h` half-units tall
  block(x, z, w, d, h, c) { this.box(x, z, w, d, 1, 1 + h, c); }
  // floating slab whose top is level with a block of height `level`
  slab(x, z, w, d, level, c) { this.box(x, z, w, d, level, level + 1, c); }
  // n steps starting at (x,z), each one half-unit higher, marching in (dx,dz)
  stairs(x, z, dx, dz, n, width, c, base = 0) {
    for (let i = 0; i < n; i++) {
      if (dx) this.block(x + dx * i, z, 1, width, base + i + 1, c);
      else this.block(x, z + dz * i, width, 1, base + i + 1, c);
    }
  }
  walls(h, c) {
    this.box(0, 0, this.w, 1, 1, 1 + h, c);
    this.box(0, 0, 1, this.d, 1, 1 + h, c);
  }
  spawn(x, z) {
    this._spawns.push([x + 0.5, z + 0.5, 0], [this.w - x - 0.5, this.d - z - 0.5, 1]);
  }
  pickup(t, x, z) {
    this._pickups.push([t, x + 0.5, z + 0.5], [t, this.w - x - 0.5, this.d - z - 0.5]);
  }
  pickupAt(t, x, z) { this._pickups.push([t, x, z]); }
  // A solid prop standing on whatever is at cell (x,z). rot is in quarter turns; front faces +z at 0.
  prop(name, x, z, quarters = 0) {
    const [w0, d0, h] = PROP_SIZE[name];
    const w = quarters % 2 ? d0 : w0, d = quarters % 2 ? w0 : d0;
    const y = this.standAt(x + 0.5, z + 0.5), cy = Math.round(y / CY);
    this.box(x, z, w, d, cy, cy + h, COLLIDER);
    const cx = x + w / 2, cz = z + d / 2, rot = quarters * Math.PI / 2;
    this._props.push({ m: name, x: cx, y, z: cz, rot }, { m: name, x: this.w - cx, y, z: this.d - cz, rot: rot + Math.PI });
  }
  // Decoration with no collision, at an exact position (mirrored unless told otherwise).
  decor(name, x, y, z, rot = 0, mirror = true) {
    this._props.push({ m: name, x, y, z, rot });
    if (mirror) this._props.push({ m: name, x: this.w - x, y, z: this.d - z, rot: rot + Math.PI });
  }
  solid(x, y, z) {
    if (x < 0 || z < 0 || x >= this.w || z >= this.d || y < 0) return true;
    if (y >= this.h) return false;
    return this.cells[(y * this.d + z) * this.w + x] !== 0;
  }
  // lowest surface in this column with room to stand on
  standAt(x, z) {
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let y = 0; y < this.h; y++) {
      if (this.solid(cx, y, cz) && !this.solid(cx, y + 1, cz) && !this.solid(cx, y + 2, cz) && !this.solid(cx, y + 3, cz)) {
        return (y + 1) * CY;
      }
    }
    return CY;
  }
  finish(meta) {
    const cx = this.w / 2, cz = this.d / 2;
    const spawns = this._spawns.map(([x, z, side]) => ({
      x, y: this.standAt(x, z), z, side, yaw: Math.atan2(-(cx - x), -(cz - z)),
    }));
    const pickups = this._pickups.map(([t, x, z]) => ({ t, x, y: this.standAt(x, z), z }));
    return { ...meta, w: this.w, d: this.d, h: this.h, cells: this.cells, spawns, pickups, props: this._props };
  }
}

function foundry() {
  const b = new Builder(32, 32, 18);
  b.walls(7, W);
  // centre deck with four stairways and a pillar
  b.block(12, 12, 8, 8, 4, P);
  b.stairs(9, 14, 1, 0, 3, 4, S);
  b.stairs(14, 9, 0, 1, 3, 4, S);
  b.block(15, 15, 2, 2, 8, A);
  b.block(12, 12, 3, 1, 6, L); b.block(12, 12, 1, 3, 6, L);
  b.block(17, 12, 3, 1, 6, L); b.block(19, 12, 1, 3, 6, L);
  // corner tower, stairs, and a high walkway to a side perch
  b.block(1, 1, 6, 6, 6, T);
  b.stairs(11, 3, -1, 0, 5, 2, S);
  b.block(1, 6, 3, 1, 8, L); b.block(6, 1, 1, 2, 8, L);
  b.slab(2, 7, 2, 8, 6, B);
  b.block(1, 15, 4, 4, 6, T);
  b.stairs(1, 23, 0, -1, 5, 2, S);
  b.block(4, 15, 1, 2, 8, L);
  // bunker in the other corner
  b.block(23, 5, 5, 1, 5, C2); b.block(23, 2, 1, 2, 5, C2);
  // cover
  b.block(8, 9, 2, 2, 2, C); b.block(20, 5, 2, 2, 2, C); b.block(6, 20, 2, 2, 2, C);
  b.block(24, 10, 2, 2, 3, C2); b.block(17, 6, 1, 1, 4, C2);
  b.block(7, 12, 1, 5, 5, L); b.block(20, 8, 5, 1, 5, L);
  b.block(10, 19, 2, 2, 10, A);
  for (const [x, z] of [[5, 9], [9, 1], [13, 2], [5, 21], [20, 2], [5, 12], [9, 6], [13, 7], [3, 3], [27, 2]]) b.spawn(x, z);
  b.pickup('hp', 5, 13); b.pickup('hp', 13, 18);
  b.pickup('ammo', 16, 2); b.pickup('ammo', 27, 8); b.pickup('ammo', 2, 16);
  // dressing: brine vats in the bunkers, barrels, jars and crates as extra cover
  b.prop('Vat', 2, 28);
  b.prop('Barrel', 12, 10); b.prop('Barrel', 12, 11); b.prop('Crate', 13, 11);
  b.prop('Barrel', 1, 10); b.prop('Barrel', 1, 11);
  b.prop('Barrel', 22, 13); b.prop('Barrel', 23, 13);
  b.prop('JarBig', 15, 6); b.prop('JarBig', 5, 17);
  b.prop('Crate', 18, 8); b.prop('Crate', 19, 8);
  b.decor('Sign', 16, 2.75, 1.07, 0);
  b.decor('SignBrine', 1.07, 2.7, 26, HALF_PI);
  b.decor('Lamp', 11.5, 0.5, 12.5, -HALF_PI); b.decor('Lamp', 1.6, 3.5, 1.6, HALF_PI / 2);
  for (const [x, z] of [[0.5, 6.5], [0.5, 20.5], [8.5, 0.5], [22.5, 0.5]]) b.decor('DillPot', x, 4, z);
  b.decor('DillPot', 12.5, 3.5, 12.5); b.decor('DillPot', 19.5, 3.5, 12.5);
  return b.finish({
    scenery: [
      { m: 'JarBig', x: -6.5, y: 0.46, z: 9, s: 9, rot: 0.4 }, { m: 'JarBig', x: 26, y: 0.46, z: -7, s: 8, rot: 2 },
      { m: 'BottleRed', x: 39, y: 0.46, z: 24, s: 11, rot: -1.2 }, { m: 'BottleYellow', x: 40, y: 0.46, z: 12, s: 10, rot: -1.8 },
      { m: 'Fork', x: 14, y: 0.46, z: 38, s: 15, rot: Math.PI, tilt: 0.22 },
      { m: 'Pickle', x: 9, y: 0.46, z: -7.5, s: 7.5, rot: Math.PI, c: 1 }, { m: 'Pickle', x: -7, y: 0.46, z: 25, s: 6.5, rot: -HALF_PI, c: 5 },
    ],
    id: 'foundry', name: 'Cannery',
    // which building block each part of the arena is made of, and its colour
    kit: { [F]: 'FloorTile', [W]: 'Brick', [P]: 'Steel', [S]: 'Steel', [C]: 'Crate', [A]: 'Can', [B]: 'Steel', [T]: 'Container', [L]: 'Cinder', [C2]: 'Container' },
    palette: { [F]: 0x8a9099, [W]: 0xa9523d, [P]: 0x8f9cb0, [S]: 0xa3afc2, [C]: 0xc28c50, [A]: 0xf2c94c, [B]: 0x7f8ba0, [T]: 0xc65b38, [L]: 0xb4b8bf, [C2]: 0x3f9a9b },
    sky: { top: 0x2b3a67, bottom: 0xf7b267, fog: 0xd9a37a, sun: 0xffe2b8, ambient: 0x9fb4d8 },
  });
}

function switchyard() {
  const b = new Builder(36, 24, 18);
  b.walls(8, W);
  // long raised walkways on both sides, joined by a centre bridge
  b.block(4, 1, 28, 3, 5, P);
  b.stairs(6, 7, 0, -1, 4, 2, S);
  b.stairs(27, 7, 0, -1, 4, 2, S);
  b.slab(17, 4, 2, 16, 5, B);
  b.block(17, 11, 2, 2, 4, A);
  b.block(10, 3, 3, 1, 7, L); b.block(22, 3, 3, 1, 7, L);
  // containers and crates in the yard
  b.block(9, 9, 5, 2, 4, C); b.block(10, 14, 5, 2, 4, C2);
  b.block(15, 11, 2, 2, 2, T); b.block(4, 11, 2, 2, 2, T);
  b.block(14, 6, 2, 2, 6, A);
  b.block(1, 7, 2, 1, 4, L); b.block(24, 5, 1, 3, 4, L);
  for (const [x, z] of [[2, 5], [2, 9], [2, 14], [3, 18], [2, 21], [5, 2], [10, 6], [12, 17], [8, 12], [14, 2]]) b.spawn(x, z);
  b.pickup('hp', 2, 12); b.pickup('hp', 13, 2);
  b.pickup('ammo', 25, 10); b.pickup('ammo', 7, 18);
  b.pickupAt('ammo', 18, 12);
  // dressing: market stalls under the walkways, barrels, jars and crates
  b.prop('Stall', 9, 4); b.prop('Stall', 20, 4);
  b.prop('Barrel', 1, 10); b.prop('Barrel', 1, 11); b.prop('Barrel', 30, 5); b.prop('Barrel', 31, 5);
  b.prop('Crate', 14, 9); b.prop('Crate', 14, 10);
  b.prop('JarBig', 6, 9); b.prop('JarBig', 6, 14);
  b.decor('Sign', 18, 3.95, 1.07, 0);
  b.decor('SignBrine', 1.07, 3.2, 12, HALF_PI);
  b.decor('Lamp', 14.5, 3, 3.6, 0); b.decor('Lamp', 20.5, 3, 3.6, 0);
  b.decor('DillPot', 11.5, 4, 3.5); b.decor('DillPot', 23.5, 4, 3.5); b.decor('DillPot', 11.5, 2.5, 9.5);
  for (const [x, z] of [[0.5, 4.5], [0.5, 18.5], [34.5, 0.5]]) b.decor('DillPot', x, 4.5, z);
  return b.finish({
    scenery: [
      { m: 'BottleYellow', x: -7, y: 0.46, z: 7, s: 11, rot: 1.2 }, { m: 'BottleRed', x: -6, y: 0.46, z: 18, s: 10, rot: 1.6 },
      { m: 'JarBig', x: 43, y: 0.46, z: 15, s: 9, rot: -1 }, { m: 'JarBig', x: 12, y: 0.46, z: 31, s: 8, rot: 3 },
      { m: 'Fork', x: 27, y: 0.46, z: -6, s: 15, rot: 0, tilt: 0.22 },
      { m: 'Pickle', x: 43, y: 0.46, z: 3, s: 7.5, rot: HALF_PI, c: 3 }, { m: 'Pickle', x: 24, y: 0.46, z: 31, s: 6.5, rot: 0, c: 9 },
    ],
    id: 'switchyard', name: 'Market Yard',
    // which building block each part of the arena is made of, and its colour
    kit: { [F]: 'FloorPaver', [W]: 'Stone', [P]: 'Planks', [S]: 'Planks', [C]: 'Container', [A]: 'Crate', [B]: 'Planks', [T]: 'Crate', [L]: 'Cinder', [C2]: 'Container' },
    palette: { [F]: 0xc4b392, [W]: 0xd6c6a4, [P]: 0xb5803f, [S]: 0xc79350, [C]: 0xd9583f, [A]: 0xc08a4e, [B]: 0xa9773f, [T]: 0xc99555, [L]: 0xbcc0c6, [C2]: 0x3f7fbf },
    sky: { top: 0x1f5f8b, bottom: 0xbfe8f2, fog: 0xa9d6e5, sun: 0xffffff, ambient: 0xa8c8e8 },
  });
}

function scrapPit() {
  const b = new Builder(24, 24, 18);
  b.walls(8, W);
  b.block(11, 11, 2, 2, 10, A);
  // four L-shaped decks around the centre, with short stairs
  b.block(7, 7, 4, 2, 3, P); b.block(7, 7, 2, 4, 3, P);
  b.block(13, 7, 4, 2, 3, P); b.block(15, 7, 2, 4, 3, P);
  b.stairs(5, 7, 1, 0, 2, 2, S);
  b.stairs(18, 7, -1, 0, 2, 2, S);
  b.block(2, 2, 2, 2, 2, C); b.block(20, 2, 2, 2, 2, C2);
  b.block(3, 11, 3, 1, 5, L); b.block(11, 3, 1, 3, 5, L);
  b.block(1, 17, 1, 2, 3, C2);
  for (const [x, z] of [[1, 5], [5, 1], [9, 2], [2, 9], [1, 13], [14, 1], [18, 1], [6, 4]]) b.spawn(x, z);
  b.pickup('hp', 8, 8); b.pickup('ammo', 15, 8); b.pickup('hp', 21, 5);
  b.prop('Barrel', 1, 9); b.prop('Barrel', 1, 10); b.prop('Barrel', 21, 9);
  b.prop('JarBig', 9, 5);
  b.prop('Crate', 13, 3); b.prop('Crate', 13, 4);
  b.decor('Sign', 12, 3.3, 1.07, 0);
  b.decor('SignBrine', 1.07, 3.3, 15.5, HALF_PI);
  b.decor('Lamp', 12, 5.5, 12, 0, false);
  for (const [x, z] of [[0.5, 3.5], [0.5, 20.5], [7.5, 0.5], [16.5, 0.5]]) b.decor('DillPot', x, 4.5, z);
  return b.finish({
    scenery: [
      { m: 'JarBig', x: -6, y: 0.46, z: 6, s: 8, rot: 0.6 }, { m: 'BottleRed', x: 30, y: 0.46, z: 17, s: 10, rot: -1.4 },
      { m: 'BottleYellow', x: 17, y: 0.46, z: 30.5, s: 10, rot: 2.6 }, { m: 'Fork', x: 5, y: 0.46, z: 30, s: 14, rot: Math.PI, tilt: 0.22 },
      { m: 'Pickle', x: 15, y: 0.46, z: -7, s: 7, rot: Math.PI, c: 2 }, { m: 'Pickle', x: 31, y: 0.46, z: 5, s: 6.5, rot: HALF_PI, c: 6 },
    ],
    id: 'scrappit', name: 'Brine Pit',
    // which building block each part of the arena is made of, and its colour
    kit: { [F]: 'FloorTile', [W]: 'Stone', [P]: 'Planks', [S]: 'Planks', [C]: 'Cheese', [A]: 'Can', [B]: 'Planks', [T]: 'Planks', [L]: 'Cinder', [C2]: 'Cheese' },
    palette: { [F]: 0xf0f3ee, [W]: 0x8f80c6, [P]: 0xe0a868, [S]: 0xebb97c, [C]: 0xf5c542, [A]: 0xf25f8a, [B]: 0xe0a868, [T]: 0xe0a868, [L]: 0xf6f3ec, [C2]: 0xf29a3a },
    floorAlt: 0x58b8a8,
    sky: { top: 0x241b4a, bottom: 0xf28fb1, fog: 0xc98fb8, sun: 0xffd9ec, ambient: 0xb7a6e8 },
  });
}

// The lobby backdrop: an alley that repeats every LOBBY_PERIOD cells, so the menu camera can walk
// down it forever. Never played in.
export const LOBBY_PERIOD = 16;
function lobbyAlley() {
  const b = new Builder(11, 80, 18);
  b.raw(0, 0, 1, 80, 1, 9, W); b.raw(10, 0, 1, 80, 1, 9, W);
  const put = (name, x, z, rot = 0, y = 0.5) => b._props.push({ m: name, x, y, z, rot });
  for (let z0 = 0; z0 < 80; z0 += LOBBY_PERIOD) {
    b.raw(1, z0 + 1, 2, 3, 1, 5, C2); b.raw(1, z0 + 1, 2, 2, 5, 7, T);          // stacked containers
    b.raw(8, z0 + 5, 2, 2, 1, 3, C); b.raw(9, z0 + 7, 1, 1, 1, 3, C); b.raw(8, z0 + 5, 1, 1, 3, 5, C);   // crates
    b.raw(9, z0 + 12, 1, 1, 1, 7, A);                                             // can tower
    b.raw(1, z0 + 9, 1, 3, 1, 3, L);                                               // cinder wall
    b.raw(8, z0 + 14, 2, 1, 1, 2, P);
    put('Barrel', 2.6, z0 + 6.2); put('Barrel', 1.6, z0 + 6.9, 1); put('JarBig', 8.5, z0 + 10.2, 0.6);
    put('Crate', 2.4, z0 + 13.6, 0.3); put('Barrel', 8.3, z0 + 2.4);
    put('Lamp', 1.5, z0 + 15.2, Math.PI / 2); put('Lamp', 9.5, z0 + 8.6, -Math.PI / 2);
    put('DillPot', 8.5, z0 + 14.5, 0, 1.5); put('DillPot', 1.5, z0 + 10.5, 0, 2);
    put('SignBrine', 0.93 + 0.14, z0 + 4, Math.PI / 2, 3.4); put('Sign', 10 - 0.07, z0 + 11.5, -Math.PI / 2, 3.4);
  }
  return b.finish({
    id: 'lobby', name: 'Lobby',
    kit: { [F]: 'FloorPaver', [W]: 'Brick', [P]: 'Planks', [C]: 'Crate', [A]: 'Can', [T]: 'Container', [L]: 'Cinder', [C2]: 'Container' },
    palette: { [F]: 0x6f7780, [W]: 0x7d4636, [P]: 0x9a6b3c, [C]: 0xa8773f, [A]: 0xd9b23f, [T]: 0xa84a30, [L]: 0x8f949c, [C2]: 0x2f7f86 },
    sky: { top: 0x070d16, bottom: 0x21414f, fog: 0x15293a, sun: 0xffb877, ambient: 0x7c9cc4, fogNear: 5, fogFar: 34 },
  });
}
export const LOBBY = lobbyAlley();

export const MAPS = [foundry(), switchyard(), scrapPit()];
