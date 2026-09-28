// The two triangular skin flaps of a Z-plasty, as separate pieces of skin
// that can be peeled back on their hinge, laid down again and swung into
// their transposed places.
//
// Each flap is a thin slab: its top is sampled from the unbroken skin (so it
// carries the same colour, creases and marks as the skin it came from), its
// underside and cut edges are fat and dermis.

import * as THREE from 'three';
import type { Vec3 } from './hand/anatomy';
import { Field, normalAt, sdf, surfaceAt } from './hand/sdf';
import { P2, SiteGeom, framePoint, zShape } from './hand/surgery';

const SUBDIV = 10;
const FAT: Vec3 = [0.95, 0.86, 0.68];
const DERMIS: Vec3 = [0.86, 0.62, 0.58];

export interface Flap {
  /** Rotates about the hinge. */
  pivot: THREE.Object3D;
  mesh: THREE.Mesh;
  /** Hinge ends and the tip, where they sit on the skin, and the tip's direction of lift. */
  hinge: [Vec3, Vec3];
  tip: Vec3;
  /** Which way round the hinge lifts the flap off the skin. */
  sign: number;
  /** How far the flap is folded back, radians. */
  angle: number;
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** March in from above a point of the site's plane to the skin. */
function skinAt(fd: Field, g: SiteGeom, u: number, v: number): { p: Vec3; n: Vec3 } {
  const f = g.frame;
  const start = framePoint(f, u, v, 3);
  let t = 0;
  for (let i = 0; i < 200; i++) {
    const p: Vec3 = [start[0] - f.n[0] * t, start[1] - f.n[1] * t, start[2] - f.n[2] * t];
    const d = sdf(fd, p[0], p[1], p[2]);
    if (d < 0.002 || t > 6) return { p, n: normalAt(fd, p) };
    t += Math.max(d * 0.8, 0.002);
  }
  const p = framePoint(f, u, v, 0.8);
  return { p, n: f.n };
}

/** Barycentric grid over a triangle: points, and triangles as index triples. */
function grid() {
  const bary: [number, number, number][] = [];
  const index = (i: number, j: number) => (i * (2 * SUBDIV + 3 - i)) / 2 + j;
  for (let i = 0; i <= SUBDIV; i++) for (let j = 0; j <= SUBDIV - i; j++) bary.push([1 - (i + j) / SUBDIV, i / SUBDIV, j / SUBDIV]);
  const tris: [number, number, number][] = [];
  for (let i = 0; i < SUBDIV; i++) {
    for (let j = 0; j < SUBDIV - i; j++) {
      tris.push([index(i, j), index(i + 1, j), index(i, j + 1)]);
      if (j + 1 < SUBDIV - i) tris.push([index(i + 1, j), index(i + 1, j + 1), index(i, j + 1)]);
    }
  }
  // Boundary loop: edge from corner 0 to corner 1 (i increasing), 1 to 2, 2 to 0.
  const loop: number[] = [];
  for (let i = 0; i < SUBDIV; i++) loop.push(index(i, 0));
  for (let k = 0; k < SUBDIV; k++) loop.push(index(SUBDIV - k, k));
  for (let j = SUBDIV; j > 0; j--) loop.push(index(0, j));
  return { bary, tris, loop };
}

const GRID = grid();

/**
 * Fill a flap's geometry for a triangle given in the site's (u, v) plane,
 * corners in the order hinge end, hinge end, tip. `lift` raises it off the skin.
 */
function fillGeometry(geo: THREE.BufferGeometry, fd: Field, g: SiteGeom, tri: [P2, P2, P2], thickness: number, lift = 0) {
  const { bary, tris, loop } = GRID;
  const n = bary.length;
  const top: { p: Vec3; n: Vec3 }[] = bary.map(([a, b, c]) =>
    skinAt(fd, g, tri[0][0] * a + tri[1][0] * b + tri[2][0] * c, tri[0][1] * a + tri[1][1] * b + tri[2][1] * c),
  );
  const pos: number[] = [];
  const col: number[] = [];
  const shade: number[] = [];
  const crease: number[] = [];
  const push = (p: Vec3, c: Vec3, sh: Vec3, cr: number[]) => {
    pos.push(...p);
    col.push(...c.map(srgbToLinear));
    shade.push(...sh);
    crease.push(...cr);
  };
  // Top: the skin itself.
  for (const t of top) {
    const s = surfaceAt(fd, t.p, t.n);
    const p: Vec3 = [t.p[0] + t.n[0] * lift, t.p[1] + t.n[1] * lift, t.p[2] + t.n[2] * lift];
    push(p, s.color, [s.gloss, 1, 0.6], s.crease);
  }
  // Underside: fat, following the top at the flap's thickness.
  for (const t of top) {
    const p: Vec3 = [0, 1, 2].map((k) => t.p[k] + t.n[k] * (lift - thickness)) as Vec3;
    push(p, FAT, [0, 0.95, 1], [9, 0, 0, -1]);
  }
  // Cut edges: a band of dermis over fat, duplicated so they shade crisply.
  const edgeTop = 2 * n;
  for (const i of loop) {
    const t = top[i];
    push([t.p[0] + t.n[0] * lift, t.p[1] + t.n[1] * lift, t.p[2] + t.n[2] * lift], DERMIS, [0, 0.9, 1], [9, 0, 0, -1]);
  }
  const edgeBottom = edgeTop + loop.length;
  for (const i of loop) {
    const t = top[i];
    push([0, 1, 2].map((k) => t.p[k] + t.n[k] * (lift - thickness)) as Vec3, FAT, [0, 0.9, 1], [9, 0, 0, -1]);
  }
  const idx: number[] = [];
  // Wind the top so it faces out of the skin.
  const [i0, i1, i2] = tris[0];
  const e1 = new THREE.Vector3(...top[i1].p).sub(new THREE.Vector3(...top[i0].p));
  const e2 = new THREE.Vector3(...top[i2].p).sub(new THREE.Vector3(...top[i0].p));
  const flip = e1.cross(e2).dot(new THREE.Vector3(...top[i0].n)) < 0;
  for (const [a, b, c] of tris) {
    if (flip) idx.push(a, c, b, n + a, n + b, n + c);
    else idx.push(a, b, c, n + a, n + c, n + b);
  }
  for (let k = 0; k < loop.length; k++) {
    const a = edgeTop + k, b = edgeTop + ((k + 1) % loop.length);
    const c = edgeBottom + k, d = edgeBottom + ((k + 1) % loop.length);
    if (flip) idx.push(a, b, c, b, d, c);
    else idx.push(a, c, b, b, c, d);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('shading', new THREE.Float32BufferAttribute(shade, 3));
  geo.setAttribute('crease', new THREE.Float32BufferAttribute(crease, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return top;
}

/** Make one of a site's two flaps, lying flat in place, cut from the unbroken skin `fd`. */
export function makeFlap(fd: Field, g: SiteGeom, which: 0 | 1, material: THREE.Material): Flap {
  const z = zShape(g.limb);
  const f = z.flaps[which];
  const geo = new THREE.BufferGeometry();
  const top = fillGeometry(geo, fd, g, [f.hinge[0], f.hinge[1], f.tip], thickness(g));
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const corner = (k: number) => top[GRID.bary.findIndex((b) => b[k] === 1)].p;
  const hinge: [Vec3, Vec3] = [corner(0), corner(1)];
  const tip = corner(2);
  const pivot = new THREE.Object3D();
  pivot.position.set(...hinge[0]);
  mesh.position.set(-hinge[0][0], -hinge[0][1], -hinge[0][2]);
  pivot.add(mesh);
  // Lift towards the outside of the skin.
  const axis = new THREE.Vector3(...hinge[1]).sub(new THREE.Vector3(...hinge[0])).normalize();
  const rel = new THREE.Vector3(...tip).sub(new THREE.Vector3(...hinge[0]));
  const moved = rel.clone().applyAxisAngle(axis, 0.1).sub(rel);
  const sign = moved.dot(new THREE.Vector3(...g.frame.n)) >= 0 ? 1 : -1;
  return { pivot, mesh, hinge, tip, sign, angle: 0 };
}

function thickness(g: SiteGeom) {
  return Math.min(0.32, g.depth * 0.5);
}

/** Fold a flap back on its hinge. */
export function setFlapAngle(flap: Flap, angle: number) {
  flap.angle = angle;
  const axis = new THREE.Vector3(...flap.hinge[1]).sub(new THREE.Vector3(...flap.hinge[0])).normalize();
  flap.pivot.quaternion.setFromAxisAngle(axis, angle * flap.sign);
}

/** Move a flap part-way (t from 0 to 1) from its own place to its transposed one. */
export function morphFlap(flap: Flap, fd: Field, g: SiteGeom, which: 0 | 1, t: number) {
  const z = zShape(g.limb);
  const f = z.flaps[which];
  const from: [P2, P2, P2] = [f.hinge[0], f.hinge[1], f.tip];
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  const tri = from.map((p, k) => [p[0] + (f.to[k][0] - p[0]) * e, p[1] + (f.to[k][1] - p[1]) * e] as P2) as [P2, P2, P2];
  flap.pivot.quaternion.identity();
  fillGeometry(flap.mesh.geometry, fd, g, tri, thickness(g), 0.03 + Math.sin(Math.PI * t) * 0.35);
}
