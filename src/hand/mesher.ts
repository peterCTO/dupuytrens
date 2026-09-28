// Turns the hand's distance field into a triangle mesh with Surface Nets.
//
// The field is only sampled finely near the skin: a coarse pass marks which
// blocks of the grid can contain the surface, and everything else is filled
// with the sign of the coarse sample.

import { Field, sdf, surfaceAt, normalAt, occlusionAt, thicknessAt, sdDigitCones } from './sdf';
import { Skeleton, Vec3, add, norm, dot, sub } from './anatomy';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per vertex: nail gloss, ambient occlusion, flesh thickness. */
  shading: Float32Array;
  indices: Uint32Array;
  /**
   * Skinning weights, 16 per vertex: for each of the four fingers,
   * [share of the vertex that follows this finger, and how far past its
   * MCP, PIP and DIP joints the vertex lies (0 before, 1 after)].
   */
  weights: Float32Array;
}

const JOINT_BLEND = [0.9, 0.42, 0.32];

function skinWeights(sk: Skeleton, fd: Field, p: Vec3, out: Float32Array, o: number) {
  const dists = fd.digits.map((f) => sdDigitCones(f, p[0], p[1], p[2]));
  const dmin = Math.min(...dists);
  const raw = dists.map((d) => (d < 1.2 ? Math.exp(-Math.max(0, d - dmin) / 0.12) : 0));
  const total = raw.reduce((a, b) => a + b, 0);
  for (let f = 0; f < 4; f++) {
    const digit = sk.digits[f + 1];
    const share = total > 0 ? raw[f + 1] / total : 0;
    out[o + 4 * f] = share;
    let prev = 1;
    for (let j = 0; j < 3; j++) {
      const before = j === 0 ? digit.restAxis : digit.segments[j - 1].axis;
      const bisector = norm(add(before, digit.segments[j].axis));
      const s = dot(sub(p, digit.joints[j]), bisector);
      const t = Math.min(1, Math.max(0, (s + JOINT_BLEND[j]) / (2 * JOINT_BLEND[j])));
      prev = Math.min(prev, t * t * (3 - 2 * t));
      out[o + 4 * f + 1 + j] = prev;
    }
  }
}

const BLOCK = 4;

/** The sampling grid for a pose. Every worker derives the same grid from the same pose. */
export interface Grid {
  ox: number; oy: number; oz: number;
  nx: number; ny: number; nz: number;
  h: number;
  /** Number of blocks along z; work is split across workers by block rows. */
  bz: number;
}

export function gridFor(fd: Field, h: number): Grid {
  const pad = 2 * h;
  const size = (a: number) => Math.ceil((fd.max[a] - fd.min[a] + 2 * pad) / h / BLOCK) * BLOCK + 1;
  const nz = size(2);
  return {
    ox: fd.min[0] - pad, oy: fd.min[1] - pad, oz: fd.min[2] - pad,
    nx: size(0), ny: size(1), nz, h,
    bz: (nz - 1) / BLOCK,
  };
}

/**
 * Samples the field for block rows [kb0, kb1) of the grid: grid nodes
 * kb0*BLOCK .. kb1*BLOCK inclusive. Blocks far from the skin are filled with
 * the sign of their centre sample instead of being sampled node by node.
 */
export function sampleSlab(fd: Field, g: Grid, kb0: number, kb1: number): Float32Array {
  const { ox, oy, oz, nx, ny, h } = g;
  const nzLocal = (kb1 - kb0) * BLOCK + 1;
  const sy = nx, sz = nx * ny;
  const values = new Float32Array(nx * ny * nzLocal);
  const known = new Uint8Array(nx * ny * nzLocal);
  const bx = (nx - 1) / BLOCK, by = (ny - 1) / BLOCK;
  const reach = (Math.sqrt(3) * BLOCK * h) / 2;
  const far: { i: number; j: number; k: number; sign: number }[] = [];
  for (let k = kb0; k < kb1; k++) {
    for (let j = 0; j < by; j++) {
      for (let i = 0; i < bx; i++) {
        const d = sdf(fd, ox + (i + 0.5) * BLOCK * h, oy + (j + 0.5) * BLOCK * h, oz + (k + 0.5) * BLOCK * h);
        if (Math.abs(d) > reach * 1.6 + h) {
          far.push({ i, j, k: k - kb0, sign: Math.sign(d) });
          continue;
        }
        for (let c = 0; c <= BLOCK; c++) {
          for (let b = 0; b <= BLOCK; b++) {
            for (let a = 0; a <= BLOCK; a++) {
              const gi = i * BLOCK + a, gj = j * BLOCK + b, lk = (k - kb0) * BLOCK + c;
              const idx = gi + gj * sy + lk * sz;
              if (known[idx]) continue;
              values[idx] = sdf(fd, ox + gi * h, oy + gj * h, oz + (k * BLOCK + c) * h);
              known[idx] = 1;
            }
          }
        }
      }
    }
  }
  for (const f of far) {
    for (let c = 0; c <= BLOCK; c++) {
      for (let b = 0; b <= BLOCK; b++) {
        for (let a = 0; a <= BLOCK; a++) {
          const idx = f.i * BLOCK + a + (f.j * BLOCK + b) * sy + (f.k * BLOCK + c) * sz;
          if (!known[idx]) values[idx] = f.sign * reach;
        }
      }
    }
  }
  return values;
}

