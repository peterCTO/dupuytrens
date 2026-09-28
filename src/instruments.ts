// Instruments and small anatomy drawn as ordinary meshes: the scalpel, skin
// hooks, sutures, and the digital nerves and arteries that lie beside the
// cord. All positions are in the hand's own frame (cm, palm facing +z).

import * as THREE from 'three';
import type { P2, ZPlan } from './hand/surgery';

/** Height of the skin (or wound floor) above a point of the palm plane. */
export type SurfaceZ = (x: number, y: number) => number;

const steel = new THREE.MeshPhysicalMaterial({ color: 0xd4d6d8, metalness: 1, roughness: 0.28, envMapIntensity: 1.2 });
const blade = new THREE.MeshPhysicalMaterial({ color: 0xe8eaec, metalness: 1, roughness: 0.14, envMapIntensity: 1.4 });
const nylon = new THREE.MeshStandardMaterial({ color: 0x1e2847, roughness: 0.45 });
const nerve = new THREE.MeshPhysicalMaterial({ color: 0xf1e3b2, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.4 });
const artery = new THREE.MeshPhysicalMaterial({ color: 0xb4564d, roughness: 0.34, clearcoat: 0.5, clearcoatRoughness: 0.35 });

const v3 = (p: P2, z: number) => new THREE.Vector3(p[0], p[1], z);
const offset = (p: P2, d: P2, s: number): P2 => [p[0] + d[0] * s, p[1] + d[1] * s];

function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, segments = 24): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, 8, false), material);
  mesh.castShadow = true;
  return mesh;
}

/**
 * A scalpel with a No. 15 blade. Its tip is at the origin, the handle runs
 * along +x and the cutting edge faces -y.
 */
export function makeScalpel(): THREE.Group {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.35, -0.2, 0.95, -0.15);
  shape.lineTo(1.35, -0.1);
  shape.lineTo(1.35, 0.1);
  shape.quadraticCurveTo(0.6, 0.12, 0, 0);
  const b = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.015, bevelEnabled: false, curveSegments: 12 }), blade);
  b.position.z = -0.0075;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.28, 0.12), steel);
  handle.position.set(1.3 + 3.6, 0.02, 0);
  // Knurled grip, suggested by a few rings.
  for (let i = 0; i < 6; i++) {
    const ring = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.14), steel);
    ring.position.set(3.2 + i * 0.25, 0.02, 0);
    g.add(ring);
  }
  g.add(b, handle);
  g.traverse((o) => (o.castShadow = true));
  return g;
}

/** Point the scalpel's tip at `at`, leaning back along the cut like a pen. */
export function poseScalpel(scalpel: THREE.Object3D, at: THREE.Vector3, cutDir: P2) {
  const back = new THREE.Vector3(-cutDir[0], -cutDir[1], 0).normalize();
  const up = new THREE.Vector3(0, 0, 1);
  // Handle rises at about 50 degrees from the skin, trailing the cut, tipped slightly towards the viewer.
  const axis = back.clone().multiplyScalar(0.62).add(up.clone().multiplyScalar(0.78)).add(new THREE.Vector3(0, -0.1, 0)).normalize();
  const edge = up.clone().sub(axis.clone().multiplyScalar(up.dot(axis))).normalize().negate();
  const yAxis = edge.clone().negate();
  const zAxis = new THREE.Vector3().crossVectors(axis, yAxis).normalize();
  scalpel.matrix.makeBasis(axis, yAxis, zAxis).setPosition(at);
  scalpel.matrix.decompose(scalpel.position, scalpel.quaternion, scalpel.scale);
}

/** Two skin hooks holding the wound edges apart. */
export function makeHooks(plan: ZPlan, halfWidth: number, skinZ: SurfaceZ): THREE.Group {
  const g = new THREE.Group();
  for (const side of [1, -1]) {
    const dir: P2 = [plan.across[0] * side, plan.across[1] * side];
    const rim = offset(plan.centre, dir, halfWidth + 0.2);
    const zs = skinZ(rim[0], rim[1]);
    const at = (s: number, z: number) => v3(offset(plan.centre, dir, s), zs + z);
    g.add(
      tube(
        [at(halfWidth * 0.78, -0.32), at(halfWidth * 0.92, -0.05), at(halfWidth + 0.05, 0.12), at(halfWidth + 0.3, 0.35), at(halfWidth + 0.7, 1.1), at(halfWidth + 1.0, 2.0)],
        0.032,
        steel,
        48,
      ),
    );
    const handle = tube([at(halfWidth + 1.0, 2.0), at(halfWidth + 1.6, 5.0)], 0.1, steel, 4);
    g.add(handle);
  }
  return g;
}

/** The common digital nerves and arteries running beside the cord in the wound. */
export function makeBundles(plan: ZPlan, floor: number): THREE.Group {
  const g = new THREE.Group();
  const reach = plan.limb / 2 + 0.3;
  for (const side of [1, -1]) {
    for (const [v, r, mat, z] of [
      [0.47, 0.068, nerve, floor + 0.02],
      [0.58, 0.05, artery, floor + 0.0],
    ] as const) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const u = -reach + (2 * reach * i) / 8;
        const wiggle = Math.sin(u * 2.3 + side * 1.7 + v * 5) * 0.03;
        const p: P2 = [
          plan.centre[0] + plan.along[0] * u + plan.across[0] * side * (v + wiggle),
          plan.centre[1] + plan.along[1] * u + plan.across[1] * side * (v + wiggle),
        ];
        pts.push(v3(p, z));
      }
      g.add(tube(pts, r, mat, 32));
    }
  }
  return g;
}

/** Interrupted nylon sutures across the scar. */
export function makeSutures(stitches: { at: P2; dir: P2 }[], skinZ: SurfaceZ): THREE.Group {
  const g = new THREE.Group();
  for (const s of stitches) {
    const perp: P2 = [-s.dir[1], s.dir[0]];
    const z = skinZ(s.at[0], s.at[1]);
    const w = 0.13;
    const p = (u: number, v: number, dz: number) => v3([s.at[0] + perp[0] * u + s.dir[0] * v, s.at[1] + perp[1] * u + s.dir[1] * v], z + dz);
    g.add(tube([p(-w, 0, -0.03), p(-w * 0.9, 0, 0.02), p(-w * 0.4, 0, 0.045), p(w * 0.4, 0, 0.045), p(w * 0.9, 0, 0.02), p(w, 0, -0.03)], 0.011, nylon, 16));
    // Knot to one side with two short cut ends.
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), nylon);
    knot.position.copy(p(w * 0.55, 0, 0.05));
    g.add(knot);
    g.add(tube([p(w * 0.55, 0, 0.05), p(w * 0.75, 0.05, 0.1), p(w * 0.9, 0.12, 0.12)], 0.009, nylon, 6));
    g.add(tube([p(w * 0.55, 0, 0.05), p(w * 0.8, -0.06, 0.08), p(w * 1.0, -0.12, 0.08)], 0.009, nylon, 6));
  }
  return g;
}
