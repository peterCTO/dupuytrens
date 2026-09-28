// Bends an already-built hand mesh towards a new pose while the user drags a
// slider, so the model follows the pointer at full frame rate. When the
// pointer settles, the mesh is rebuilt exactly for the new pose.

import { buildSkeleton, HandPose, Segment, Vec3 } from './anatomy';

/** Rigid transform taking a bind-pose segment onto the same segment in a new pose. */
interface Rigid {
  r: number[]; // 3x3, row-major
  from: Vec3;
  to: Vec3;
}

function frame(s: Segment): number[] {
  // Columns: axis, palmar, lateral.
  return [
    s.axis[0], s.palmar[0], s.lateral[0],
    s.axis[1], s.palmar[1], s.lateral[1],
    s.axis[2], s.palmar[2], s.lateral[2],
  ];
}

function rigid(bind: Segment, now: Segment): Rigid {
  const a = frame(now);
  const b = frame(bind);
  // r = A * B^T
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[3 * i + j] += a[3 * i + k] * b[3 * j + k];
  return { r, from: bind.a, to: now.a };
}

export function skinMesh(
  bindPose: HandPose,
  pose: HandPose,
  bindPositions: Float32Array,
  bindNormals: Float32Array,
  weights: Float32Array,
  outPositions: Float32Array,
  outNormals: Float32Array,
) {
  const bind = buildSkeleton(bindPose);
  const now = buildSkeleton(pose);
  const bones: Rigid[][] = [];
  for (let f = 0; f < 4; f++) {
    bones.push([0, 1, 2].map((i) => rigid(bind.digits[f + 1].segments[i], now.digits[f + 1].segments[i])));
  }
  const n = bindPositions.length / 3;
  for (let v = 0; v < n; v++) {
    const px = bindPositions[3 * v], py = bindPositions[3 * v + 1], pz = bindPositions[3 * v + 2];
    const nx = bindNormals[3 * v], ny = bindNormals[3 * v + 1], nz = bindNormals[3 * v + 2];
    let ox = px, oy = py, oz = pz, onx = nx, ony = ny, onz = nz;
    for (let f = 0; f < 4; f++) {
      const w = weights[16 * v + 4 * f];
      if (w < 1e-4) continue;
      const a0 = weights[16 * v + 4 * f + 1];
      if (a0 < 1e-4) continue;
      const a1 = weights[16 * v + 4 * f + 2];
      const a2 = weights[16 * v + 4 * f + 3];
      const bw = [a0 - a1, a1 - a2, a2];
      for (let i = 0; i < 3; i++) {
        const b = bw[i] * w;
        if (b < 1e-5) continue;
        const { r, from, to } = bones[f][i];
        const dx = px - from[0], dy = py - from[1], dz = pz - from[2];
        ox += b * (r[0] * dx + r[1] * dy + r[2] * dz + to[0] - px);
        oy += b * (r[3] * dx + r[4] * dy + r[5] * dz + to[1] - py);
        oz += b * (r[6] * dx + r[7] * dy + r[8] * dz + to[2] - pz);
        onx += b * (r[0] * nx + r[1] * ny + r[2] * nz - nx);
        ony += b * (r[3] * nx + r[4] * ny + r[5] * nz - ny);
        onz += b * (r[6] * nx + r[7] * ny + r[8] * nz - nz);
      }
    }
    const l = Math.hypot(onx, ony, onz) || 1;
    outPositions[3 * v] = ox;
    outPositions[3 * v + 1] = oy;
    outPositions[3 * v + 2] = oz;
    outNormals[3 * v] = onx / l;
    outNormals[3 * v + 1] = ony / l;
    outNormals[3 * v + 2] = onz / l;
  }
}