/** Surface Nets: one vertex per cell the skin passes through, quads between them. */
export function extractSurface(g: Grid, values: Float32Array): { positions: Float32Array; indices: Uint32Array } {
  const { ox, oy, oz, nx, ny, nz, h } = g;
  const sx = 1, sy = nx, sz = nx * ny;
  const cellIndex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cx1 = nx - 1, cy1 = ny - 1;
  const pos: number[] = [];
  const corner = [0, sx, sy, sx + sy, sz, sx + sz, sy + sz, sx + sy + sz];
  const cornerOffset = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const base = i + j * sy + k * sz;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = values[base + corner[c]];
          if (v[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let px = 0, py = 0, pz = 0, count = 0;
        for (const [e0, e1] of edges) {
          const a = v[e0], b = v[e1];
          if (a < 0 === b < 0) continue;
          const t = a / (a - b);
          const o0 = cornerOffset[e0], o1 = cornerOffset[e1];
          px += o0[0] + (o1[0] - o0[0]) * t;
          py += o0[1] + (o1[1] - o0[1]) * t;
          pz += o0[2] + (o1[2] - o0[2]) * t;
          count++;
        }
        cellIndex[i + j * cx1 + k * cx1 * cy1] = pos.length / 3;
        pos.push(ox + (i + px / count) * h, oy + (j + py / count) * h, oz + (k + pz / count) * h);
      }
    }
  }

  const idx: number[] = [];
  const cell = (i: number, j: number, k: number) => cellIndex[i + j * cx1 + k * cx1 * cy1];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) idx.push(a, b, c, a, c, d);
    else idx.push(a, c, b, a, d, c);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const here = values[i + j * sy + k * sz] < 0;
        if (here !== values[i + 1 + j * sy + k * sz] < 0) {
          quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), here);
        }
        if (here !== values[i + (j + 1) * sy + k * sz] < 0) {
          quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), here);
        }
        if (here !== values[i + j * sy + (k + 1) * sz] < 0) {
          quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), here);
        }
      }
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export type VertexData = Omit<MeshData, 'indices'>;

/** Projects rough vertices onto the skin and works out how each one is shaded and skinned. */
export function shadeVertices(sk: Skeleton, fd: Field, rough: Float32Array): VertexData {
  const count = rough.length / 3;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const weights = new Float32Array(count * 16);
  const shading = new Float32Array(count * 3);
  for (let n = 0; n < count; n++) {
    let p: [number, number, number] = [rough[3 * n], rough[3 * n + 1], rough[3 * n + 2]];
    const d = sdf(fd, p[0], p[1], p[2]);
    const nrm = normalAt(fd, p);
    p = [p[0] - nrm[0] * d, p[1] - nrm[1] * d, p[2] - nrm[2] * d];
    const surface = surfaceAt(fd, p, nrm);
    positions.set(p, 3 * n);
    normals.set(nrm, 3 * n);
    colors.set(surface.color, 3 * n);
    shading[3 * n] = surface.gloss;
    shading[3 * n + 1] = occlusionAt(fd, p, nrm);
    shading[3 * n + 2] = thicknessAt(fd, p, nrm);
    skinWeights(sk, fd, p, weights, 16 * n);
  }
  return { positions, normals, colors, shading, weights };
}

/** Builds the whole mesh on one thread. */
export function meshField(sk: Skeleton, fd: Field, h: number): MeshData {
  const g = gridFor(fd, h);
  const values = sampleSlab(fd, g, 0, g.bz);
  const surface = extractSurface(g, values);
  return { ...shadeVertices(sk, fd, surface.positions), indices: surface.indices };
}
