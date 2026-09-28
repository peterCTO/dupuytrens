// Signed distance field of the model hand.
//
// The skin is the smooth union of simple shapes (tapered capsules for the
// digits, ellipsoids for the thenar and hypothenar eminences, a rounded slab
// for the palm). Blending them with a smooth minimum gives the soft webs and
// creases of a real hand without a hand-sculpted mesh, and lets the pose be
// rebuilt exactly for any finger angles.

import { Skeleton, Vec3, Segment, norm, cross, dot } from './anatomy';

interface Cone {
  ax: number; ay: number; az: number;
  /** Bounding sphere. */
  cx: number; cy: number; cz: number; cr: number;
  bx: number; by: number; bz: number;
  l2: number; rr: number; a2: number; il2: number;
  r1: number; r2: number;
}

interface Ellipsoid {
  c: Vec3;
  /** Largest radius, for a cheap lower bound on the distance. */
  rmax: number;
  /** Rows are the local axes. */
  m: number[];
  r: Vec3;
}

export interface DigitField {
  cones: Cone[];
  pads: Ellipsoid[];
  knuckles: { c: Vec3; r: number }[];
  segments: Segment[];
  /** Bounding sphere, for skipping digits far from the sample point. */
  bc: Vec3;
  br: number;
  k: number;
  isThumb: boolean;
}

export interface Field {
  palmCones: { cone: Cone; k: number }[];
  palmEllipsoids: { e: Ellipsoid; k: number }[];
  forearm: Cone;
  webs: Cone[];
  hollow: Ellipsoid;
  digits: DigitField[];
  cords: Cone[];
  nodules: Ellipsoid[];
  cutY: number;
  min: Vec3;
  max: Vec3;
}

export const CUT_Y = -3.0;

function makeCone(a: Vec3, b: Vec3, r1: number, r2: number): Cone {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz;
  const rr = r1 - r2;
  return {
    ax: a[0], ay: a[1], az: a[2],
    cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, cz: (a[2] + b[2]) / 2,
    cr: Math.sqrt(l2) / 2 + Math.max(r1, r2),
    bx, by, bz, l2, rr, a2: l2 - rr * rr, il2: 1 / l2, r1, r2,
  };
}

// Round cone (capsule with different end radii), after Inigo Quilez.
function sdCone(c: Cone, px: number, py: number, pz: number): number {
  const pax = px - c.ax, pay = py - c.ay, paz = pz - c.az;
  const y = pax * c.bx + pay * c.by + paz * c.bz;
  const z = y - c.l2;
  const qx = pax * c.l2 - c.bx * y, qy = pay * c.l2 - c.by * y, qz = paz * c.l2 - c.bz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * c.l2;
  const z2 = z * z * c.l2;
  const k = Math.sign(c.rr) * c.rr * c.rr * x2;
  if (Math.sign(z) * c.a2 * z2 > k) return Math.sqrt(x2 + z2) * c.il2 - c.r2;
  if (Math.sign(y) * c.a2 * y2 < k) return Math.sqrt(x2 + y2) * c.il2 - c.r1;
  return (Math.sqrt(x2 * c.a2 * c.il2) + y * c.rr) * c.il2 - c.r1;
}

function makeEllipsoid(c: Vec3, r: Vec3, xAxis: Vec3 = [1, 0, 0], yAxis: Vec3 = [0, 1, 0]): Ellipsoid {
  const x = norm(xAxis);
  const z = norm(cross(x, yAxis));
  const y = cross(z, x);
  return { c, m: [...x, ...y, ...z], r, rmax: Math.max(r[0], r[1], r[2]) };
}

