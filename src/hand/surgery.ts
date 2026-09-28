// The geometry of a Z-plasty over one ray of the palm.
//
// A straight incision (the central limb, A to B) runs along the cord. Two
// side limbs of the same length leave its ends at 60 degrees on opposite
// sides (B to C, A to D), making a Z. Once the cord is out, the two
// triangular flaps are swapped over: the central limb turns through 90
// degrees and the skin gains length along the finger, so the scar does not
// contract into a new band.

import { FINGER_SPECS, FingerId, HandPose } from './anatomy';

export type P2 = [number, number];

export interface ZPlan {
  finger: FingerId;
  /** Length of each limb, cm. */
  limb: number;
  /** Centre of the Z, and unit vectors along the ray and across it (radial). */
  centre: P2;
  along: P2;
  across: P2;
  a: P2;
  b: P2;
  c: P2;
  d: P2;
  /** The cut, traced in one stroke: D to A to B to C. */
  incision: P2[];
  /** The closed Z after the flaps are transposed. */
  scar: P2[];
  /** Where the sutures go along the scar, with the direction of the scar there. */
  stitches: { at: P2; dir: P2 }[];
}

const SIN60 = Math.sin(Math.PI / 3);

export function planZ(pose: HandPose, finger: FingerId): ZPlan {
  const spec = FINGER_SPECS[finger];
  const along: P2 = [Math.sin(spec.splay), Math.cos(spec.splay)];
  const across: P2 = [along[1], -along[0]];
  const cord = pose[finger].cord;

  // Centre the Z on the part of the cord that lies in the palm, keeping the
  // distal end of the incision short of the crease at the base of the finger.
  let limb = 1.5;
  let back = 1.6;
  if (cord.present) {
    const near = Math.max(0.3, cord.start - cord.length);
    limb = Math.min(1.8, Math.max(1.2, (cord.start - near) * 0.8));
    back = (cord.start + near) / 2;
  }
  back = Math.max(back, limb / 2 + 0.45);

  const mcp = spec.mcp;
  const centre: P2 = [mcp[0] - along[0] * back, mcp[1] - along[1] * back];
  // A point at (u along the ray, v across it) from the centre.
  const at = (u: number, v: number): P2 => [
    centre[0] + along[0] * u + across[0] * v,
    centre[1] + along[1] * u + across[1] * v,
  ];
  const h = limb / 2;
  const a = at(-h, 0);
  const b = at(h, 0);
  // Side limbs at 60 degrees: from B back and to the thumb side, from A forward and to the little-finger side.
  const c = at(h - limb * 0.5, limb * SIN60);
  const d = at(-h + limb * 0.5, -limb * SIN60);

  // After transposition: the central limb lies across the ray and the Z
  // spans the old diagonal C-D along it.
  const s = limb * SIN60;
  const scar = [at(-s, 0), at(0, h), at(0, -h), at(s, 0)];

  const stitches: ZPlan['stitches'] = [];
  for (let i = 0; i + 1 < scar.length; i++) {
    const [p, q] = [scar[i], scar[i + 1]];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dir: P2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const n = Math.max(2, Math.round(len / 0.34));
    // Skip the far end of each limb; the next limb starts there. The very tips get none.
    for (let k = 1; k < n; k++) {
      const t = k / n;
      stitches.push({ at: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], dir });
    }
    if (i > 0) stitches.push({ at: p, dir: norm2([dir[0] + prevDir(scar, i)[0], dir[1] + prevDir(scar, i)[1]]) });
  }

  return { finger, limb, centre, along, across, a, b, c, d, incision: [d, a, b, c], scar, stitches };
}

function prevDir(pts: P2[], i: number): P2 {
  const [p, q] = [pts[i - 1], pts[i]];
  return norm2([q[0] - p[0], q[1] - p[1]]);
}

function norm2(p: P2): P2 {
  const l = Math.hypot(p[0], p[1]) || 1;
  return [p[0] / l, p[1] / l];
}

/** Length of a polyline. */
export function pathLength(pts: P2[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return l;
}

/** The point a distance s along a polyline. */
export function pointAlong(pts: P2[], s: number): P2 {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p, q] = [pts[i], pts[i + 1]];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (s <= l || i + 2 === pts.length) {
      const t = Math.max(0, Math.min(1, s / l));
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
    s -= l;
  }
  return pts[pts.length - 1];
}

/** The nearest point on a polyline: how far along it lies and how far away it is. */
export function project(pts: P2[], x: number, y: number): { s: number; dist: number } {
  let best = { s: 0, dist: Infinity };
  let base = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p, q] = [pts[i], pts[i + 1]];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / l2));
    const dist = Math.hypot(x - p[0] - dx * t, y - p[1] - dy * t);
    if (dist < best.dist) best = { s: base + t * Math.sqrt(l2), dist };
    base += Math.sqrt(l2);
  }
  return best;
}

/** How a contracture usually responds once its cord is out: the knuckle fully, the middle joint only partly. */
export function releasedAngles(mcp: number, pip: number, dip: number): { mcp: number; pip: number; dip: number } {
  return {
    mcp: 0,
    pip: pip > 60 ? Math.round(pip * 0.3) : Math.round(pip * 0.15),
    dip: Math.min(dip, 5),
  };
}
