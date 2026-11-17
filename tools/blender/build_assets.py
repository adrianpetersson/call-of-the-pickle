# Builds every 3D asset for the game inside Blender and exports them as .glb files.
# Run inside Blender (5.x):  exec(compile(open(PATH).read(), PATH, 'exec'), ns); ns['build_all'](OUT_DIR)
# Convention: +Y is forward, +Z is up, units are metres. The glTF exporter turns that into
# three.js space (-Z forward, +Y up).

import bpy, bmesh, math, random
from mathutils import Matrix, Euler, Vector

COLLECTION = "BigDill"


def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h, a=1.0):
    return (lin(((h >> 16) & 255) / 255), lin(((h >> 8) & 255) / 255), lin((h & 255) / 255), a)


def mat(name, h, rough=0.62, emit=0.0, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = hexcol(h)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = 0.0
    b.inputs["Alpha"].default_value = alpha
    if emit:
        b.inputs["Emission Color"].default_value = hexcol(h)
        b.inputs["Emission Strength"].default_value = emit
    if alpha < 1.0:
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    m.diffuse_color = hexcol(h, alpha)
    return m


def collection():
    c = bpy.data.collections.get(COLLECTION)
    if c is None:
        c = bpy.data.collections.new(COLLECTION)
        bpy.context.scene.collection.children.link(c)
    return c


def wipe():
    c = collection()
    for o in list(c.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0:
            bpy.data.meshes.remove(me)


class Model:
    """Accumulates primitive pieces into one mesh with several materials."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def _mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def _commit(self, tb, m, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), smooth=True, recalc=True):
        M = Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1))
        if recalc:
            bmesh.ops.recalc_face_normals(tb, faces=tb.faces[:])
        bmesh.ops.transform(tb, matrix=M, verts=tb.verts[:])
        idx = self._mi(m)
        for f in tb.faces:
            f.material_index = idx
            f.smooth = smooth and not getattr(self, 'flat', False)
        tmp = bpy.data.meshes.new("tmp")
        tb.to_mesh(tmp)
        tb.free()
        self.bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)

    def box(self, size, loc, m, rot=(0, 0, 0), bevel=0.012, segs=2):
        tb = bmesh.new()
        bmesh.ops.create_cube(tb, size=1.0)
        bmesh.ops.scale(tb, vec=size, verts=tb.verts[:])
        if bevel > 0:
            bmesh.ops.bevel(tb, geom=tb.edges[:], offset=min(bevel, min(size) * 0.45), segments=segs, affect='EDGES', profile=0.5)
        self._commit(tb, m, loc, rot)

    def lathe(self, profile, loc, m, axis='Y', segs=16, rot=(0, 0, 0), scale=(1, 1, 1)):
        """profile: [(radius, t), ...] along the axis; ends are capped."""
        tb = bmesh.new()
        rings = []
        for (r, t) in profile:
            rings.append([tb.verts.new((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), t)) for i in range(segs)])
        for a, b in zip(rings, rings[1:]):
            for i in range(segs):
                j = (i + 1) % segs
                tb.faces.new((a[i], a[j], b[j], b[i]))
        if profile[0][0] > 1e-6:
            tb.faces.new(list(reversed(rings[0])))
        if profile[-1][0] > 1e-6:
            tb.faces.new(rings[-1])
        if axis == 'Y':
            bmesh.ops.rotate(tb, cent=(0, 0, 0), matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'), verts=tb.verts[:])
        elif axis == 'X':
            bmesh.ops.rotate(tb, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=tb.verts[:])
        bmesh.ops.remove_doubles(tb, verts=tb.verts[:], dist=1e-6)
        self._commit(tb, m, loc, rot, scale)

    def cyl(self, r, length, loc, m, axis='Y', segs=16, bevel=0.006, rot=(0, 0, 0)):
        h = length / 2
        b = min(bevel, r * 0.5, h * 0.5)
        prof = [(r - b, -h), (r, -h + b), (r, h - b), (r - b, h)] if b > 0 else [(r, -h), (r, h)]
        self.lathe(prof, loc, m, axis, segs, rot)

    def sphere(self, r, loc, m, scale=(1, 1, 1), u=16, v=10, rot=(0, 0, 0)):
        tb = bmesh.new()
        bmesh.ops.create_uvsphere(tb, u_segments=u, v_segments=v, radius=r)
        self._commit(tb, m, loc, rot, scale)

    def torus(self, R, r, loc, m, axis='Z', segs=28, tube=10, scale=(1, 1, 1), rot=(0, 0, 0)):
        tb = bmesh.new()
        rings = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            ring = []
            for k in range(tube):
                b = 2 * math.pi * k / tube
                rr = R + r * math.cos(b)
                ring.append(tb.verts.new((rr * math.cos(a), rr * math.sin(a), r * math.sin(b))))
            rings.append(ring)
        for i in range(segs):
            a, b = rings[i], rings[(i + 1) % segs]
            for k in range(tube):
                j = (k + 1) % tube
                tb.faces.new((a[k], b[k], b[j], a[j]))
        if axis == 'Y':
            bmesh.ops.rotate(tb, cent=(0, 0, 0), matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'), verts=tb.verts[:])
        elif axis == 'X':
            bmesh.ops.rotate(tb, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=tb.verts[:])
        self._commit(tb, m, loc, rot, scale)

    def raw(self, tb, m, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), recalc=True):
        self._commit(tb, m, loc, rot, scale, recalc=recalc)

    def finish(self, sharp=38):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        me.set_sharp_from_angle(angle=math.radians(sharp))
        o = bpy.data.objects.new(self.name, me)
        collection().objects.link(o)
        return o


def empty(name, loc, parent):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.04
    e.location = loc
    e.parent = parent
    collection().objects.link(e)
    return e


# ------------------------------------------------------------------------------------------
# Pickle fighter
# ------------------------------------------------------------------------------------------
def pickle_radius(t, R=0.285, p=3.2):
    """Rounded-cylinder profile, t in [-1, 1]."""
    return R * max(0.0, 1 - abs(t) ** p) ** (1 / p)


def pickle_body_bm(z0, z1, R, segs=24, rings=22, bend=0.035, stripe_every=6, seed=7, bump=0.02):
    """Returns (bmesh, stripe_face_set). Long axis is Z, belly bows toward +Y."""
    rnd = random.Random(seed)
    tb = bmesh.new()
    mid, half = (z0 + z1) / 2, (z1 - z0) / 2
    phase = [rnd.uniform(0, 6.28) for _ in range(4)]
    rows = []
    for k in range(rings + 1):
        t = -1 + 2 * k / rings
        t = max(-0.985, min(0.985, t))
        taper = 1.0 - 0.07 * t                       # a little slimmer at the top
        r0 = pickle_radius(t, R) * taper
        row = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            wob = 1 + bump * (math.sin(3 * a + phase[0] + t * 5) * 0.6 + math.sin(5 * a + phase[1] - t * 7) * 0.4)
            r = r0 * wob
            y_bend = bend * (1 - t * t)
            row.append(tb.verts.new((r * math.cos(a), r * math.sin(a) + y_bend, mid + t * half)))
        rows.append(row)
    stripes = set()
    for k in range(rings):
        a, b = rows[k], rows[k + 1]
        for i in range(segs):
            j = (i + 1) % segs
            f = tb.faces.new((a[i], a[j], b[j], b[i]))
            if i % stripe_every == stripe_every // 2 and 1 <= k < rings - 1:
                stripes.add(f)
    tb.faces.new(list(reversed(rows[0])))
    tb.faces.new(rows[-1])
    return tb, stripes


def build_pickle():
    skin = mat("Pickle", 0x5c982d, 0.5)
    stripe = mat("PickleStripe", 0x86bb3c, 0.5)
    wart = mat("PickleWart", 0x77ad36, 0.5)
    dark = mat("PickleDark", 0x2f5a1c, 0.6)
    white = mat("EyeWhite", 0xf7f5ee, 0.35)
    black = mat("Black", 0x14161a, 0.4)
    mouth = mat("Mouth", 0x5a1f24, 0.6)
    tint = mat("Tint", 0xff6b4a, 0.55)
    sole = mat("Sole", 0xf2efe6, 0.6)

    # ---- body ----
    m = Model("Body")
    z0, z1, R = 0.2, 1.5, 0.285
    tb, stripes = pickle_body_bm(z0, z1, R)
    # split stripes into their own material by committing twice
    s_idx = m._mi(stripe)
    b_idx = m._mi(skin)
    bmesh.ops.recalc_face_normals(tb, faces=tb.faces[:])
    for f in tb.faces:
        f.material_index = s_idx if f in stripes else b_idx
        f.smooth = True
    tmp = bpy.data.meshes.new("tmp"); tb.to_mesh(tmp); tb.free(); m.bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)

    def surf(angle_deg, z, out=0.0):
        """Point on the body surface at a compass angle (90 = front, +Y)."""
        mid, half = (z0 + z1) / 2, (z1 - z0) / 2
        t = (z - mid) / half
        r = pickle_radius(t, R) * (1 - 0.07 * t) + out
        a = math.radians(angle_deg)
        return (r * math.cos(a), r * math.sin(a) + 0.035 * (1 - t * t), z)

    # warts, kept away from the face
    rnd = random.Random(11)
    placed = 0
    while placed < 30:
        ang, z = rnd.uniform(0, 360), rnd.uniform(0.34, 1.4)
        if 35 < ang < 145 and 0.9 < z < 1.3:
            continue
        s = rnd.uniform(0.022, 0.04)
        m.sphere(s, surf(ang, z, -s * 0.35), wart, scale=(1, 1, 0.85), u=8, v=6)
        placed += 1

    # face
    for sx in (-1, 1):
        ex = surf(90 - sx * 23, 1.14, -0.03)
        m.sphere(0.088, ex, white, scale=(1, 0.7, 1.12), u=16, v=12)
        px = surf(90 - sx * 20, 1.135, 0.022)
        m.sphere(0.043, px, black, scale=(1, 0.55, 1.1), u=12, v=8)
        gl = surf(90 - sx * 17.5, 1.16, 0.042)
        m.sphere(0.014, (gl[0] + 0.012, gl[1], gl[2]), white, u=8, v=6)
        bx = surf(90 - sx * 23, 1.25, 0.03)
        m.box((0.15, 0.05, 0.042), bx, dark, rot=(math.radians(-12), math.radians(-sx * 22), math.radians(-sx * 20)), bevel=0.016)
    mx = surf(90, 0.985, -0.012)
    m.box((0.19, 0.05, 0.04), mx, mouth, rot=(0, math.radians(-9), 0), bevel=0.018)
    m.box((0.034, 0.035, 0.03), (mx[0] - 0.03, mx[1] + 0.012, mx[2] + 0.006), white, bevel=0.008)

    # headband with a knot and tails
    bz = 1.335
    c = surf(90, bz)
    rb = pickle_radius((bz - 0.85) / 0.65, R) * (1 - 0.07 * (bz - 0.85) / 0.65)
    m.torus(rb + 0.004, 0.036, (0, 0.035 * (1 - ((bz - 0.85) / 0.65) ** 2), bz), tint, scale=(1, 1, 1.25), tube=8)
    kb = surf(270, bz, 0.035)
    m.sphere(0.05, kb, tint, scale=(1.2, 0.9, 1), u=10, v=8)
    m.box((0.06, 0.22, 0.018), (kb[0] - 0.05, kb[1] - 0.1, kb[2] - 0.06), tint, rot=(math.radians(32), 0, math.radians(-18)), bevel=0.006)
    m.box((0.06, 0.19, 0.018), (kb[0] + 0.05, kb[1] - 0.085, kb[2] - 0.085), tint, rot=(math.radians(48), 0, math.radians(20)), bevel=0.006)
    body = m.finish(sharp=50)

    # ---- sneaker (origin at the sole, toe toward +Y) ----
    f = Model("Foot")
    f.box((0.19, 0.34, 0.055), (0, 0.035, 0.0275), sole, bevel=0.022, segs=3)
    f.box((0.175, 0.3, 0.11), (0, 0.02, 0.1), tint, bevel=0.045, segs=3)
    f.sphere(0.088, (0, 0.14, 0.08), sole, scale=(1, 1, 0.75), u=12, v=8)
    f.cyl(0.062, 0.05, (0, -0.06, 0.16), dark, axis='Z', bevel=0.012)
    f.box((0.12, 0.03, 0.012), (0, 0.045, 0.148), sole, bevel=0.004)
    f.box((0.12, 0.03, 0.012), (0, 0.0, 0.148), sole, bevel=0.004)
    foot = f.finish(sharp=50)

    # ---- glove (origin at the palm) ----
    h = Model("Hand")
    h.sphere(0.074, (0, 0, 0), sole, scale=(1, 1.12, 0.92), u=14, v=10)
    h.sphere(0.03, (0.055, 0.035, 0.012), sole, u=8, v=6)
    h.torus(0.058, 0.02, (0, -0.058, 0), tint, axis='Y', segs=16, tube=6)
    hand = h.finish(sharp=50)
    return [body, foot, hand]


# ------------------------------------------------------------------------------------------
# Weapons. Grip sits near the origin, barrel points down +Y.
# ------------------------------------------------------------------------------------------
def gun_mats(accent_hex, name):
    return dict(
        dark=mat("GunDark", 0x2a2e39, 0.5), mid=mat("GunMid", 0x495164, 0.5), light=mat("GunLight", 0xa4aec0, 0.38),
        black=mat("GunBlack", 0x14161b, 0.6), wood=mat("GunWood", 0xa06c3d, 0.6),
        glow=mat("GunGlow", 0x7df9ff, 0.3, emit=2.5), acc=mat("Accent_" + name, accent_hex, 0.5),
    )


def build_rattler():
    c = gun_mats(0xf28c28, "rattler")
    m = Model("rattler")
    R = math.radians
    m.box((0.07, 0.36, 0.11), (0, 0.10, 0.03), c['dark'], bevel=0.014)                 # receiver
    m.box((0.046, 0.33, 0.022), (0, 0.11, 0.094), c['black'], bevel=0.006)             # top rail
    for i in range(6):
        m.box((0.05, 0.016, 0.01), (0, -0.02 + i * 0.05, 0.108), c['mid'], bevel=0.003)
    m.box((0.072, 0.25, 0.09), (0, 0.395, 0.03), c['acc'], bevel=0.02)                 # handguard
    for sx in (-1, 1):
        for i in range(3):
            m.box((0.012, 0.045, 0.028), (sx * 0.034, 0.32 + i * 0.07, 0.04), c['black'], bevel=0.005)
    m.cyl(0.017, 0.24, (0, 0.62, 0.04), c['light'], bevel=0.003)                        # barrel
    m.cyl(0.027, 0.07, (0, 0.74, 0.04), c['black'], bevel=0.008)                        # muzzle brake
    m.box((0.06, 0.02, 0.012), (0, 0.74, 0.04), c['mid'], bevel=0.003)
    m.box((0.014, 0.03, 0.06), (0, 0.5, 0.1), c['black'], bevel=0.004)                  # front sight
    m.box((0.036, 0.04, 0.04), (0, -0.045, 0.118), c['black'], bevel=0.006)             # rear sight
    m.box((0.02, 0.012, 0.016), (0, -0.045, 0.124), c['glow'], bevel=0.002)
    m.box((0.046, 0.08, 0.19), (0, 0.15, -0.105), c['mid'], rot=(R(14), 0, 0), bevel=0.012)   # magazine
    m.box((0.05, 0.085, 0.03), (0, 0.172, -0.2), c['acc'], rot=(R(14), 0, 0), bevel=0.008)
    m.box((0.046, 0.064, 0.14), (0, -0.045, -0.08), c['black'], rot=(R(-16), 0, 0), bevel=0.016)  # grip
    m.box((0.016, 0.1, 0.012), (0, 0.035, -0.058), c['dark'], bevel=0.004)             # trigger guard
    m.box((0.012, 0.014, 0.04), (0, 0.035, -0.035), c['light'], rot=(R(-15), 0, 0), bevel=0.004)
    m.box((0.05, 0.2, 0.06), (0, -0.19, 0.035), c['mid'], bevel=0.014)                  # stock arm
    m.box((0.056, 0.05, 0.15), (0, -0.305, 0.005), c['dark'], bevel=0.016)              # butt
    m.box((0.058, 0.014, 0.13), (0, -0.335, 0.005), c['black'], bevel=0.005)
    m.box((0.012, 0.07, 0.03), (0.037, 0.12, 0.05), c['light'], bevel=0.004)            # ejection port
    o = m.finish()
    empty("Muzzle", (0, 0.78, 0.04), o)
    return o


def build_scatter():
    c = gun_mats(0xd9432f, "scatter")
    m = Model("scatter")
    R = math.radians
    m.box((0.076, 0.3, 0.105), (0, 0.06, 0.03), c['dark'], bevel=0.016)                 # receiver
    m.box((0.014, 0.09, 0.035), (0.039, 0.07, 0.035), c['light'], bevel=0.004)          # loading port
    m.cyl(0.031, 0.52, (0, 0.44, 0.058), c['light'], bevel=0.004)                       # barrel
    m.cyl(0.024, 0.42, (0, 0.4, 0.0), c['mid'], bevel=0.004)                            # magazine tube
    m.lathe([(0.03, -0.09), (0.047, -0.08), (0.047, 0.08), (0.03, 0.09)], (0, 0.36, 0.0), c['acc'], segs=14)   # pump
    for i in range(5):
        m.torus(0.047, 0.006, (0, 0.3 + i * 0.03, 0.0), c['black'], axis='Y', segs=14, tube=6)
    m.cyl(0.038, 0.035, (0, 0.685, 0.058), c['black'], bevel=0.008)                     # muzzle ring
    m.box((0.05, 0.03, 0.06), (0, 0.6, 0.03), c['dark'], bevel=0.008)                   # barrel clamp
    m.sphere(0.012, (0, 0.68, 0.1), c['glow'], u=8, v=6)                                # bead
    m.box((0.052, 0.09, 0.13), (0, -0.075, -0.045), c['wood'], rot=(R(-28), 0, 0), bevel=0.02)   # grip
    m.box((0.056, 0.27, 0.085), (0, -0.24, -0.012), c['wood'], rot=(R(-7), 0, 0), bevel=0.022)   # stock
    m.box((0.06, 0.03, 0.115), (0, -0.385, -0.03), c['black'], rot=(R(-7), 0, 0), bevel=0.01)
    m.box((0.016, 0.1, 0.012), (0, 0.02, -0.04), c['dark'], bevel=0.004)
    m.box((0.012, 0.014, 0.035), (0, 0.02, -0.02), c['light'], rot=(R(-15), 0, 0), bevel=0.004)
    o = m.finish()
    empty("Muzzle", (0, 0.71, 0.058), o)
    return o


def build_longshot():
    c = gun_mats(0x27b8a8, "longshot")
    m = Model("longshot")
    R = math.radians
    m.box((0.062, 0.36, 0.09), (0, 0.06, 0.03), c['dark'], bevel=0.014)                 # receiver
    m.box((0.058, 0.26, 0.07), (0, 0.36, 0.022), c['acc'], bevel=0.018)                 # fore-end
    m.cyl(0.015, 0.62, (0, 0.72, 0.036), c['light'], bevel=0.003)                       # barrel
    m.box((0.05, 0.08, 0.04), (0, 1.01, 0.036), c['black'], bevel=0.008)                # brake
    for i in range(2):
        m.box((0.054, 0.012, 0.018), (0, 0.99 + i * 0.035, 0.036), c['mid'], bevel=0.003)
    # scope
    m.lathe([(0.03, -0.17), (0.04, -0.16), (0.04, -0.1), (0.027, -0.08), (0.027, 0.07), (0.044, 0.1), (0.044, 0.17), (0.036, 0.18)], (0, 0.09, 0.135), c['black'], segs=16)
    m.cyl(0.036, 0.006, (0, 0.268, 0.135), c['glow'], bevel=0)
    m.cyl(0.03, 0.006, (0, -0.078, 0.135), c['glow'], bevel=0)
    m.box((0.03, 0.035, 0.05), (0, 0.02, 0.09), c['mid'], bevel=0.006)
    m.box((0.03, 0.035, 0.05), (0, 0.15, 0.09), c['mid'], bevel=0.006)
    m.cyl(0.014, 0.03, (0, 0.09, 0.172), c['acc'], axis='Z', bevel=0.004)               # turret
    # bolt
    m.cyl(0.008, 0.06, (0.05, -0.02, 0.05), c['light'], axis='X', bevel=0.002)
    m.sphere(0.016, (0.085, -0.02, 0.05), c['black'], u=10, v=8)
    # grip, magazine, stock
    m.box((0.046, 0.062, 0.14), (0, -0.07, -0.075), c['black'], rot=(R(-16), 0, 0), bevel=0.016)
    m.box((0.044, 0.09, 0.07), (0, 0.11, -0.04), c['mid'], bevel=0.01)
    m.box((0.016, 0.1, 0.012), (0, 0.0, -0.05), c['dark'], bevel=0.004)
    m.box((0.012, 0.014, 0.035), (0, 0.0, -0.03), c['light'], rot=(R(-15), 0, 0), bevel=0.004)
    m.box((0.046, 0.3, 0.04), (0, -0.27, 0.045), c['mid'], bevel=0.012)
    m.box((0.04, 0.26, 0.03), (0, -0.27, -0.03), c['mid'], rot=(R(-14), 0, 0), bevel=0.01)
    m.box((0.054, 0.04, 0.16), (0, -0.425, 0.0), c['dark'], bevel=0.014)
    m.box((0.056, 0.014, 0.14), (0, -0.45, 0.0), c['black'], bevel=0.005)
    m.box((0.05, 0.14, 0.03), (0, -0.25, 0.078), c['acc'], bevel=0.012)                 # cheek rest
    # folded bipod
    for sx in (-1, 1):
        m.box((0.012, 0.2, 0.014), (sx * 0.022, 0.4, -0.022), c['black'], bevel=0.004)
    o = m.finish()
    empty("Muzzle", (0, 1.06, 0.036), o)
    return o


def build_thumper():
    c = gun_mats(0xf2c230, "thumper")
    m = Model("thumper")
    R = math.radians
    # tube with a hollow mouth
    m.lathe([(0.0, 0.5), (0.058, 0.5), (0.058, 0.58), (0.088, 0.58), (0.09, 0.5), (0.074, 0.47), (0.074, -0.1), (0.086, -0.12), (0.086, -0.19), (0.05, -0.2)],
            (0, 0, 0.055), c['dark'], segs=18)
    m.lathe([(0.076, -0.03), (0.08, -0.025), (0.08, 0.025), (0.076, 0.03)], (0, 0.4, 0.055), c['acc'], segs=18)   # bands
    m.lathe([(0.076, -0.02), (0.08, -0.015), (0.08, 0.015), (0.076, 0.02)], (0, 0.02, 0.055), c['acc'], segs=18)
    m.lathe([(0.088, -0.012), (0.092, -0.008), (0.092, 0.008), (0.088, 0.012)], (0, 0.55, 0.055), c['acc'], segs=18)
    m.cyl(0.05, 0.03, (0, -0.2, 0.055), c['black'], bevel=0.008)
    # grips and trigger housing
    m.box((0.05, 0.16, 0.05), (0, 0.06, -0.035), c['mid'], bevel=0.012)
    m.box((0.046, 0.062, 0.13), (0, 0.02, -0.11), c['black'], rot=(R(-14), 0, 0), bevel=0.016)
    m.cyl(0.024, 0.13, (0, 0.3, -0.07), c['black'], axis='Z', bevel=0.008)
    m.box((0.016, 0.09, 0.012), (0, 0.1, -0.075), c['dark'], bevel=0.004)
    # sight frame and shoulder pad
    m.box((0.014, 0.014, 0.09), (0.05, 0.2, 0.15), c['mid'], bevel=0.004)
    m.box((0.05, 0.012, 0.05), (0.05, 0.2, 0.2), c['black'], bevel=0.006)
    m.box((0.034, 0.008, 0.034), (0.05, 0.2, 0.2), c['glow'], bevel=0.003)
    m.box((0.07, 0.11, 0.05), (0, -0.07, -0.03), c['mid'], bevel=0.016)
    o = m.finish()
    empty("Muzzle", (0, 0.6, 0.055), o)
    return o


def build_sidearm():
    c = gun_mats(0x8e6cf0, "sidearm")
    m = Model("sidearm")
    R = math.radians
    m.box((0.046, 0.25, 0.058), (0, 0.09, 0.038), c['light'], bevel=0.012)              # slide
    for i in range(4):
        for sx in (-1, 1):
            m.box((0.006, 0.01, 0.04), (sx * 0.023, -0.005 + i * 0.018, 0.04), c['dark'], bevel=0.002)
    m.box((0.042, 0.21, 0.034), (0, 0.085, -0.004), c['dark'], bevel=0.01)              # frame
    m.box((0.044, 0.07, 0.14), (0, -0.012, -0.08), c['dark'], rot=(R(-13), 0, 0), bevel=0.016)   # grip
    m.box((0.048, 0.05, 0.09), (0, -0.012, -0.08), c['acc'], rot=(R(-13), 0, 0), bevel=0.012)
    m.cyl(0.013, 0.03, (0, 0.225, 0.04), c['black'], bevel=0.003)                       # barrel tip
    m.box((0.014, 0.085, 0.01), (0, 0.075, -0.05), c['dark'], bevel=0.003)              # guard
    m.box((0.01, 0.012, 0.03), (0, 0.065, -0.032), c['light'], rot=(R(-15), 0, 0), bevel=0.003)
    m.box((0.01, 0.014, 0.014), (0, 0.2, 0.072), c['glow'], bevel=0.002)                # sights
    m.box((0.03, 0.014, 0.014), (0, -0.02, 0.072), c['black'], bevel=0.003)
    o = m.finish()
    empty("Muzzle", (0, 0.245, 0.04), o)
    return o


# ------------------------------------------------------------------------------------------
# Projectiles and pickups
# ------------------------------------------------------------------------------------------
def build_jar():
    """Thumper round: a jar of brine flying lid-first."""
    glass = mat("JarGlass", 0xbfe8b0, 0.15, alpha=0.5)
    lid = mat("JarLid", 0xe2533c, 0.45)
    skin = mat("Pickle", 0x5c982d, 0.5)
    m = Model("Jar")
    m.lathe([(0.0, -0.11), (0.06, -0.11), (0.072, -0.095), (0.072, 0.05), (0.055, 0.075), (0.055, 0.09), (0.0, 0.09)], (0, 0, 0), glass, segs=14)
    m.lathe([(0.0, 0.085), (0.062, 0.085), (0.064, 0.09), (0.064, 0.12), (0.058, 0.128), (0.0, 0.128)], (0, 0, 0), lid, segs=14)
    tb, _ = pickle_body_bm(-0.08, 0.05, 0.022, segs=8, rings=6, bend=0.004, seed=3, bump=0.0)
    m.raw(tb, skin, loc=(0.02, 0, 0.01), rot=(math.radians(-80), 0, 0.3))
    tb, _ = pickle_body_bm(-0.08, 0.04, 0.02, segs=8, rings=6, bend=0.004, seed=4, bump=0.0)
    m.raw(tb, skin, loc=(-0.022, -0.01, -0.012), rot=(math.radians(-100), 0, -0.4))
    return m.finish(sharp=50)


def build_bomb():
    """Brine bomb: a little pickle with a grenade cap."""
    skin = mat("Pickle", 0x5c982d, 0.5)
    stripe = mat("PickleStripe", 0x86bb3c, 0.5)
    steel = mat("GunLight", 0xa4aec0, 0.38)
    dark = mat("GunDark", 0x2a2e39, 0.5)
    glow = mat("BombGlow", 0xff8a3c, 0.4, emit=2.5)
    m = Model("Bomb")
    tb, stripes = pickle_body_bm(-0.12, 0.09, 0.075, segs=12, rings=10, bend=0.006, stripe_every=3, seed=5, bump=0.03)
    si, bi = m._mi(stripe), m._mi(skin)
    bmesh.ops.recalc_face_normals(tb, faces=tb.faces[:])
    for f in tb.faces:
        f.material_index = si if f in stripes else bi
        f.smooth = True
    tmp = bpy.data.meshes.new("tmp"); tb.to_mesh(tmp); tb.free(); m.bm.from_mesh(tmp); bpy.data.meshes.remove(tmp)
    m.cyl(0.04, 0.035, (0, 0, 0.1), dark, axis='Z', bevel=0.008)
    m.cyl(0.022, 0.03, (0, 0, 0.13), steel, axis='Z', bevel=0.005)
    m.box((0.022, 0.012, 0.12), (0.045, 0, 0.07), steel, rot=(0, math.radians(14), 0), bevel=0.004)
    m.torus(0.026, 0.006, (-0.04, 0, 0.14), steel, axis='Y', segs=14, tube=6)
    m.sphere(0.016, (0, 0, 0.152), glow, u=8, v=6)
    return m.finish(sharp=50)


def build_pickups():
    glass = mat("JarGlass", 0xbfe8b0, 0.15, alpha=0.5)
    lid = mat("LidGreen", 0x3fbf63, 0.45)
    label = mat("Label", 0xf7f5ee, 0.6)
    cross = mat("CrossGreen", 0x2fc45f, 0.5, emit=0.8)
    brine = mat("Brine", 0x9be38a, 0.3, emit=0.5)
    m = Model("HealthJar")
    m.lathe([(0.0, 0.0), (0.15, 0.0), (0.18, 0.03), (0.18, 0.3), (0.13, 0.36), (0.13, 0.39), (0.0, 0.39)], (0, 0, 0), glass, axis='Z', segs=18)
    m.lathe([(0.0, 0.02), (0.16, 0.02), (0.165, 0.05), (0.165, 0.24), (0.0, 0.24)], (0, 0, 0), brine, axis='Z', segs=18)
    m.lathe([(0.0, 0.385), (0.14, 0.385), (0.145, 0.395), (0.145, 0.44), (0.135, 0.45), (0.0, 0.45)], (0, 0, 0), lid, axis='Z', segs=18)
    for a in (0, math.pi):
        ca, sa = math.cos(a + math.pi / 2), math.sin(a + math.pi / 2)
        m.box((0.2, 0.012, 0.2), (ca * 0.178, sa * 0.178, 0.17), label, rot=(0, 0, a), bevel=0.004)
        m.box((0.14, 0.02, 0.045), (ca * 0.186, sa * 0.186, 0.17), cross, rot=(0, 0, a), bevel=0.006)
        m.box((0.045, 0.02, 0.14), (ca * 0.186, sa * 0.186, 0.17), cross, rot=(0, 0, a), bevel=0.006)
    jar = m.finish(sharp=50)

    wood = mat("CrateWood", 0xb07a43, 0.7)
    wood2 = mat("CrateWoodDark", 0x8a5c30, 0.7)
    steel = mat("GunDark", 0x2a2e39, 0.5)
    amber = mat("CrateAmber", 0xffc04a, 0.5, emit=0.6)
    c = Model("AmmoCrate")
    c.box((0.42, 0.3, 0.26), (0, 0, 0.13), wood, bevel=0.012)
    for sx in (-1, 1):
        c.box((0.05, 0.315, 0.275), (sx * 0.15, 0, 0.13), steel, bevel=0.008)
    for i in range(3):
        c.box((0.24, 0.31, 0.012), (0, 0, 0.06 + i * 0.07), wood2, bevel=0.003)
    c.box((0.44, 0.32, 0.03), (0, 0, 0.262), wood2, bevel=0.01)
    for sy in (-1, 1):
        c.box((0.1, 0.012, 0.1), (0, sy * 0.152, 0.13), amber, bevel=0.01)
    crate = c.finish()
    return [jar, crate]


# ------------------------------------------------------------------------------------------
BUILDERS = {
    'pickle': build_pickle,
    'rattler': build_rattler, 'scatter': build_scatter, 'longshot': build_longshot,
    'thumper': build_thumper, 'sidearm': build_sidearm,
    'jar': build_jar, 'bomb': build_bomb, 'pickups': build_pickups,
}


# ------------------------------------------------------------------------------------------
# Arena props. Origin at the base centre, front faces -Y (which becomes +Z in the game).
# ------------------------------------------------------------------------------------------
def text_bm(text, size=0.5, extrude=0.02):
    cu = bpy.data.curves.new("txt", 'FONT')
    cu.body = text; cu.size = size; cu.extrude = extrude
    cu.align_x = 'CENTER'; cu.align_y = 'CENTER'
    ob = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    tb = bmesh.new(); tb.from_mesh(me)
    bpy.data.meshes.remove(me); bpy.data.objects.remove(ob); bpy.data.curves.remove(cu)
    return tb


def lying_pickle(m, skin, loc, length, r, yaw, seed, roll=0.0):
    tb, _ = pickle_body_bm(-length / 2, length / 2, r, segs=8, rings=6, bend=r * 0.25, seed=seed, bump=0.03)
    m.raw(tb, skin, loc=loc, rot=(math.radians(90), roll, yaw))


def build_props():
    R = math.radians
    wood = mat("PropWood", 0xb9824a, 0.7); wood_d = mat("PropWoodDark", 0x7d5230, 0.7)
    steel = mat("PropSteel", 0x9aa6ba, 0.35); steel_d = mat("PropSteelDark", 0x3a4050, 0.5)
    glass = mat("JarGlass", 0xbfe8b0, 0.15, alpha=0.5)
    lid_r = mat("JarLid", 0xe2533c, 0.45)
    brine = mat("Brine", 0x9be38a, 0.3, emit=0.5)
    skin = mat("Pickle", 0x5c982d, 0.5)
    label = mat("Label", 0xf7f5ee, 0.6)
    green_d = mat("SignGreen", 0x1f5a2a, 0.6)
    yellow = mat("SignYellow", 0xffd23f, 0.5, emit=1.4)
    terra = mat("Terracotta", 0xc8663c, 0.7)
    leaf = mat("Leaf", 0x4fa83a, 0.6); leaf2 = mat("LeafLight", 0x86d24a, 0.6)
    red = mat("AwningRed", 0xd9432f, 0.6); white = mat("AwningWhite", 0xf4efe4, 0.6)
    ketchup = mat("Ketchup", 0xd2362a, 0.4); mustard = mat("Mustard", 0xf2c230, 0.4)
    warm = mat("LampGlow", 0xffd98a, 0.4, emit=4.0)
    made = []

    # ---- brine barrel ----
    m = Model("Barrel"); m.flat = True
    m.lathe([(0.0, 0.0), (0.34, 0.0), (0.405, 0.22), (0.43, 0.5), (0.405, 0.78), (0.34, 1.0), (0.3, 1.0), (0.3, 0.93), (0.0, 0.93)], (0, 0, 0), wood, axis='Z', segs=14)
    m.flat = False
    for z, r in ((0.14, 0.385), (0.5, 0.432), (0.86, 0.385)):
        m.lathe([(r + 0.006, z - 0.04), (r + 0.02, z - 0.03), (r + 0.02, z + 0.03), (r + 0.006, z + 0.04)], (0, 0, 0), steel_d, axis='Z', segs=14)
    m.lathe([(0.0, 0.935), (0.297, 0.935), (0.297, 0.955), (0.0, 0.955)], (0, 0, 0), brine, axis='Z', segs=14)
    lying_pickle(m, skin, (0.06, 0.03, 0.965), 0.3, 0.05, 0.6, 21)
    lying_pickle(m, skin, (-0.08, -0.07, 0.96), 0.26, 0.045, -0.9, 22)
    made.append(m.finish(sharp=45))

    # ---- big pickle jar ----
    m = Model("JarBig")
    for i, (x, y, yaw) in enumerate(((0.12, 0.05, 0.2), (-0.13, 0.08, -0.3), (0.0, -0.14, 0.1), (-0.02, 0.18, 0.4))):
        tb, _ = pickle_body_bm(0.06, 0.78, 0.105, segs=10, rings=8, bend=0.02, seed=30 + i, bump=0.03)
        m.raw(tb, skin, loc=(x, y, 0), rot=(R(4 * (i - 1)), R(5), yaw))
    m.lathe([(0.0, 0.0), (0.36, 0.0), (0.42, 0.06), (0.42, 0.85), (0.3, 1.0), (0.3, 1.08), (0.0, 1.08)], (0, 0, 0), glass, axis='Z', segs=18)
    m.lathe([(0.0, 1.07), (0.32, 1.07), (0.335, 1.09), (0.335, 1.2), (0.31, 1.23), (0.0, 1.23)], (0, 0, 0), lid_r, axis='Z', segs=18)
    m.lathe([(0.423, 0.28), (0.428, 0.29), (0.428, 0.6), (0.423, 0.61)], (0, 0, 0), label, axis='Z', segs=18)
    for a in (0, math.pi):
        m.sphere(0.1, (math.sin(a) * 0.0, -math.cos(a) * 0.43, 0.445), skin, scale=(1.5, 0.12, 0.8), u=12, v=8)
    made.append(m.finish(sharp=50))

    # ---- crate of cucumbers ----
    m = Model("Crate")
    m.box((0.9, 0.9, 0.06), (0, 0, 0.03), wood_d, bevel=0.01)
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        m.box((0.075, 0.075, 0.5), (sx * 0.41, sy * 0.41, 0.25), wood_d, bevel=0.01)
    for z in (0.15, 0.37):
        for sgn in (-1, 1):
            m.box((0.86, 0.045, 0.16), (0, sgn * 0.425, z), wood, bevel=0.01)
            m.box((0.045, 0.86, 0.16), (sgn * 0.425, 0, z), wood, bevel=0.01)
    rnd = random.Random(5)
    for i in range(9):
        lying_pickle(m, skin, (rnd.uniform(-0.08, 0.08), -0.3 + (i % 5) * 0.15, 0.36 + (i // 5) * 0.13), rnd.uniform(0.6, 0.72), 0.07, R(90) + rnd.uniform(-0.25, 0.25), 40 + i)
    made.append(m.finish(sharp=45))

    # ---- potted dill ----
    m = Model("DillPot")
    m.lathe([(0.0, 0.0), (0.16, 0.0), (0.22, 0.3), (0.245, 0.3), (0.245, 0.37), (0.19, 0.37), (0.19, 0.33), (0.0, 0.33)], (0, 0, 0), terra, axis='Z', segs=12)
    rnd = random.Random(9)
    for i in range(9):
        a = i / 9 * 2 * math.pi + rnd.uniform(-0.2, 0.2)
        tilt = rnd.uniform(0.12, 0.5)
        h = rnd.uniform(0.45, 0.8)
        dx, dy = math.cos(a) * math.sin(tilt), math.sin(a) * math.sin(tilt)
        top = (dx * h, dy * h, 0.33 + math.cos(tilt) * h)
        m.box((0.02, 0.02, h), (dx * h / 2, dy * h / 2, 0.33 + math.cos(tilt) * h / 2), leaf, rot=(-math.sin(a) * tilt, math.cos(a) * tilt, 0), bevel=0)
        m.sphere(0.13, top, leaf2 if i % 2 else leaf, scale=(1, 1, 0.3), u=8, v=5)
        m.sphere(0.07, (top[0] * 0.6, top[1] * 0.6, top[2] - 0.16), leaf, scale=(1, 1, 0.4), u=6, v=4)
    made.append(m.finish(sharp=50))

    # ---- market stall (2 wide) ----
    m = Model("Stall")
    m.box((1.9, 0.82, 0.1), (0, 0, 0.95), wood, bevel=0.015)
    m.box((1.84, 0.06, 0.9), (0, -0.36, 0.45), wood_d, bevel=0.01)
    for i in range(5):
        m.box((0.3, 0.02, 0.8), (-0.68 + i * 0.34, -0.395, 0.45), wood, bevel=0.008)
    for sx in (-1, 1):
        m.box((0.06, 0.76, 0.9), (sx * 0.9, 0, 0.45), wood_d, bevel=0.01)
        for sy in (-1, 1):
            m.box((0.07, 0.07, 2.35), (sx * 0.9, sy * 0.36, 1.175), wood_d, bevel=0.01)
    for i in range(6):
        m.box((0.345, 1.3, 0.045), (-0.86 + i * 0.345, -0.12, 2.32), red if i % 2 == 0 else white, rot=(R(13), 0, 0), bevel=0.01)
        m.box((0.345, 0.03, 0.2), (-0.86 + i * 0.345, -0.76, 2.08), white if i % 2 == 0 else red, bevel=0.008)
    for i, x in enumerate((-0.6, -0.25, 0.1)):                                       # jars on the counter
        m.lathe([(0.0, 0.0), (0.1, 0.0), (0.115, 0.02), (0.115, 0.22), (0.08, 0.27), (0.0, 0.27)], (x, -0.12, 1.0), glass, axis='Z', segs=10)
        m.lathe([(0.0, 0.265), (0.09, 0.265), (0.09, 0.31), (0.0, 0.31)], (x, -0.12, 1.0), lid_r if i != 1 else mustard, axis='Z', segs=10)
        tb, _ = pickle_body_bm(0.02, 0.22, 0.04, segs=6, rings=5, bend=0.005, seed=60 + i, bump=0.0)
        m.raw(tb, skin, loc=(x, -0.12, 1.0))
    m.box((0.5, 0.4, 0.2), (0.55, 0.05, 1.1), wood_d, bevel=0.015)
    for i in range(4):
        lying_pickle(m, skin, (0.55, -0.08 + i * 0.09, 1.23), 0.42, 0.05, R(90) + 0.1 * (i - 1.5), 70 + i)
    made.append(m.finish(sharp=45))

    # ---- brine vat (2 x 2) ----
    m = Model("Vat")
    m.lathe([(0.0, 0.0), (0.9, 0.0), (0.95, 0.06), (0.95, 1.4), (0.995, 1.42), (0.995, 1.5), (0.88, 1.5), (0.88, 1.38), (0.0, 1.38)], (0, 0, 0), steel, axis='Z', segs=22)
    for z in (0.3, 0.95):
        m.lathe([(0.952, z - 0.05), (0.975, z - 0.04), (0.975, z + 0.04), (0.952, z + 0.05)], (0, 0, 0), steel_d, axis='Z', segs=22)
    m.lathe([(0.0, 1.39), (0.878, 1.39), (0.878, 1.43), (0.0, 1.43)], (0, 0, 0), brine, axis='Z', segs=22)
    for i, (x, y, yaw) in enumerate(((0.3, 0.2, 0.4), (-0.35, -0.1, -0.7), (0.05, -0.45, 1.2), (-0.2, 0.5, 2.0))):
        lying_pickle(m, skin, (x, y, 1.45), 0.5, 0.085, yaw, 80 + i)
    m.cyl(0.07, 1.9, (0.72, 0.72, 0.95), steel_d, axis='Z', segs=10, bevel=0.01)                 # feed pipe
    m.sphere(0.085, (0.72, 0.72, 1.9), steel_d, u=10, v=8)
    m.cyl(0.07, 0.5, (0.54, 0.54, 1.9), steel_d, axis='X', segs=10, bevel=0.01, rot=(0, 0, R(45)))
    m.torus(0.13, 0.025, (0.72, 0.72, 0.9), ketchup, axis='X', segs=14, tube=6, rot=(0, 0, R(-45)))
    m.cyl(0.14, 0.05, (0, -0.97, 1.0), steel_d, axis='Y', segs=14, bevel=0.01)                  # gauge
    m.cyl(0.11, 0.02, (0, -1.0, 1.0), label, axis='Y', segs=14, bevel=0)
    m.box((0.016, 0.02, 0.09), (0.02, -1.012, 1.03), ketchup, rot=(0, R(35), 0), bevel=0)
    for sx in (-1, 1):                                                                 # ladder
        m.box((0.04, 0.04, 1.6), (sx * 0.2, 1.0, 0.8), steel_d, bevel=0.008)
    for i in range(5):
        m.box((0.4, 0.03, 0.03), (0, 1.0, 0.25 + i * 0.3), steel_d, bevel=0.006)
    made.append(m.finish(sharp=45))

    # ---- lamp post ----
    m = Model("Lamp")
    m.cyl(0.13, 0.14, (0, 0, 0.07), steel_d, axis='Z', segs=10, bevel=0.02)
    m.cyl(0.035, 2.4, (0, 0, 1.3), steel_d, axis='Z', segs=8, bevel=0.005)
    m.box((0.04, 0.4, 0.04), (0, -0.18, 2.5), steel_d, bevel=0.008)
    m.box((0.24, 0.24, 0.05), (0, -0.36, 2.42), steel_d, bevel=0.012)
    m.sphere(0.11, (0, -0.36, 2.3), warm, u=10, v=8)
    m.box((0.2, 0.2, 0.03), (0, -0.36, 2.17), steel_d, bevel=0.008)
    made.append(m.finish(sharp=45))

    # ---- signs ----
    for name, text, size, w in (("Sign", "PICKLE OPS", 0.5, 3.5), ("SignBrine", "FRESH BRINE", 0.44, 3.5)):
        m = Model(name)
        m.box((w, 0.1, 1.15), (0, 0, 0), green_d, bevel=0.04)
        m.box((w - 0.16, 0.02, 0.05), (0, -0.055, 0.49), yellow, bevel=0.01)
        m.box((w - 0.16, 0.02, 0.05), (0, -0.055, -0.49), yellow, bevel=0.01)
        for sx in (-1, 1):
            m.box((0.05, 0.02, 0.93), (sx * (w / 2 - 0.105), -0.055, 0), yellow, bevel=0.01)
            tb, _ = pickle_body_bm(-0.3, 0.3, 0.1, segs=10, rings=8, bend=0.02, seed=90, bump=0.03)
            m.raw(tb, skin, loc=(sx * (w / 2 - 0.36), -0.08, 0), rot=(0, R(sx * 18), 0))
        tb = text_bm(text, size=size, extrude=0.025)
        m.flat = True
        m.raw(tb, yellow, loc=(0, -0.07, -0.02), rot=(R(90), 0, 0))
        m.flat = False
        made.append(m.finish(sharp=45))

    # ---- squeeze bottles (used giant, as scenery) ----
    for name, col in (("BottleRed", ketchup), ("BottleYellow", mustard)):
        m = Model(name)
        m.lathe([(0.0, 0.0), (0.2, 0.0), (0.24, 0.05), (0.24, 0.56), (0.2, 0.69), (0.1, 0.79), (0.1, 0.83), (0.0, 0.83)], (0, 0, 0), col, axis='Z', segs=18)
        m.lathe([(0.0, 0.81), (0.115, 0.81), (0.12, 0.83), (0.12, 0.9), (0.05, 0.98), (0.03, 1.1), (0.0, 1.1)], (0, 0, 0), label, axis='Z', segs=14)
        m.lathe([(0.242, 0.2), (0.246, 0.21), (0.246, 0.46), (0.242, 0.47)], (0, 0, 0), label, axis='Z', segs=18)
        m.sphere(0.07, (0, -0.245, 0.335), col, scale=(1, 0.12, 1), u=12, v=8)
        made.append(m.finish(sharp=50))

    # ---- fork (used giant, as scenery) ----
    m = Model("Fork")
    m.box((0.09, 0.03, 0.62), (0, 0, 0.31), steel, bevel=0.012)
    m.box((0.065, 0.028, 0.14), (0, 0, 0.67), steel, bevel=0.01)
    m.box((0.21, 0.028, 0.1), (0, 0, 0.77), steel, bevel=0.012)
    for x in (-0.09, -0.03, 0.03, 0.09):
        m.box((0.03, 0.024, 0.27), (x, 0, 0.93), steel, bevel=0.01)
    made.append(m.finish(sharp=45))
    return made


BUILDERS['props'] = build_props


# ------------------------------------------------------------------------------------------
# Building blocks. Every arena is assembled from these. A "cube" fills 1 x 1 x 1 and a "slab"
# 1 x 1 x 0.5; origin at the base centre. Materials named Kit* are white-ish and get tinted per
# block by the game (so one crate model can be any wood colour); Fix* keep their own colour.
# ------------------------------------------------------------------------------------------
def build_blocks():
    R = math.radians
    main = mat("KitMain", 0xf4f4f4, 0.72); shade = mat("KitShade", 0xb2b2b2, 0.78); dark = mat("KitDark", 0x6a6a6a, 0.82)
    mortar = mat("FixMortar", 0x3a3531, 0.9); tin = mat("FixTin", 0xc0c9d8, 0.35); fdark = mat("FixDark", 0x1e2128, 0.8)
    out = []
    both = lambda kit: ((kit + "_cube", 1.0), (kit + "_slab", 0.5))

    # brick: four courses to the cube, alternate courses offset by half a brick
    for name, H in both("Brick"):
        m = Model(name)
        m.box((0.955, 0.955, H - 0.02), (0, 0, H / 2), mortar, bevel=0)
        n = int(H / 0.25)
        for k in range(n):
            cuts = [(-0.25, 0.5), (0.25, 0.5)] if k % 2 == 0 else [(-0.375, 0.25), (0.0, 0.5), (0.375, 0.25)]
            for i, (cx, wx) in enumerate(cuts):
                for j, (cy, wy) in enumerate(cuts):
                    if k < n - 1 and len(cuts) == 3 and i == 1 and j == 1:
                        continue                                        # hidden middle brick
                    m.box((wx - 0.024, wy - 0.024, 0.226), (cx, cy, 0.125 + k * 0.25), shade if (i + j + k) % 3 == 0 else main, bevel=0)
        out.append(m.finish())

    # dressed stone: big bevelled blocks
    for name, H in both("Stone"):
        m = Model(name)
        m.box((0.95, 0.95, H - 0.02), (0, 0, H / 2), mortar, bevel=0)
        if H == 1.0:
            m.box((0.985, 0.985, 0.485), (0, 0, 0.25), main, bevel=0.035, segs=1)
            for sx in (-1, 1):
                m.box((0.485, 0.985, 0.485), (sx * 0.25, 0, 0.75), shade if sx < 0 else main, bevel=0.035, segs=1)
        else:
            for sy in (-1, 1):
                m.box((0.985, 0.485, 0.485), (0, sy * 0.25, 0.25), shade if sy > 0 else main, bevel=0.035, segs=1)
        out.append(m.finish())

    # wooden crate: frame, panels, diagonal braces
    for name, H in both("Crate"):
        m = Model(name)
        b = 0.1
        m.box((0.9, 0.9, H - 0.06), (0, 0, H / 2), main, bevel=0)
        for sx in (-1, 1):
            for sy in (-1, 1):
                m.box((b, b, H), (sx * (0.5 - b / 2), sy * (0.5 - b / 2), H / 2), shade, bevel=0)
        for z in (b / 2, H - b / 2):
            for sg in (-1, 1):
                m.box((1 - 2 * b, b, b), (0, sg * (0.5 - b / 2), z), shade, bevel=0)
                m.box((b, 1 - 2 * b, b), (sg * (0.5 - b / 2), 0, z), shade, bevel=0)
        if H == 1.0:
            for sg in (-1, 1):
                m.box((1.08, 0.035, 0.09), (0, sg * 0.462, 0.5), dark, rot=(0, R(45 * sg), 0), bevel=0)
                m.box((0.035, 1.08, 0.09), (sg * 0.462, 0, 0.5), dark, rot=(R(45 * sg), 0, 0), bevel=0)
        for i in range(3):
            m.box((0.24, 0.78, 0.012), (-0.27 + i * 0.27, 0, H - 0.026), shade if i == 1 else main, bevel=0)
        out.append(m.finish())

    # shipping container: ribbed sides, frame rails
    for name, H in both("Container"):
        m = Model(name)
        m.box((0.93, 0.93, H - 0.01), (0, 0, H / 2), main, bevel=0)
        for i in range(4):
            off = -0.3 + i * 0.2
            for sg in (-1, 1):
                m.box((0.09, 0.04, H - 0.16), (off, sg * 0.475, H / 2), shade, bevel=0)
                m.box((0.04, 0.09, H - 0.16), (sg * 0.475, off, H / 2), shade, bevel=0)
        for z in (0.04, H - 0.04):
            for sg in (-1, 1):
                m.box((1.0, 0.075, 0.08), (0, sg * 0.4625, z), dark, bevel=0)
                m.box((0.075, 0.85, 0.08), (sg * 0.4625, 0, z), dark, bevel=0)
        for sx in (-1, 1):
            for sy in (-1, 1):
                m.box((0.075, 0.075, H - 0.16), (sx * 0.4625, sy * 0.4625, H / 2), dark, bevel=0)
        out.append(m.finish())

    # steel platform: tread plate on a braced frame
    for name, H in both("Steel"):
        m = Model(name)
        m.box((0.99, 0.99, 0.09), (0, 0, H - 0.045), main, bevel=0.018, segs=1)
        for i in range(3):
            m.box((0.8, 0.07, 0.012), (0, -0.26 + i * 0.26, H + 0.002), shade, bevel=0)
        m.box((0.84, 0.84, H - 0.09), (0, 0, (H - 0.09) / 2), dark, bevel=0)
        for sx in (-1, 1):
            for sy in (-1, 1):
                m.box((0.12, 0.12, H - 0.09), (sx * 0.43, sy * 0.43, (H - 0.09) / 2), shade, bevel=0)
        if H == 1.0:
            for sg in (-1, 1):
                for t in (-1, 1):
                    m.box((1.1, 0.03, 0.06), (0, sg * 0.45, 0.455), shade, rot=(0, R(40 * t), 0), bevel=0)
                    m.box((0.03, 1.1, 0.06), (sg * 0.45, 0, 0.455), shade, rot=(R(40 * t), 0, 0), bevel=0)
        out.append(m.finish())

    # stacked timber: thick boards, every other one set back a little
    for name, H in both("Planks"):
        m = Model(name)
        for k in range(int(H / 0.25)):
            inset = 0.0 if k % 2 == 0 else 0.035
            m.box((0.99 - inset, 0.99 - inset, 0.242), (0, 0, 0.125 + k * 0.25), main if k % 2 == 0 else shade, bevel=0.016, segs=1)
        for i in range(3):
            m.box((0.31, 0.95, 0.014), (-0.325 + i * 0.325, 0, H - 0.004), main if i != 1 else shade, bevel=0)
        out.append(m.finish())

    # tin can: ribbed rims, tinted label with a pickle on it
    for name, H in both("Can"):
        m = Model(name)
        m.lathe([(0.0, 0.0), (0.47, 0.0), (0.492, 0.02), (0.492, 0.07), (0.466, 0.09), (0.466, H - 0.09), (0.492, H - 0.07), (0.492, H - 0.02),
                 (0.45, H - 0.02), (0.45, H - 0.055), (0.0, H - 0.055)], (0, 0, 0), tin, axis='Z', segs=14)
        m.lathe([(0.467, 0.13), (0.474, 0.14), (0.474, H - 0.14), (0.467, H - 0.13)], (0, 0, 0), main, axis='Z', segs=14)
        m.lathe([(0.2, H - 0.055), (0.22, H - 0.04), (0.27, H - 0.04), (0.29, H - 0.055)], (0, 0, 0), tin, axis='Z', segs=14)
        for a in (0.0, math.pi / 2, math.pi, -math.pi / 2):
            m.sphere(0.1, (math.sin(a) * 0.468, -math.cos(a) * 0.468, H / 2), dark, scale=(1.5 if H == 1.0 else 1.2, 0.1, 0.9 if H == 1.0 else 0.45), u=8, v=6, rot=(0, 0, a))
        out.append(m.finish(sharp=50))

    # cheese: rounded block with holes
    rnd = random.Random(3)
    for name, H in both("Cheese"):
        m = Model(name)
        m.box((0.985, 0.985, H - 0.004), (0, 0, H / 2), main, bevel=0.05, segs=2)
        for side in range(4):
            for _ in range(2):
                r = rnd.uniform(0.06, 0.13)
                u, v = rnd.uniform(-0.3, 0.3), rnd.uniform(0.14, H - 0.14)
                a = side * math.pi / 2
                m.cyl(r, 0.03, (math.cos(a) * 0.482 - math.sin(a) * u, math.sin(a) * 0.482 + math.cos(a) * u, v), shade, axis='X', segs=8, bevel=0, rot=(0, 0, a))
        for _ in range(2):
            m.cyl(rnd.uniform(0.07, 0.13), 0.03, (rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), H - 0.012), shade, axis='Z', segs=8, bevel=0)
        out.append(m.finish(sharp=50))

    # cinder blocks: two to a course, courses turned ninety degrees
    for name, H in both("Cinder"):
        m = Model(name)
        m.box((0.95, 0.95, H - 0.02), (0, 0, H / 2), mortar, bevel=0)
        n = int(H / 0.5)
        for k in range(n):
            for sg in (-1, 1):
                along_x = (k % 2 == 0)
                size = (0.485, 0.985, 0.485) if along_x else (0.985, 0.485, 0.485)
                loc = (sg * 0.25, 0, 0.25 + k * 0.5) if along_x else (0, sg * 0.25, 0.25 + k * 0.5)
                m.box(size, loc, main, bevel=0.022, segs=1)
                if k == n - 1:
                    for t in (-1, 1):
                        slot = (0.2, 0.26, 0.012) if along_x else (0.26, 0.2, 0.012)
                        sl = (sg * 0.25, t * 0.22, H - 0.004) if along_x else (t * 0.22, sg * 0.25, H - 0.004)
                        m.box(slot, sl, fdark, bevel=0)
        out.append(m.finish())

    # floors: they fill the bottom half-cell, so the top sits at 0.5
    m = Model("FloorTile")
    m.box((0.985, 0.985, 0.12), (0, 0, 0.44), main, bevel=0.016, segs=1)
    out.append(m.finish())
    m = Model("FloorPaver")
    for sg in (-1, 1):
        m.box((0.985, 0.485, 0.12), (0, sg * 0.25, 0.44), main if sg < 0 else shade, bevel=0.016, segs=1)
    out.append(m.finish())
    return out


BUILDERS['blocks'] = build_blocks


# ------------------------------------------------------------------------------------------
# Christmas (xmas.glb): the props and kit blocks of the holiday arena, and the Santa hat every
# fighter wears there. Same conventions as the props above: origin at the base centre, front -Y.
# ------------------------------------------------------------------------------------------
def sweep_bm(pts, radii, segs=12, key=None, caps=(True, True), step=0.04):
    """A tube along `pts` with one radius per point. `key(s, angle)` sorts the faces into
    separate bmeshes (stripes); returns {key: bmesh}. Faces are wound outward, so pass
    recalc=False to Model.raw for the open stripe pieces."""
    pts = [Vector(p) for p in pts]
    if key and step:                                       # resample finely so stripe edges stay smooth
        fine, frad = [pts[0]], [radii[0]]
        for i in range(1, len(pts)):
            k = max(1, int(math.ceil((pts[i] - pts[i - 1]).length / step)))
            for j in range(1, k + 1):
                fine.append(pts[i - 1].lerp(pts[i], j / k)); frad.append(radii[i - 1] + (radii[i] - radii[i - 1]) * j / k)
        pts, radii = fine, frad
    n = len(pts)
    T = [(pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized() for i in range(n)]
    up = Vector((0, 0, 1)) if abs(T[0].z) < 0.9 else Vector((1, 0, 0))
    N = [(up - T[0] * up.dot(T[0])).normalized()]
    for i in range(1, n):
        N.append((N[-1] - T[i] * N[-1].dot(T[i])).normalized())
    s = [0.0]
    for i in range(1, n):
        s.append(s[-1] + (pts[i] - pts[i - 1]).length)
    tb = bmesh.new()
    rings = []
    for i in range(n):
        Bv = T[i].cross(N[i])
        rings.append([tb.verts.new(pts[i] + radii[i] * (math.cos(2 * math.pi * j / segs) * N[i] + math.sin(2 * math.pi * j / segs) * Bv))
                      for j in range(segs)])
    keys = []
    for i in range(n - 1):
        for j in range(segs):
            k = (j + 1) % segs
            tb.faces.new((rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]))
            keys.append(key((s[i] + s[i + 1]) / 2, 2 * math.pi * (j + 0.5) / segs) if key else 0)
    if caps[0] and radii[0] > 1e-5:
        tb.faces.new(list(reversed(rings[0])))
        keys.append(keys[0])
    if caps[1] and radii[-1] > 1e-5:
        tb.faces.new(rings[-1])
        keys.append(keys[-segs - (1 if caps[0] and radii[0] > 1e-5 else 0)])
    out = {}
    for kv in sorted(set(keys)):
        c = tb.copy()
        c.faces.ensure_lookup_table()
        bmesh.ops.delete(c, geom=[c.faces[i] for i, kk in enumerate(keys) if kk != kv], context='FACES')
        bmesh.ops.delete(c, geom=[v for v in c.verts if not v.link_faces], context='VERTS')
        out[kv] = c
    tb.free()
    return out


def add_sweep(m, mats, pts, radii, segs=12, key=None, caps=(True, True), loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    for k, tb in sweep_bm(pts, radii, segs, key, caps).items():
        m.raw(tb, mats[k], loc=loc, rot=rot, scale=scale, recalc=False)


def helix_key(pitch, n=2):
    return lambda s, a: int(math.floor((s / pitch + a / (2 * math.pi)) * n)) % n


def star_bm(r_out, r_in, depth, points=5):
    """A chunky star facing -Y, centred on the origin."""
    tb = bmesh.new()
    cf, cb = tb.verts.new((0, -depth / 2, 0)), tb.verts.new((0, depth / 2, 0))
    ring_f, ring_b = [], []
    for i in range(points * 2):
        a = math.pi / 2 + i * math.pi / points
        r = r_out if i % 2 == 0 else r_in
        ring_f.append(tb.verts.new((r * math.cos(a), -depth * 0.18, r * math.sin(a))))
        ring_b.append(tb.verts.new((r * math.cos(a), depth * 0.18, r * math.sin(a))))
    k = len(ring_f)
    for i in range(k):
        j = (i + 1) % k
        tb.faces.new((cf, ring_f[j], ring_f[i]))
        tb.faces.new((cb, ring_b[i], ring_b[j]))
        tb.faces.new((ring_f[i], ring_f[j], ring_b[j], ring_b[i]))
    return tb


def tier_bm(z0, z1, r, segs=14, droop=0.1, jag=0.8, turn=0.0):
    """One layer of a fir: a cone whose rim zigzags in and out, the outer points hanging lower."""
    tb = bmesh.new()
    top = tb.verts.new((0, 0, z1))
    under = tb.verts.new((0, 0, z0 + (z1 - z0) * 0.18))
    rim = []
    for j in range(segs):
        a = 2 * math.pi * j / segs + turn
        rr, zz = (r, z0 - droop) if j % 2 == 0 else (r * jag, z0)
        rim.append(tb.verts.new((rr * math.cos(a), rr * math.sin(a), zz)))
    for j in range(segs):
        k = (j + 1) % segs
        tb.faces.new((rim[j], rim[k], top))
        tb.faces.new((rim[k], rim[j], under))
    return tb


def fir(m, tiers, mats, rnd, ornaments=20, lights=40, turns=4.0, orn_r=0.07, bulb_r=0.035):
    """tiers: [(z0, z1, r), ...] bottom to top. Adds the cones, baubles and a spiral of fairy lights."""
    pine, pine2 = mats['pine'], mats['pine2']
    for i, (z0, z1, r) in enumerate(tiers):
        turn = i * 0.4
        segs = 14 if r < 1.5 else 18
        m.raw(tier_bm(z0, z1, r, segs=segs, droop=r * 0.12, turn=turn), pine if i % 2 == 0 else pine2)

    def env(z):
        best = 0.0
        for (z0, z1, r) in tiers:
            if z0 - 0.05 <= z <= z1:
                best = max(best, r * (z1 - z) / (z1 - z0))
        return best

    zb, zt = tiers[0][0] + 0.1, tiers[-1][1] - 0.25
    orn = mats['orn']
    for i in range(ornaments):
        z = rnd.uniform(zb, zt - 0.2)
        a = rnd.uniform(0, 2 * math.pi)
        rr = env(z) * 0.86
        rad = orn_r * rnd.uniform(0.85, 1.25)
        p = (rr * math.cos(a), rr * math.sin(a), z - rad * 0.4)
        m.sphere(rad, p, orn[i % len(orn)], u=10, v=7)
        m.cyl(rad * 0.3, rad * 0.35, (p[0], p[1], p[2] + rad * 1.05), mats['gold'], axis='Z', segs=6, bevel=0)
    bulbs = mats['bulbs']
    for i in range(lights):
        u = (i + 0.5) / lights
        z = zb + u * (zt - zb)
        a = u * turns * 2 * math.pi
        rr = env(z) * 0.93 + bulb_r * 0.5
        m.sphere(bulb_r, (rr * math.cos(a), rr * math.sin(a), z), bulbs[i % len(bulbs)], scale=(1, 1, 1.3), u=6, v=4)


def santa_hat(m, red, fur, base_r, height, loc=(0, 0, 0), flop=1.0, segs=14, tilt=(0, 0, 0)):
    """Fur brim, a red cone that flops over toward +Y (the back) and a pompom on the tip."""
    pts, radii = [], []
    p = Vector((0, 0, 0))
    n = 12
    step = height / n
    for i in range(n + 1):
        t = i / n
        pts.append(p.copy())
        radii.append(max(base_r * 0.06, base_r * (1 - t) ** 0.85))
        th = flop * 2.1 * t ** 2.2
        p += Vector((0, math.sin(th), math.cos(th))) * step
    add_sweep(m, [red], pts, radii, segs=segs, rot=tilt, loc=loc)
    M = Matrix.Translation(loc) @ Euler(tilt).to_matrix().to_4x4()
    tip = M @ pts[-1]
    m.sphere(base_r * 0.3, tuple(tip), fur, u=10, v=7)
    m.torus(base_r * 1.02, base_r * 0.24, loc, fur, axis='Z', segs=segs + 6, tube=8, scale=(1, 1, 1.15), rot=tilt)


def bow(m, ribbon, size, loc):
    x, y, z = loc
    for sg in (-1, 1):
        m.torus(size * 0.42, size * 0.12, (x + sg * size * 0.42, y, z + size * 0.3), ribbon, axis='Y', segs=14, tube=6,
                scale=(1, 0.75, 0.62), rot=(0, sg * math.radians(-28), 0))
        m.box((size * 0.16, size * 0.05, size * 0.62), (x + sg * size * 0.24, y - size * 0.06, z - size * 0.02), ribbon,
              rot=(0, sg * math.radians(32), 0), bevel=0)
    m.sphere(size * 0.17, (x, y, z + size * 0.08), ribbon, u=8, v=6)


def gift(name, W, H, wrap, ribbon, pattern=None, pat=None, bow_scale=1.0):
    m = Model(name)
    lid = min(0.24, H * 0.15)
    body = W - 0.05
    m.box((body, body, H - lid), (0, 0, (H - lid) / 2), wrap, bevel=0.012)
    m.box((W, W, lid), (0, 0, H - lid / 2), wrap, bevel=0.02)
    rw, t = max(0.1, W * 0.15), 0.014
    for sg in (-1, 1):
        m.box((rw, t, H - lid), (0, sg * (body / 2 + t / 2), (H - lid) / 2), ribbon, bevel=0)
        m.box((t, rw, H - lid), (sg * (body / 2 + t / 2), 0, (H - lid) / 2), ribbon, bevel=0)
        m.box((rw, t, lid), (0, sg * (W / 2 + t / 2), H - lid / 2), ribbon, bevel=0)
        m.box((t, rw, lid), (sg * (W / 2 + t / 2), 0, H - lid / 2), ribbon, bevel=0)
    m.box((rw, W + 2 * t, t), (0, 0, H + t / 2), ribbon, bevel=0)
    m.box((W + 2 * t, rw, t), (0, 0, H + t / 2), ribbon, bevel=0)
    if pattern:
        face = body / 2 + 0.006
        for side in range(4):
            a = side * math.pi / 2
            ca, sa = math.cos(a), math.sin(a)
            if pattern == 'dots':
                cols = max(2, int(body / 0.32))
                rows = max(2, int((H - lid) / 0.32))
                for i in range(cols):
                    u = -body / 2 + (i + 0.5) * body / cols
                    if abs(u) < rw * 0.9:
                        continue
                    for k in range(rows):
                        v = (k + 0.5) * (H - lid) / rows + (0.06 if i % 2 else -0.06)
                        r = min(0.07, body * 0.05)
                        px, py = ca * u + sa * face, sa * u - ca * face
                        m.cyl(r, 0.012, (px, py, v), pat, axis='Y', segs=10, bevel=0, rot=(0, 0, a))
            elif pattern == 'stripes':
                n = max(3, int(body / 0.22))
                for i in range(n):
                    u = -body / 2 + (i + 0.5) * body / n
                    if abs(u) < rw * 0.8:
                        continue
                    px, py = ca * u + sa * face, sa * u - ca * face
                    m.box((min(0.06, body * 0.05), 0.012, H - lid - 0.02), (px, py, (H - lid) / 2), pat, rot=(0, 0, a), bevel=0)
    bow(m, ribbon, min(0.5, W * 0.3) * bow_scale, (0, 0, H + 0.02))
    return m.finish(sharp=40)


def build_xmas():
    R = math.radians
    red = mat("XRed", 0xd0263a, 0.6); fur = mat("XFur", 0xfbf8f2, 0.95)
    gold = mat("XGold", 0xf2c14e, 0.35); star = mat("XStar", 0xffd75a, 0.3, emit=3.0)
    pine = mat("XPine", 0x1d6a3c, 0.75); pine2 = mat("XPine2", 0x2a8549, 0.75)
    bark = mat("XBark", 0x6b4426, 0.85); snow = mat("XSnow", 0xf4f8ff, 0.9)
    coal = mat("XCoal", 0x1b1b22, 0.6); carrot = mat("XCarrot", 0xf07a1e, 0.6)
    green = mat("XGreen", 0x1f7a45, 0.6); white = mat("XWhite", 0xf6f2ea, 0.55)
    blue = mat("XBlue", 0x3a6fd6, 0.55); purple = mat("XPurple", 0x8b4fd0, 0.55)
    goldwrap = mat("XGoldWrap", 0xf0b83a, 0.45); silver = mat("XSilver", 0xd9dee8, 0.25)
    orn = [mat("XOrnRed", 0xe02f3f, 0.2), mat("XOrnGold", 0xf5c242, 0.2), mat("XOrnBlue", 0x3d78f0, 0.2), silver, mat("XOrnPurple", 0xa65ae0, 0.2)]
    bulbs = [mat("XBulbWarm", 0xffe2a0, 0.4, emit=4.0), mat("XBulbRed", 0xff4a4a, 0.4, emit=4.0), mat("XBulbGreen", 0x4aff7a, 0.4, emit=4.0),
             mat("XBulbBlue", 0x5aa0ff, 0.4, emit=4.0), mat("XBulbYellow", 0xffd84a, 0.4, emit=4.0)]
    sleigh = mat("XSleigh", 0xc21d2a, 0.45); sleigh_d = mat("XSleighDark", 0x5a0f16, 0.6)
    cushion = mat("XCushion", 0x1e6b45, 0.8); sack = mat("XSack", 0x9a6b3c, 0.9); steel_d = mat("XIron", 0x2e3340, 0.5)
    ginger = mat("XGinger", 0xb0672c, 0.8); icing = mat("XIcing", 0xfffaf2, 0.5)
    gum_r = mat("XGumRed", 0xe8304a, 0.35); gum_g = mat("XGumGreen", 0x38c060, 0.35)
    warm = mat("XLampGlow", 0xffd98a, 0.4, emit=4.0)
    text_y = mat("XSignText", 0xffe9a8, 0.5, emit=1.6)
    fmats = {'pine': pine, 'pine2': pine2, 'snow': snow, 'orn': orn, 'gold': gold, 'bulbs': bulbs}
    made = []

    # ---- the Santa hat every fighter wears on this map (sized for the pickle's head) ----
    m = Model("SantaHat")
    santa_hat(m, red, fur, 0.215, 0.5, flop=1.0)
    made.append(m.finish(sharp=60))

    # ---- a bigger hat for pillar tops and the giant scenery ----
    m = Model("SantaHatBig")
    santa_hat(m, red, fur, 0.5, 1.15, flop=1.05, segs=18)
    made.append(m.finish(sharp=60))

    # ---- giant centre tree (stands on the plaza, ~10 m to the star) ----
    rnd = random.Random(12)
    m = Model("TreeBig")
    m.cyl(0.55, 1.2, (0, 0, 0.6), bark, axis='Z', segs=12, bevel=0.02)
    m.lathe([(0.0, 0.0), (3.2, 0.0), (3.2, 0.04), (0.0, 0.04)], (0, 0, 0), red, axis='Z', segs=28)             # tree skirt
    m.torus(3.2, 0.09, (0, 0, 0.04), fur, axis='Z', segs=40, tube=8, scale=(1, 1, 0.8))
    fir(m, [(0.9, 3.4, 3.2), (2.4, 4.9, 2.65), (3.8, 6.2, 2.1), (5.1, 7.4, 1.6), (6.3, 8.4, 1.1), (7.4, 9.3, 0.62)], fmats, rnd,
        ornaments=70, lights=150, turns=7.0, orn_r=0.17, bulb_r=0.075)
    m.raw(star_bm(0.62, 0.27, 0.22), star, loc=(0, 0, 9.75))
    m.cyl(0.06, 0.5, (0, 0, 9.3), gold, axis='Z', segs=8, bevel=0)
    made.append(m.finish(sharp=45))

    # ---- regular tree (2 x 2 cells, 3.6 m) ----
    rnd = random.Random(4)
    m = Model("Tree")
    m.cyl(0.16, 0.5, (0, 0, 0.25), bark, axis='Z', segs=10, bevel=0.01)
    for i in range(6):                                                                             # snow round the foot
        a = i / 6 * 2 * math.pi
        m.sphere(0.28, (0.45 * math.cos(a), 0.45 * math.sin(a), 0.02), snow, scale=(1.3, 1.3, 0.35), u=8, v=5)
    fir(m, [(0.4, 1.55, 0.98), (1.1, 2.3, 0.8), (1.8, 2.95, 0.6), (2.45, 3.4, 0.38)], fmats, rnd, ornaments=18, lights=36, turns=4.5)
    m.raw(star_bm(0.2, 0.09, 0.08), star, loc=(0, 0, 3.55))
    made.append(m.finish(sharp=45))

    # ---- presents: three sizes, five wrappings. Gift1 is 1x1 cells and 1 m, Gift2 2x2 and
    #      1.5 m, Gift3 3x3 and 2.5 m, so they stack into climbable steps. ----
    wraps = {
        'Red': (red, gold, None, None),
        'Green': (green, red, 'stripes', white),
        'Blue': (blue, silver, 'dots', white),
        'Gold': (goldwrap, red, None, None),
        'White': (white, green, 'dots', red),
        'Purple': (purple, gold, 'stripes', gold),
    }
    for size, (W, H) in (("Gift1", (0.96, 1.0)), ("Gift2", (1.94, 1.5)), ("Gift3", (2.92, 2.5))):
        for wn, (wr, rb, pt, pm) in wraps.items():
            made.append(gift(f"{size}_{wn}", W, H, wr, rb, pt, pm))
    # small loose gifts, dressing only
    for wn, (wr, rb, pt, pm) in wraps.items():
        made.append(gift(f"GiftSmall_{wn}", 0.45, 0.36, wr, rb, None, None, bow_scale=0.9))

    # ---- snowman wearing a Santa hat (1 x 1 cells, 2 m) ----
    m = Model("Snowman")
    for r, z in ((0.47, 0.42), (0.35, 1.1), (0.25, 1.6)):
        m.sphere(r, (0, 0, z), snow, scale=(1, 1, 0.93), u=18, v=12)
    for i in range(3):
        m.sphere(0.04, (0, -0.35 + abs(i - 1) * 0.02 - 0.01, 0.98 + i * 0.13), coal, u=8, v=6)
    for sx in (-1, 1):
        m.sphere(0.033, (sx * 0.09, -0.225, 1.67), coal, u=8, v=6)
        add_sweep(m, [bark], [(sx * 0.3, 0, 1.18), (sx * 0.55, -0.02, 1.32), (sx * 0.78, 0.0, 1.5)], [0.026, 0.022, 0.016], segs=6)
        add_sweep(m, [bark], [(sx * 0.62, -0.01, 1.4), (sx * 0.7, -0.01, 1.58)], [0.015, 0.01], segs=5)
    for i in range(5):
        a = math.radians(200 + i * 35)
        m.sphere(0.018, (0.13 * math.cos(a), -0.2 + 0.13 * math.sin(a) * 0.3, 1.52 + 0.06 * math.sin(a)), coal, u=6, v=4)
    m.lathe([(0.045, 0.0), (0.0, 0.26)], (0, -0.23, 1.6), carrot, axis='Y', segs=10, rot=(R(180), 0, 0))
    m.torus(0.25, 0.065, (0, 0, 1.39), red, axis='Z', segs=20, tube=8, scale=(1, 1, 0.9))
    m.box((0.12, 0.05, 0.38), (0.12, -0.27, 1.2), red, rot=(R(-8), R(10), 0), bevel=0.02)
    for i in range(3):
        m.box((0.125, 0.055, 0.025), (0.12 + 0.03 * math.sin(R(10)), -0.274, 1.06 + i * 0.05), green, rot=(R(-8), R(10), 0), bevel=0)
    santa_hat(m, red, fur, 0.2, 0.48, loc=(0, 0.02, 1.78), tilt=(R(8), R(-10), 0))
    made.append(m.finish(sharp=50))

    # ---- giant candy cane (1 x 1 cells, 3 m), hook toward -X ----
    m = Model("CandyCane")
    H, Rh, rc = 2.55, 0.32, 0.11
    pts = [(0, 0, z) for z in [0.0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.3, H]]
    for i in range(1, 15):
        th = math.pi * i / 14
        pts.append((-Rh + Rh * math.cos(th), 0, H + Rh * math.sin(th)))
    pts.append((-2 * Rh, 0, H - 0.18))
    add_sweep(m, [white, red], pts, [rc] * len(pts), segs=20, key=helix_key(0.42, 2))
    m.lathe([(0.0, 0.0), (0.24, 0.0), (0.24, 0.05), (0.0, 0.05)], (0, 0, 0), snow, axis='Z', segs=12)
    made.append(m.finish(sharp=60))

    # ---- Christmas lamp post: candy-striped pole, lantern, holly ring ----
    m = Model("XmasLamp")
    m.cyl(0.14, 0.12, (0, 0, 0.06), steel_d, axis='Z', segs=10, bevel=0.02)
    add_sweep(m, [white, red], [(0, 0, 0.1), (0, 0, 1.2), (0, 0, 2.3), (0, 0, 2.5)], [0.05] * 4, segs=16, key=helix_key(0.3, 2))
    m.box((0.3, 0.3, 0.05), (0, 0, 2.52), steel_d, bevel=0.012)
    m.sphere(0.12, (0, 0, 2.7), warm, scale=(1, 1, 1.25), u=10, v=8)
    for sx in (-1, 1):
        for sy in (-1, 1):
            m.box((0.025, 0.025, 0.32), (sx * 0.12, sy * 0.12, 2.7), steel_d, bevel=0)
    m.lathe([(0.0, 2.86), (0.2, 2.86), (0.0, 3.04)], (0, 0, 0), steel_d, axis='Z', segs=4, rot=(0, 0, R(45)))
    m.torus(0.17, 0.06, (0, 0, 1.9), pine2, axis='Z', segs=16, tube=6)
    for i in range(5):
        a = i / 5 * 2 * math.pi
        m.sphere(0.03, (0.2 * math.cos(a), 0.2 * math.sin(a), 1.95), orn[0], u=6, v=4)
    bow(m, red, 0.22, (0, -0.22, 1.86))
    made.append(m.finish(sharp=45))

    # ---- wreath for the walls (faces -Y, centred on its origin) ----
    rnd = random.Random(8)
    m = Model("Wreath")
    m.torus(0.5, 0.15, (0, 0, 0), pine, axis='Y', segs=22, tube=8, scale=(1, 0.8, 1))
    for i in range(22):
        a = i / 22 * 2 * math.pi
        rr = 0.5 + rnd.uniform(-0.08, 0.08)
        m.sphere(0.1, (rr * math.cos(a), -0.06, rr * math.sin(a)), pine2 if i % 2 else pine, scale=(1.3, 0.6, 0.8), u=6, v=4, rot=(0, -a, 0))
    for i in range(9):
        a = rnd.uniform(0, 2 * math.pi)
        rr = 0.5 + rnd.uniform(-0.1, 0.1)
        m.sphere(0.045, (rr * math.cos(a), -0.14, rr * math.sin(a)), orn[0] if i % 3 else orn[1], u=6, v=4)
    bow(m, red, 0.3, (0, -0.15, -0.52))
    made.append(m.finish(sharp=50))

    # ---- garland swag for the walls: 4 m wide, hangs from its two ends at z=0 ----
    m = Model("Garland")
    pts, radii = [], []
    for i in range(33):
        x = -2 + 4 * i / 32
        pts.append((x, 0, -0.5 * (1 - (x / 2) ** 2)))
        radii.append(0.11 if i % 2 else 0.135)
    add_sweep(m, [pine], pts, radii, segs=8)
    for i in range(1, 12):
        x = -2 + 4 * i / 12
        z = -0.5 * (1 - (x / 2) ** 2)
        m.sphere(0.05, (x, -0.1, z - 0.13), bulbs[i % len(bulbs)], scale=(1, 1, 1.4), u=6, v=5)
    for sx in (-1, 1):
        bow(m, red, 0.24, (sx * 2, -0.1, -0.06))
    made.append(m.finish(sharp=50))

    # ---- "MERRY PICKLEMAS" wall sign ----
    m = Model("SignXmas")
    w = 5.0
    m.box((w, 0.1, 1.15), (0, 0, 0), sleigh, bevel=0.04)
    for z in (0.49, -0.49):
        m.box((w - 0.16, 0.02, 0.05), (0, -0.055, z), gold, bevel=0.01)
    for sx in (-1, 1):
        m.box((0.05, 0.02, 0.93), (sx * (w / 2 - 0.105), -0.055, 0), gold, bevel=0.01)
    for i in range(14):
        x = -w / 2 + (i + 0.5) * w / 14
        m.sphere(0.13, (x, -0.01, 0.6), snow, scale=(1.6, 0.9, 0.55), u=8, v=5)
    for sx in (-1, 1):
        for k in range(3):
            a = R(90 + 120 * k)
            m.sphere(0.13, (sx * (w / 2 - 0.42) + 0.13 * math.cos(a), -0.09, 0.13 * math.sin(a)), pine2, scale=(1.4, 0.3, 0.7), u=8, v=5, rot=(0, -a, 0))
        for k in range(3):
            m.sphere(0.05, (sx * (w / 2 - 0.42) + (k - 1) * 0.05, -0.13, 0.02 + (k % 2) * 0.05), orn[0], u=6, v=5)
    tb = text_bm("MERRY PICKLEMAS", size=0.42, extrude=0.025)
    m.flat = True
    m.raw(tb, text_y, loc=(0, -0.07, -0.02), rot=(R(90), 0, 0))
    m.flat = False
    made.append(m.finish(sharp=45))

    # ---- Santa's sleigh: 2 x 4 cells, 1.5 m, long along Y with the curl at -Y ----
    m = Model("Sleigh")
    for sx in (-1, 1):                                                                   # runners
        pts = [(sx * 0.72, 1.75, 0.18), (sx * 0.72, 1.8, 0.07), (sx * 0.72, 1.6, 0.04)]
        pts += [(sx * 0.72, y, 0.04) for y in (1.0, 0.0, -1.0, -1.45)]
        for i in range(1, 12):
            th = math.pi * 1.25 * i / 11
            pts.append((sx * 0.72, -1.45 - 0.42 * math.sin(th), 0.46 - 0.42 * math.cos(th)))
        add_sweep(m, [gold], pts, [0.045] * len(pts), segs=8)
        for y in (-0.9, 0.0, 0.9):
            m.box((0.05, 0.05, 0.42), (sx * 0.72, y, 0.27), steel_d, bevel=0.01)
    m.box((1.62, 2.7, 0.62), (0, 0.15, 0.77), sleigh, bevel=0.08)                          # tub
    m.box((1.5, 0.4, 0.75), (0, -1.25, 1.0), sleigh, rot=(R(-28), 0, 0), bevel=0.07)      # dash
    m.box((1.62, 0.3, 1.25), (0, 1.38, 1.0), sleigh, rot=(R(10), 0, 0), bevel=0.08)        # backrest
    for sx in (-1, 1):
        add_sweep(m, [sleigh], [(sx * 0.76, -1.45, 1.38), (sx * 0.8, -1.7, 1.42), (sx * 0.8, -1.82, 1.25), (sx * 0.78, -1.7, 1.12)], [0.09, 0.08, 0.06, 0.04], segs=10)
        m.box((0.035, 2.7, 0.05), (sx * 0.82, 0.15, 1.08), gold, bevel=0.01)
        m.box((0.035, 2.4, 0.05), (sx * 0.82, 0.15, 0.6), gold, bevel=0.01)
        m.sphere(0.12, (sx * 0.82, 0.15, 0.82), gold, scale=(0.25, 1, 1), u=10, v=8)
    m.box((1.5, 0.95, 0.16), (0, 0.75, 1.13), cushion, bevel=0.06)                          # seat
    m.box((1.4, 0.18, 0.7), (0, 1.2, 1.55), cushion, rot=(R(10), 0, 0), bevel=0.06)
    m.sphere(0.48, (0.05, -0.3, 1.3), sack, scale=(1.25, 1.0, 0.95), u=14, v=10)             # sack of presents
    m.sphere(0.12, (0.05, -0.3, 1.78), sack, scale=(1, 1, 1.4), u=8, v=6)
    m.torus(0.1, 0.03, (0.05, -0.3, 1.7), gold, axis='Z', segs=12, tube=6)
    for (x, y, z, s, rz, w2) in ((-0.42, -0.85, 1.25, 0.34, 0.3, 'Red'), (0.45, -0.75, 1.3, 0.3, -0.4, 'Blue'), (-0.35, 0.1, 1.38, 0.28, 0.8, 'Gold')):
        wr, rb = wraps[w2][0], wraps[w2][1]
        m.box((s, s, s), (x, y, z), wr, rot=(0, 0, rz), bevel=0.01)
        m.box((s * 0.2, s + 0.01, s + 0.01), (x, y, z), rb, rot=(0, 0, rz), bevel=0)
        m.box((s + 0.01, s * 0.2, s + 0.01), (x, y, z), rb, rot=(0, 0, rz), bevel=0)
    for sx in (-1, 1):                                                                       # sleigh bells
        m.sphere(0.07, (sx * 0.84, -1.3, 1.2), gold, u=8, v=6)
    made.append(m.finish(sharp=40))

    # ---- snow pile, dressing only (walk-through) ----
    rnd = random.Random(6)
    m = Model("SnowPile")
    for i in range(6):
        a = rnd.uniform(0, 2 * math.pi); d = rnd.uniform(0, 0.4)
        m.sphere(rnd.uniform(0.25, 0.42), (d * math.cos(a), d * math.sin(a), 0), snow, scale=(1.3, 1.1, 0.5), u=10, v=6)
    made.append(m.finish(sharp=60))

    # ---- gingerbread man (giant scenery), faces -Y, feet at z=0, ~1.6 m tall ----
    m = Model("Gingerbread")
    sq = (1, 0.55, 1)
    m.sphere(0.34, (0, 0, 1.3), ginger, scale=(1, 0.5, 1), u=16, v=10)
    add_sweep(m, [ginger], [(0, 0, 0.55), (0, 0, 0.75), (0, 0, 0.95)], [0.3, 0.33, 0.3], segs=16, scale=sq)
    for sx in (-1, 1):
        add_sweep(m, [ginger], [(sx * 0.15, 0, 0.98), (sx * 0.45, 0, 1.04), (sx * 0.66, 0, 1.12)], [0.15, 0.14, 0.13], segs=12, scale=sq)
        m.sphere(0.13, (sx * 0.66, 0, 1.12), ginger, scale=sq, u=10, v=8)
        add_sweep(m, [ginger], [(sx * 0.12, 0, 0.6), (sx * 0.22, 0, 0.32), (sx * 0.3, 0, 0.12)], [0.17, 0.16, 0.15], segs=12, scale=sq)
        m.sphere(0.15, (sx * 0.3, 0, 0.12), ginger, scale=sq, u=10, v=8)
        # icing zigzags across the wrist (runs up and down) and the ankle (runs side to side)
        wrist = [(sx * 0.55 + (0.03 if k % 2 else -0.03), -0.09, 0.96 + 0.04 * k) for k in range(7)]
        ankle = [(sx * 0.26 - 0.12 + 0.04 * k, -0.09, 0.25 + (0.03 if k % 2 else -0.03)) for k in range(7)]
        for zz in (wrist, ankle):
            add_sweep(m, [icing], zz, [0.017] * len(zz), segs=6)
        m.sphere(0.045, (sx * 0.11, -0.16, 1.38), icing, scale=(1, 0.5, 1), u=8, v=6)
    smile = [(0.13 * math.cos(R(a)), -0.16, 1.25 + 0.09 * math.sin(R(a))) for a in range(200, 345, 15)]
    add_sweep(m, [icing], smile, [0.018] * len(smile), segs=6)
    for i, g in enumerate((gum_r, gum_g, gum_r)):
        m.sphere(0.06, (0, -0.16, 0.92 - i * 0.16), g, scale=(1, 0.6, 0.85), u=10, v=6)
    made.append(m.finish(sharp=60))

    return made


def build_xmas_blocks():
    """Kit blocks for the holiday arena. Kit* materials are tinted by the game like blocks.glb."""
    R = math.radians
    snow = mat("KitSnow", 0xf6f6f6, 0.9)
    ice = mat("KitIce", 0xf4f4f4, 0.12); ice_s = mat("KitIceShade", 0xc4c4c4, 0.15)
    gb = mat("KitGinger", 0xf2f2f2, 0.82); gb_s = mat("KitGingerShade", 0xc8c8c8, 0.85)
    mint = mat("KitMint", 0xf6f6f6, 0.35)
    icing = mat("FixIcing", 0xfffaf2, 0.5); cred = mat("FixCandyRed", 0xd8283a, 0.35); cgreen = mat("FixGumGreen", 0x2fb35a, 0.35)
    crack = mat("FixIceCrack", 0xeaf6ff, 0.2)
    out = []
    both = lambda kit: ((kit + "_cube", 1.0), (kit + "_slab", 0.5))

    # gingerbread: a biscuit slab with piped icing along the top and a gumdrop on each face
    for name, H in both("Ginger"):
        m = Model(name)
        m.box((0.99, 0.99, H - 0.005), (0, 0, H / 2), gb, bevel=0.03, segs=1)
        for sg in (-1, 1):
            m.box((1.0, 0.035, 0.05), (0, sg * 0.49, H - 0.05), icing, bevel=0)
            m.box((0.035, 1.0, 0.05), (sg * 0.49, 0, H - 0.05), icing, bevel=0)
            for k in range(4):
                u = -0.375 + k * 0.25
                L = 0.1 if k % 2 else 0.16
                m.box((0.05, 0.03, L), (u, sg * 0.498, H - 0.05 - L / 2), icing, bevel=0)
                m.box((0.03, 0.05, L), (sg * 0.498, u, H - 0.05 - L / 2), icing, bevel=0)
        if H == 1.0:
            for side in range(4):
                a = side * math.pi / 2
                m.sphere(0.07, (math.sin(a) * 0.5, -math.cos(a) * 0.5, 0.42), cred if side % 2 else cgreen, scale=(1, 0.55, 0.9), u=6, v=4, rot=(0, 0, a))
            m.box((0.8, 0.8, 0.012), (0, 0, 0.5), gb_s, bevel=0)
        out.append(m.finish(sharp=40))

    # snow: soft rounded block with a lumpy top
    rnd = random.Random(14)
    for name, H in both("Snow"):
        m = Model(name)
        m.box((0.99, 0.99, H - 0.01), (0, 0, H / 2), snow, bevel=0.07, segs=2)
        m.sphere(rnd.uniform(0.16, 0.22), (rnd.uniform(-0.2, 0.2), rnd.uniform(-0.2, 0.2), H - 0.03), snow, scale=(1.4, 1.2, 0.3), u=8, v=4)
        out.append(m.finish(sharp=60))

    # ice brick: glossy blocks in staggered courses
    for name, H in both("Ice"):
        m = Model(name)
        m.box((0.95, 0.95, H - 0.02), (0, 0, H / 2), ice_s, bevel=0)
        n = int(H / 0.5)
        for k in range(n):
            if k % 2 == 0:
                for sx in (-1, 1):
                    m.box((0.485, 0.985, 0.485), (sx * 0.25, 0, 0.25 + k * 0.5), ice if sx < 0 else ice_s, bevel=0.04, segs=1)
            else:
                for sy in (-1, 1):
                    m.box((0.985, 0.485, 0.485), (0, sy * 0.25, 0.25 + k * 0.5), ice_s if sy < 0 else ice, bevel=0.04, segs=1)
        out.append(m.finish())

    # peppermint: white candy with red bands
    for name, H in both("Mint"):
        m = Model(name)
        m.box((0.98, 0.98, H - 0.004), (0, 0, H / 2), mint, bevel=0.05, segs=2)
        for z in ((0.25, 0.75) if H == 1.0 else (0.25,)):
            m.box((0.995, 0.995, 0.16), (0, 0, z), cred, bevel=0.03, segs=1)
        out.append(m.finish(sharp=50))

    # floors (top at 0.5)
    m = Model("FloorSnow")
    m.box((0.995, 0.995, 0.12), (0, 0, 0.44), snow, bevel=0.03, segs=1)
    out.append(m.finish(sharp=60))
    m = Model("FloorIce")
    m.box((0.995, 0.995, 0.12), (0, 0, 0.44), ice, bevel=0.012, segs=1)
    m.box((0.6, 0.018, 0.004), (-0.1, 0.12, 0.5), crack, rot=(0, 0, R(28)), bevel=0)
    m.box((0.3, 0.014, 0.004), (0.22, -0.15, 0.5), crack, rot=(0, 0, R(-50)), bevel=0)
    out.append(m.finish())
    return out


BUILDERS['xmas'] = lambda: build_xmas() + build_xmas_blocks()


def export(objs, path):
    if not isinstance(objs, (list, tuple)):
        objs = [objs]
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
        for ch in o.children:
            ch.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, use_active_scene=True, export_yup=True,
                              export_apply=True, export_cameras=False, export_lights=False, export_animations=False)


def build_all(out_dir):
    wipe()
    made = {}
    for name, fn in BUILDERS.items():
        made[name] = fn()
        export(made[name], f"{out_dir}/{name}.glb")
    return made


def setup_preview(target=(0, 0, 0.75), dist=3.2, az=35, el=12, res=(900, 700)):
    """Camera, sun and a soft sky so a render shows the models roughly as the game lights them."""
    sc = bpy.context.scene
    cam = bpy.data.objects.get("BD_Cam")
    if cam is None:
        cam = bpy.data.objects.new("BD_Cam", bpy.data.cameras.new("BD_Cam"))
        sc.collection.objects.link(cam)
    sun = bpy.data.objects.get("BD_Sun")
    if sun is None:
        sun = bpy.data.objects.new("BD_Sun", bpy.data.lights.new("BD_Sun", 'SUN'))
        sc.collection.objects.link(sun)
    sun.data.energy = 3.2
    sun.rotation_euler = Euler((math.radians(50), 0, math.radians(30)))
    a, e = math.radians(az), math.radians(el)
    t = Vector(target)
    cam.location = t + Vector((math.sin(a) * math.cos(e) * dist, math.cos(a) * math.cos(e) * dist, math.sin(e) * dist))
    cam.rotation_euler = (t - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 50
    sc.camera = cam
    if sc.world is None:
        sc.world = bpy.data.worlds.new("BD_World")
    try:
        sc.world.use_nodes = True
    except Exception:
        pass
    bg = sc.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = hexcol(0x8fa3c4)
        bg.inputs[1].default_value = 1.0
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.film_transparent = False


def show_only(names):
    for o in collection().objects:
        vis = o.name in names or (o.parent and o.parent.name in names)
        o.hide_render = not vis
        o.hide_viewport = not vis