function sdEllipsoid(e: Ellipsoid, px: number, py: number, pz: number): number {
  const dx = px - e.c[0], dy = py - e.c[1], dz = pz - e.c[2];
  const m = e.m;
  const lx = (m[0] * dx + m[1] * dy + m[2] * dz) / e.r[0];
  const ly = (m[3] * dx + m[4] * dy + m[5] * dz) / e.r[1];
  const lz = (m[6] * dx + m[7] * dy + m[8] * dz) / e.r[2];
  const k0 = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const k1 = Math.sqrt((lx * lx) / (e.r[0] * e.r[0]) + (ly * ly) / (e.r[1] * e.r[1]) + (lz * lz) / (e.r[2] * e.r[2]));
  if (k1 < 1e-9) return -Math.min(e.r[0], e.r[1], e.r[2]);
  return (k0 * (k0 - 1)) / k1;
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function buildField(sk: Skeleton): Field {
  const palmCones: { cone: Cone; k: number }[] = [];
  const palmEllipsoids: { e: Ellipsoid; k: number }[] = [];

  const fingers = sk.digits.filter((d) => d.id !== 'thumb');
  // Metacarpals: from the carpus to each knuckle, sitting towards the back of the hand.
  for (const d of fingers) {
    const head = d.joints[0];
    const base: Vec3 = [head[0] * 0.45, 2.1, -0.35];
    palmCones.push({ cone: makeCone(base, [head[0], head[1], -0.3], 1.05, 1.0), k: 1.4 });
  }
  // Slab of the palm, built from overlapping flattened ellipsoids so it
  // narrows towards the wrist and is thicker on the radial side.
  palmEllipsoids.push({ e: makeEllipsoid([0.1, 5.9, 0.05], [4.0, 4.3, 1.25]), k: 1.2 });
  palmEllipsoids.push({ e: makeEllipsoid([-0.1, 8.7, 0.1], [3.9, 1.5, 1.05]), k: 1.0 });
  // Thenar eminence (ball of the thumb) and hypothenar eminence.
  palmEllipsoids.push({ e: makeEllipsoid([2.25, 3.9, 0.8], [1.75, 2.8, 1.15], [0.85, 0.5, 0], [-0.5, 0.85, 0]), k: 1.2 });
  palmEllipsoids.push({ e: makeEllipsoid([-2.75, 4.6, 0.55], [1.25, 3.2, 0.95], [1, 0.08, 0], [-0.08, 1, 0]), k: 1.0 });
  // Distal palmar pads over each metacarpal head.
  for (const d of fingers) {
    const h = d.joints[0];
    palmEllipsoids.push({ e: makeEllipsoid([h[0], h[1] + 0.35, 0.45], [1.0, 1.25, 0.72]), k: 0.7 });
  }
  // First web space between thumb and index.
  palmEllipsoids.push({
    e: makeEllipsoid([3.55, 6.45, 0.35], [1.0, 1.6, 0.42], [0.72, -0.7, 0], [0.7, 0.72, 0]),
    k: 0.9,
  });

  const forearm = makeCone([0.15, CUT_Y - 2, -0.1], [0.15, 2.3, -0.1], 2.85, 3.0);

  const digits: DigitField[] = sk.digits.map((d) => {
    const cones = d.segments.map((s) => makeCone(s.a, s.b, s.ra, s.rb));
    const knuckles: { c: Vec3; r: number }[] = [];
    // Dorsal joint prominences at PIP and DIP.
    for (let i = 1; i < 3; i++) {
      const s = d.segments[i];
      const prev = d.segments[i - 1];
      const back: Vec3 = [-(s.palmar[0] + prev.palmar[0]) / 2, -(s.palmar[1] + prev.palmar[1]) / 2, -(s.palmar[2] + prev.palmar[2]) / 2];
      const r = s.ra * 0.72;
      knuckles.push({ c: [s.a[0] + back[0] * (s.ra - r) * 0.9, s.a[1] + back[1] * (s.ra - r) * 0.9, s.a[2] + back[2] * (s.ra - r) * 0.9], r });
    }
    // Fleshy pads on the palmar side of each phalanx; the fingertip pulp is fullest.
    const pads = d.segments.map((s, i) => {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
      const r = (s.ra + s.rb) / 2;
      const t = i === 2 ? 0.62 : 0.5;
      const out = r * (i === 2 ? 0.3 : 0.26);
      const c: Vec3 = [0, 1, 2].map((k) => s.a[k] + (s.b[k] - s.a[k]) * t + s.palmar[k] * out) as Vec3;
      return makeEllipsoid(c, [r * 0.8, len * (i === 2 ? 0.36 : 0.4), r * 0.72], s.lateral, s.axis);
    });
    let bc: Vec3 = [0, 0, 0];
    for (const j of d.joints) bc = [bc[0] + j[0] / d.joints.length, bc[1] + j[1] / d.joints.length, bc[2] + j[2] / d.joints.length];
    let br = 0;
    for (const j of d.joints) br = Math.max(br, Math.hypot(j[0] - bc[0], j[1] - bc[1], j[2] - bc[2]));
    br += 1.3;
    return { cones, pads, knuckles, segments: d.segments, bc, br, k: d.id === 'thumb' ? 1.1 : 0.75, isThumb: d.id === 'thumb' };
  });

  // Interdigital webs: skin folds joining neighbouring proximal phalanges.
  const webs: Cone[] = [];
  for (let i = 0; i + 1 < fingers.length; i++) {
    const at = (d: typeof fingers[number]) => {
      const s = d.segments[0];
      return [0, 1, 2].map((k) => s.a[k] + s.axis[k] * 1.2 + s.palmar[k] * 0.15) as Vec3;
    };
    webs.push(makeCone(at(fingers[i]), at(fingers[i + 1]), 0.55, 0.55));
  }
  // The hollow of the palm between the eminences.
  const hollow = makeEllipsoid([-0.1, 6.0, 2.05], [2.0, 2.3, 1.0]);

  const cords: Cone[] = [];
  const nodules: Ellipsoid[] = [];
  for (const c of sk.cords) {
    for (let i = 0; i + 1 < c.points.length; i++) {
      cords.push(makeCone(c.points[i], c.points[i + 1], c.radius * 1.15, c.radius * 0.8));
    }
    nodules.push(makeEllipsoid(c.nodule, [0.42, 0.6, 0.32], [1, 0, 0], c.noduleAxis));
  }

  // Bounds from all digit joints plus the palm and forearm.
  const min: Vec3 = [-4.6, CUT_Y - 0.3, -2.2];
  const max: Vec3 = [5.4, 11.5, 2.2];
  for (const d of sk.digits) {
    for (const j of d.joints) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], j[a] - 1.3);
        max[a] = Math.max(max[a], j[a] + 1.3);
      }
    }
  }
  return { palmCones, palmEllipsoids, forearm, webs, hollow, digits, cords, nodules, cutY: CUT_Y, min, max };
}

