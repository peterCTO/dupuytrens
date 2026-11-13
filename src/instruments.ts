// Instruments and small anatomy drawn as ordinary meshes: the scalpel, the
// skin marker, the needle, sutures, and the digital nerves and arteries that
// lie beside the cord. All positions are in the hand's own frame (cm).

import * as THREE from 'three';
import type { Vec3 } from './hand/anatomy';

const steel = new THREE.MeshPhysicalMaterial({ color: 0xd4d6d8, metalness: 1, roughness: 0.28, envMapIntensity: 1.2 });
const blade = new THREE.MeshPhysicalMaterial({ color: 0xe8eaec, metalness: 1, roughness: 0.14, envMapIntensity: 1.4 });
const nylon = new THREE.MeshStandardMaterial({ color: 0x1e2847, roughness: 0.45 });
const violet = new THREE.MeshStandardMaterial({ color: 0x5a2f84, roughness: 0.5 });
const penBody = new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.45 });
const nerve = new THREE.MeshPhysicalMaterial({ color: 0xf1e3b2, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.4 });
const artery = new THREE.MeshPhysicalMaterial({ color: 0xb4564d, roughness: 0.34, clearcoat: 0.5, clearcoatRoughness: 0.35 });

const V = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, segments = 24): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, 8, false), material);
  mesh.castShadow = true;
  return mesh;
}

// Every tool is built with its working tip at the origin and its handle along +x.

/** A scalpel with a No. 15 blade; the cutting edge faces -y. */
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
  // Knurled grip, suggested by a few ridges.
  for (let i = 0; i < 6; i++) {
    const ring = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.14), steel);
    ring.position.set(3.2 + i * 0.25, 0.02, 0);
    g.add(ring);
  }
  g.add(b, handle);
  g.traverse((o) => (o.castShadow = true));
  return g;
}

/** A fine-tipped surgical skin marker. */
export function makeMarker(): THREE.Group {
  const g = new THREE.Group();
  const along = (geo: THREE.BufferGeometry) => geo.rotateZ(-Math.PI / 2);
  const tip = new THREE.Mesh(along(new THREE.ConeGeometry(0.07, 0.5, 16)), violet);
  tip.position.x = 0.25;
  const body = new THREE.Mesh(along(new THREE.CylinderGeometry(0.22, 0.2, 6, 20)), penBody);
  body.position.x = 0.5 + 3;
  const cap = new THREE.Mesh(along(new THREE.CylinderGeometry(0.23, 0.23, 1.2, 20)), violet);
  cap.position.x = 5.8;
  g.add(tip, body, cap);
  g.traverse((o) => (o.castShadow = true));
  return g;
}

/** A needle holder gripping a curved needle with its thread. */
export function makeNeedle(): THREE.Group {
  const g = new THREE.Group();
  // Half-circle needle, point at the origin.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = (Math.PI * i) / 16;
    pts.push(new THREE.Vector3(0.22 - Math.cos(a) * 0.22, 0, -Math.sin(a) * 0.22));
  }
  g.add(tube(pts, 0.012, steel, 24));
  const jaws = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.08), steel);
  jaws.position.set(0.62, 0, -0.18);
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.1, 0.1), steel);
  shaft.position.set(0.85 + 2.75, 0, -0.18);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.05, 8, 24), steel);
  ring.position.set(6.6, 0, -0.18);
  ring.rotation.x = Math.PI / 2;
  g.add(jaws, shaft, ring);
  // Thread trailing from the needle's other end.
  g.add(tube([new THREE.Vector3(0.44, 0, 0), new THREE.Vector3(0.9, 0.2, 0.2), new THREE.Vector3(1.6, 0.6, 0.1), new THREE.Vector3(2.4, 0.8, 0.5)], 0.008, nylon, 16));
  g.traverse((o) => (o.castShadow = true));
  return g;
}

/** Touch a tool's tip to the skin at `at`, leaning back from the direction of travel like a pen. */
export function poseTool(tool: THREE.Object3D, at: THREE.Vector3, dir: THREE.Vector3, n: THREE.Vector3) {
  const up = n.clone().normalize();
  const back = dir.clone().sub(up.clone().multiplyScalar(dir.dot(up))).normalize().negate();
  if (!isFinite(back.x)) back.set(0, -1, 0);
  // The handle rises about 50 degrees from the skin and trails the stroke.
  const axis = back.clone().multiplyScalar(0.62).add(up.clone().multiplyScalar(0.78)).normalize();
  const yAxis = up.clone().sub(axis.clone().multiplyScalar(up.dot(axis))).normalize();
  const zAxis = new THREE.Vector3().crossVectors(axis, yAxis).normalize();
  tool.matrix.makeBasis(axis, yAxis, zAxis).setPosition(at);
  tool.matrix.decompose(tool.position, tool.quaternion, tool.scale);
}

/** A digital nerve and artery either side of the cord, along a path of points under the skin. */
export function makeBundles(paths: { nerve: Vec3[]; artery: Vec3[] }[]): THREE.Group {
  const g = new THREE.Group();
  for (const p of paths) {
    g.add(tube(p.nerve.map(V), 0.068, nerve, 32));
    g.add(tube(p.artery.map(V), 0.05, artery, 32));
  }
  return g;
}

/** One interrupted nylon suture across a closed wound. */
export function makeStitch(at: Vec3, along: Vec3, n: Vec3): THREE.Group {
  const g = new THREE.Group();
  const t = V(along).normalize();
  const up = V(n).normalize();
  const across = new THREE.Vector3().crossVectors(up, t).normalize();
  const w = 0.13;
  const p = (u: number, v: number, dz: number) =>
    V(at).add(across.clone().multiplyScalar(u)).add(t.clone().multiplyScalar(v)).add(up.clone().multiplyScalar(dz));
  g.add(tube([p(-w, 0, -0.03), p(-w * 0.9, 0, 0.02), p(-w * 0.4, 0, 0.045), p(w * 0.4, 0, 0.045), p(w * 0.9, 0, 0.02), p(w, 0, -0.03)], 0.011, nylon, 16));
  // Knot to one side with two short cut ends.
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), nylon);
  knot.position.copy(p(w * 0.55, 0, 0.05));
  g.add(knot);
  g.add(tube([p(w * 0.55, 0, 0.05), p(w * 0.75, 0.05, 0.1), p(w * 0.9, 0.12, 0.12)], 0.009, nylon, 6));
  g.add(tube([p(w * 0.55, 0, 0.05), p(w * 0.8, -0.06, 0.08), p(w * 1.0, -0.12, 0.08)], 0.009, nylon, 6));
  return g;
}

/** A small violet dot marking where a stitch should go. */
export function makeStitchMark(at: Vec3, n: Vec3): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12), violet);
  m.position.copy(V(at).add(V(n).multiplyScalar(0.01)));
  m.lookAt(m.position.clone().add(V(n)));
  return m;
}
