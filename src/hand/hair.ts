// Fine body hair: short curved strands on the back of the hand, the backs of
// the proximal phalanges and the forearm, none on the palm.

import { buildSkeleton, HandPose, Vec3 } from './anatomy';
import { CUT_Y } from './sdf';

export interface HairSet {
  /** Line-segment vertices for hairs on parts that never move. */
  fixed: Float32Array;
  /** Line-segment vertices for hairs on the fingers, which move with the pose. */
  fingers: Float32Array;
}

/** Deterministic 0..1 value from a position, so hair stays put between rebuilds. */
function rand(x: number, y: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 97) ^ Math.imul(Math.round(y * 89), 7919), 374761393);
  h = Math.imul(h ^ Math.round(z * 83) ^ Math.imul(salt, 668265263), 1274126177);
  h ^= h >>> 15;
  return ((Math.imul(h, 2246822519) >>> 0) % 100000) / 100000;
}

const SEGMENTS = 3;

function strand(out: number[], root: Vec3, n: Vec3, dir: Vec3, length: number, lift: number, sway: number) {
  // Tangent direction: dir with its normal component removed.
  const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
  let t: Vec3 = [dir[0] - n[0] * dn, dir[1] - n[1] * dn, dir[2] - n[2] * dn];
  const tl = Math.hypot(...t) || 1;
  t = [t[0] / tl, t[1] / tl, t[2] / tl];
  const side: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  let p: Vec3 = [root[0] + n[0] * 0.004, root[1] + n[1] * 0.004, root[2] + n[2] * 0.004];
  for (let i = 0; i < SEGMENTS; i++) {
    // Leaves the skin at an angle, then curls back towards it.
    const up = lift * (1 - (i / SEGMENTS) * 1.3);
    const step = length / SEGMENTS;
    const q: Vec3 = [
      p[0] + (t[0] + n[0] * up + side[0] * sway * i) * step,
      p[1] + (t[1] + n[1] * up + side[1] * sway * i) * step,
      p[2] + (t[2] + n[2] * up + side[2] * sway * i) * step,
    ];
    out.push(...p, ...q);
    p = q;
  }
}

export function growHair(
  pose: HandPose,
  positions: Float32Array,
  normals: Float32Array,
  weights: Float32Array,
  shading: Float32Array,
  cellArea: number,
): HairSet {
  const sk = buildSkeleton(pose);
  const fixed: number[] = [];
  const fingers: number[] = [];
  const count = positions.length / 3;
  for (let v = 0; v < count; v++) {
    const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2];
    if (y < CUT_Y + 0.25 || shading[3 * v] > 0.05) continue;
    const n: Vec3 = [normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]];

    // Which finger (if any) carries this vertex, and how far along it.
    let share = 0, finger = -1;
    for (let f = 0; f < 4; f++) {
      const w = weights[16 * v + 4 * f] * weights[16 * v + 4 * f + 1];
      if (w > share) {
        share = w;
        finger = f;
      }
    }

    let density = 0, length = 0, dir: Vec3 = [-0.15, 1, 0], out = fixed;
    if (share > 0.6 && finger >= 0) {
      // Proximal phalanx only, on its back.
      const past = weights[16 * v + 4 * finger + 1];
      const beyondPip = weights[16 * v + 4 * finger + 2];
      const seg = sk.digits[finger + 1].segments[0];
      const back = -(n[0] * seg.palmar[0] + n[1] * seg.palmar[1] + n[2] * seg.palmar[2]);
      if (past > 0.9 && beyondPip < 0.05 && back > 0.45) {
        density = 7 * (back - 0.45) * 2;
        length = 0.14 + 0.14 * rand(x, y, z, 3);
        dir = seg.axis;
        out = fingers;
      }
    } else if (share < 0.05) {
      if (y < 0.4) {
        // Forearm: all round, thinner on the flexor side.
        density = n[2] > 0.4 ? 2 : 11;
        length = 0.35 + 0.35 * rand(x, y, z, 3);
      } else if (n[2] < -0.25 && y < 9.2) {
        // Back of the hand, thinning towards the knuckles.
        density = 4.5 * (1 - Math.max(0, (y - 6.5) / 2.7));
        length = 0.22 + 0.25 * rand(x, y, z, 3);
      }
    }
    if (density <= 0 || rand(x, y, z, 1) > density * cellArea) continue;
    const lift = 0.25 + 0.25 * rand(x, y, z, 4);
    const sway = (rand(x, y, z, 5) - 0.5) * 0.5;
    const jitter: Vec3 = [dir[0] + (rand(x, y, z, 6) - 0.5) * 0.5, dir[1], dir[2] + (rand(x, y, z, 7) - 0.5) * 0.3];
    strand(out, [x, y, z], n, jitter, length, lift, sway);
  }
  return { fixed: new Float32Array(fixed), fingers: new Float32Array(fingers) };
}