export function sdDigitCones(f: DigitField, x: number, y: number, z: number): number {
  let d = Infinity;
  for (const cone of f.cones) d = Math.min(d, sdCone(cone, x, y, z));
  return d;
}

function sdDigit(f: DigitField, x: number, y: number, z: number): number {
  let d = sdCone(f.cones[0], x, y, z);
  d = smin(d, sdCone(f.cones[1], x, y, z), 0.28);
  const distal = sdCone(f.cones[2], x, y, z);
  d = smin(d, distal, 0.22);
  for (const e of f.pads) d = smin(d, sdEllipsoid(e, x, y, z), 0.3);
  for (const kn of f.knuckles) {
    const dk = Math.hypot(x - kn.c[0], y - kn.c[1], z - kn.c[2]) - kn.r;
    if (dk - 0.35 < d) d = smin(d, dk, 0.35);
  }
  // Nail plate: a shallow raised shield on the back of the distal phalanx.
  if (distal < 0.3) {
    const n = nailCoords(f, x, y, z);
    if (n.mask > 0) d -= 0.045 * n.mask;
  }
  return d;
}

/** Local coordinates on the distal phalanx, used for the nail. */
function nailCoords(f: DigitField, x: number, y: number, z: number): { mask: number; edge: number } {
  const s = f.segments[2];
  const px = x - s.a[0], py = y - s.a[1], pz = z - s.a[2];
  const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
  const u = (px * s.axis[0] + py * s.axis[1] + pz * s.axis[2]) / len;
  const v = px * s.lateral[0] + py * s.lateral[1] + pz * s.lateral[2];
  const w = -(px * s.palmar[0] + py * s.palmar[1] + pz * s.palmar[2]);
  if (w <= 0) return { mask: 0, edge: 0 };
  const halfWidth = (s.ra * 0.62 + s.rb * 0.62) / 2;
  // Proximal edge is a rounded cuticle; the plate runs to just past the tip.
  const across = Math.abs(v) / halfWidth;
  const start = 0.3 + 0.1 * across * across;
  const along = smoothstep(start, start + 0.06, u) * (1 - smoothstep(1.02, 1.12, u));
  const side = 1 - smoothstep(0.82, 1.0, across);
  const back = smoothstep(0.2, 0.55, w / s.rb);
  const mask = along * side * back;
  // Lunula and free edge are lighter.
  const edge = smoothstep(0.93, 1.0, u) + (1 - smoothstep(start + 0.03, start + 0.14, u)) * (1 - across);
  return { mask, edge: Math.min(1, edge) * mask };
}

