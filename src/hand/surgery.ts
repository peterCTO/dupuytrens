// The geometry of the Z-plasties used to close a fasciectomy.
//
// Each site is a Z: a central limb (A to B) along the cord and two side limbs
// of the same length leaving its ends at 60 degrees on opposite sides (B to
// C and A to D). The two triangular flaps it outlines are raised to reach the
// cord, and once the cord is out they are swapped over: the central limb
// turns through 90 degrees and the skin gains length along the finger, so the
// scar does not contract into a new band.
//
// A site is described in its own frame: u along the ray, v across it towards
// the thumb, n out of the skin. In the palm the frame is flat; on a finger it
// rides on the proximal phalanx and moves with it.

import { Cord, FINGER_IDS, FINGER_SPECS, FingerId, FingerPose, HandPose, Operation, PALM_DEPTH, Skeleton, SiteSpec, Vec3, add, dot, hasDigitalCord, scale, sub, buildSkeleton } from './anatomy';
import { buildField, type Field, type Layer } from './sdf';

export type P2 = [number, number];

export interface SiteFrame {
  /** A point under the skin at the centre of the site (in the cord's layer). */
  o: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

export interface SiteGeom {
  frame: SiteFrame;
  /** Length of each limb of the Z, cm. */
  limb: number;
  /** How deep the flaps are raised (skin and fat), cm. */
  depth: number;
  /** Points further behind o than this (along -n) are on the far side of the hand. */
  back: number;
}

const SIN60 = Math.sin(Math.PI / 3);

/** The Z in its site's (u, v) coordinates. */
export function zShape(limb: number) {
  const h = limb / 2;
  const s = limb * SIN60;
  const a: P2 = [-h, 0];
  const b: P2 = [h, 0];
  const c: P2 = [0, s];
  const d: P2 = [0, -s];
  // After transposition the central limb lies across the ray and the Z spans the old diagonal C-D along it.
  const p0: P2 = [-s, 0];
  const p1: P2 = [0, h];
  const p2: P2 = [0, -h];
  const p3: P2 = [s, 0];
  return {
    a, b, c, d,
    /** The cut, in one stroke: D to A to B to C. */
    incision: [d, a, b, c] as P2[],
    /** The window the two flaps cover, in order around it. */
    window: [a, d, b, c] as P2[],
    /** The two flaps, hinge first: flap 1 (A, C | B) and flap 2 (B, D | A). */
    flaps: [
      { hinge: [a, c] as [P2, P2], tip: b, to: [p0, p1, p2] as [P2, P2, P2] },
      { hinge: [b, d] as [P2, P2], tip: a, to: [p3, p2, p1] as [P2, P2, P2] },
    ],
    scar: [p0, p1, p2, p3] as P2[],
  };
}

/** Where the sutures go along a closed Z: evenly along each limb, one at each corner. */
export function stitchSlots(limb: number): { at: P2; dir: P2 }[] {
  const scar = zShape(limb).scar;
  const out: { at: P2; dir: P2 }[] = [];
  for (let i = 0; i + 1 < scar.length; i++) {
    const [p, q] = [scar[i], scar[i + 1]];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dir = norm2([q[0] - p[0], q[1] - p[1]]);
    if (i > 0) {
      const prev = norm2([p[0] - scar[i - 1][0], p[1] - scar[i - 1][1]]);
      out.push({ at: p, dir: norm2([dir[0] + prev[0], dir[1] + prev[1]]) });
    }
    const n = Math.max(2, Math.round(len / 0.32));
    for (let k = 1; k < n; k++) out.push({ at: [p[0] + (q[0] - p[0]) * (k / n), p[1] + (q[1] - p[1]) * (k / n)], dir });
  }
  return out;
}

/** The Z-plasty sites an operation on these fingers needs, from their state before surgery. */
export function sitesFor(pose: HandPose, fingers: FingerId[]): SiteSpec[] {
  const out: SiteSpec[] = [];
  for (const f of FINGER_IDS) {
    if (!fingers.includes(f)) continue;
    const p = pose[f];
    if (p.cord.present || (p.affected && !hasDigitalCord(p))) out.push({ finger: f, where: 'palm', open: false });
    if (hasDigitalCord(p)) out.push({ finger: f, where: 'finger', open: false });
  }
  return out;
}

export const siteId = (s: { finger: FingerId; where: string }) => `${s.finger}:${s.where}`;

/** The frame and size of a site for the hand as it is now posed. */
export function siteGeom(site: { finger: FingerId; where: 'palm' | 'finger' }, pose: HandPose, sk: Skeleton): SiteGeom {
  const spec = FINGER_SPECS[site.finger];
  if (site.where === 'palm') {
    const along: Vec3 = [Math.sin(spec.splay), Math.cos(spec.splay), 0];
    const across: Vec3 = [along[1], -along[0], 0];
    const cord = pose[site.finger].cord;
    // Centre the Z on the part of the cord that lies in the palm, keeping its
    // distal end short of the crease at the base of the finger.
    let limb = 1.5;
    let back = 1.6;
    if (cord.present) {
      const near = Math.max(0.3, cord.start - cord.length);
      limb = Math.min(1.7, Math.max(1.2, (cord.start - near) * 0.8));
      back = (cord.start + near) / 2;
    }
    back = Math.max(back, limb / 2 + 0.45);
    const o: Vec3 = [spec.mcp[0] - along[0] * back, spec.mcp[1] - along[1] * back, PALM_DEPTH];
    return { frame: { o, u: along, v: across, n: [0, 0, 1] }, limb, depth: 0.72, back: 1.0 };
  }
  const digit = sk.digits.find((d) => d.id === site.finger)!;
  const seg = digit.segments[0];
  const len = Math.hypot(...sub(seg.b, seg.a));
  const o = add(seg.a, scale(seg.axis, len * 0.52));
  // The segment's lateral axis points to the thumb side, like the palm's v.
  return { frame: { o, u: seg.axis, v: seg.lateral, n: seg.palmar }, limb: Math.min(1.1, len * 0.28), depth: 0.48, back: 0.15 };
}

/** The geometry of every open site, for hollowing out the field. */
export function openSiteGeoms(pose: HandPose, op: Operation | null, sk: Skeleton): SiteGeom[] {
  return (op?.sites ?? []).filter((s) => s.open).map((s) => siteGeom(s, pose, sk));
}

/** Whether a cord runs under a site's window, where cutting through the window would divide it. */
export function cordUnderSite(g: SiteGeom, cord: Cord): boolean {
  const win = zShape(g.limb).window;
  for (let i = 0; i + 1 < cord.points.length; i++) {
    const [a, b] = [cord.points[i], cord.points[i + 1]];
    for (let t = 0; t <= 1; t += 0.05) {
      const p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const [u, v, w] = toFrame(g.frame, p);
      if (w > -g.back && polygonDistance(win, u, v) < 0.1) return true;
    }
  }
  return false;
}

/** The field of the hand (or a dressing over it) for a pose part-way through an operation. */
export function fieldFor(pose: HandPose, op: Operation | null, layer: Layer = 'skin'): Field {
  const sk = buildSkeleton(pose, op);
  const fingers = [...new Set((op?.sites ?? []).map((s) => s.finger))];
  return buildField(sk, openSiteGeoms(pose, op, sk), layer, fingers);
}

/** A point of the site's plane, as (u, v) and height above o along n. */
export function framePoint(f: SiteFrame, u: number, v: number, w: number): Vec3 {
  return [0, 1, 2].map((k) => f.o[k] + f.u[k] * u + f.v[k] * v + f.n[k] * w) as Vec3;
}

/** A point's (u, v, w) coordinates in a site's frame. */
export function toFrame(f: SiteFrame, p: Vec3): Vec3 {
  const d = sub(p, f.o);
  return [dot(d, f.u), dot(d, f.v), dot(d, f.n)];
}

/** Signed distance to a convex polygon in 2D (negative inside). */
export function polygonDistance(poly: P2[], x: number, y: number): number {
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [p, q] = [poly[i], poly[(i + 1) % poly.length]];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const t = Math.max(0, Math.min(1, ((x - p[0]) * ex + (y - p[1]) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x - p[0] - ex * t, y - p[1] - ey * t));
    // Clockwise or anticlockwise, a point outside is on the wrong side of some edge.
    if ((ex * (y - p[1]) - ey * (x - p[0])) * orientation(poly) < 0) inside = false;
  }
  return inside ? -best : best;
}

function orientation(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [p, q] = [poly[i], poly[(i + 1) % poly.length]];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.sign(a);
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

/**
 * How a finger responds as its cords are cut: the palm cord holds the
 * knuckle, the digital cord the middle joint, which rarely comes fully straight.
 */
export function releasedPose(before: FingerPose, palmCut: boolean, digitalCut: boolean, hadPalm: boolean, hadDigital: boolean): Pick<FingerPose, 'mcp' | 'pip' | 'dip'> {
  const mcpFree = (!hadPalm || palmCut) && (!hadDigital || digitalCut || hadPalm);
  const pipFree = !hadDigital || digitalCut;
  return {
    mcp: mcpFree ? 0 : before.mcp,
    pip: pipFree ? (before.pip > 60 ? Math.round(before.pip * 0.3) : Math.round(before.pip * 0.15)) : before.pip,
    dip: pipFree ? Math.min(before.dip, 5) : before.dip,
  };
}