function sdPalm(fd: Field, x: number, y: number, z: number): number {
  let d = sdCone(fd.forearm, x, y, (z - fd.forearm.az) / 0.62 + fd.forearm.az) * 0.62;
  for (const { e, k } of fd.palmEllipsoids) {
    const bound = Math.hypot(x - e.c[0], y - e.c[1], z - e.c[2]) - e.rmax;
    if (bound - k < d) d = smin(d, sdEllipsoid(e, x, y, z), k);
  }
  for (const { cone, k } of fd.palmCones) {
    const bound = Math.hypot(x - cone.cx, y - cone.cy, z - cone.cz) - cone.cr;
    if (bound - k < d) d = smin(d, sdCone(cone, x, y, z), k);
  }
  for (const w of fd.webs) {
    if (Math.hypot(x - w.cx, y - w.cy, z - w.cz) - w.cr - 0.6 < d) d = smin(d, sdCone(w, x, y, z), 0.6);
  }
  const h = fd.hollow;
  if (Math.hypot(x - h.c[0], y - h.c[1], z - h.c[2]) - h.rmax - 0.9 < -d) d = -smin(-d, sdEllipsoid(h, x, y, z), 0.9);
  return d;
}

export function sdf(fd: Field, x: number, y: number, z: number): number {
  let d = sdPalm(fd, x, y, z);
  for (const f of fd.digits) {
    const bound = Math.hypot(x - f.bc[0], y - f.bc[1], z - f.bc[2]) - f.br;
    if (bound - f.k > d) continue;
    d = smin(d, sdDigit(f, x, y, z), f.k);
  }
  for (const c of fd.cords) {
    if (Math.hypot(x - c.cx, y - c.cy, z - c.cz) - c.cr - 0.45 < d) d = smin(d, sdCone(c, x, y, z), 0.4);
  }
  for (const e of fd.nodules) {
    if (Math.hypot(x - e.c[0], y - e.c[1], z - e.c[2]) - e.rmax - 0.5 < d) d = smin(d, sdEllipsoid(e, x, y, z), 0.5);
  }
  // Clean cut across the forearm, as on a display model, with a small bevel.
  const cut = fd.cutY - y;
  return -smin(-d, -cut, 0.25);
}

// --- Surface colour ---------------------------------------------------------

const SKIN: Vec3 = [0.83, 0.69, 0.61];
const PALM: Vec3 = [0.88, 0.76, 0.69];
const FLUSH: Vec3 = [0.83, 0.62, 0.56];
const NAIL: Vec3 = [0.93, 0.8, 0.76];
const NAIL_EDGE: Vec3 = [0.97, 0.93, 0.89];
const CREASE: Vec3 = [0.72, 0.52, 0.46];
const CUT_FACE: Vec3 = [0.93, 0.9, 0.86];
const BLANCH: Vec3 = [0.93, 0.83, 0.75];

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function distToPolyline(pts: [number, number][], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

// The three principal palmar creases, in the palm plane.
const PALM_CREASES: [number, number][][] = [
  // Distal transverse ("heart line").
  [[-4.0, 7.35], [-2.4, 7.55], [-0.6, 7.95], [0.9, 8.5], [1.7, 9.0]],
  // Proximal transverse ("head line").
  [[3.9, 7.1], [2.4, 6.8], [0.6, 6.35], [-1.3, 5.85], [-2.6, 5.35]],
  // Thenar ("life line").
  [[3.8, 7.0], [2.4, 6.2], [1.35, 4.9], [0.9, 3.3], [1.0, 1.6], [1.3, 0.6]],
  // Wrist creases.
  [[-2.3, 0.25], [0, 0.05], [2.4, 0.3]],
  [[-2.2, -0.45], [0, -0.6], [2.3, -0.4]],
];

export function colorAt(fd: Field, p: Vec3, n: Vec3): Vec3 {
  const [x, y, z] = p;
  if (y < fd.cutY + 0.02 && n[1] < -0.8) return CUT_FACE;

  // Palmar skin is paler than dorsal skin.
  let c = mix(SKIN, PALM, smoothstep(-0.1, 0.6, n[2]));

  // Which digit, if any, is this point on?
  let best = Infinity;
  let digit: DigitField | null = null;
  for (const f of fd.digits) {
    let d = Infinity;
    for (const cone of f.cones) d = Math.min(d, sdCone(cone, x, y, z));
    if (d < best) {
      best = d;
      digit = f;
    }
  }
  const onDigit = digit !== null && best < 0.35;

  if (onDigit && digit) {
    const segs = digit.segments;
    // Warmer, pinker fingertips and knuckles.
    const tip = segs[2].b;
    const dTip = Math.hypot(x - tip[0], y - tip[1], z - tip[2]);
    c = mix(c, FLUSH, 0.45 * (1 - smoothstep(0.4, 1.6, dTip)));
    for (let i = 1; i < 3; i++) {
      const j = segs[i].a;
      const back = -dot(n, segs[i].palmar);
      const dj = Math.hypot(x - j[0], y - j[1], z - j[2]);
      c = mix(c, FLUSH, 0.35 * smoothstep(0.3, 0.9, back) * (1 - smoothstep(0.6, 1.1, dj)));
    }
    // Flexion creases on the palmar side of each joint.
    for (let i = 0; i < 3; i++) {
      const s = segs[i];
      const facing = smoothstep(0.35, 0.8, dot(n, s.palmar));
      if (facing <= 0) continue;
      const u = (x - s.a[0]) * s.axis[0] + (y - s.a[1]) * s.axis[1] + (z - s.a[2]) * s.axis[2];
      const offsets = digit.isThumb ? (i === 2 ? [0] : []) : i === 0 ? [1.55] : [-0.08, 0.12];
      for (const o of offsets) {
        const g = Math.exp(-(((u - o) / 0.075) ** 2));
        c = mix(c, CREASE, 0.3 * g * facing);
      }
    }
    const nail = nailCoords(digit, x, y, z);
    if (nail.mask > 0) {
      c = mix(c, NAIL, nail.mask);
      c = mix(c, NAIL_EDGE, nail.edge * 0.8);
    }
  } else {
    const facing = smoothstep(0.3, 0.75, n[2]);
    if (facing > 0) {
      for (const line of PALM_CREASES) {
        const d = distToPolyline(line, x, y);
        c = mix(c, CREASE, 0.26 * Math.exp(-((d / 0.075) ** 2)) * facing);
      }
    }
  }

  // Skin over a tense cord blanches slightly.
  for (const cone of fd.cords) {
    const d = sdCone(cone, x, y, z);
    c = mix(c, BLANCH, 0.5 * (1 - smoothstep(0.05, 0.5, d)));
  }
  return c;
}

export function normalAt(fd: Field, p: Vec3): Vec3 {
  const e = 0.015;
  const [x, y, z] = p;
  const nx = sdf(fd, x + e, y, z) - sdf(fd, x - e, y, z);
  const ny = sdf(fd, x, y + e, z) - sdf(fd, x, y - e, z);
  const nz = sdf(fd, x, y, z + e) - sdf(fd, x, y, z - e);
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
