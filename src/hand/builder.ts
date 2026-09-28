// Builds hand meshes on a small pool of workers: the field is sampled in
// slabs in parallel, one worker extracts the surface, and the vertices are
// then shaded in parallel chunks.

import { buildSkeleton, HandPose } from './anatomy';
import { buildField } from './sdf';
import { gridFor, MeshData, VertexData } from './mesher';
import type { Job } from './worker';

type Reply = Record<string, Float32Array | Uint32Array | number>;
type JobInput = Job extends infer J ? (J extends Job ? Omit<J, 'id'> : never) : never;

export class MeshBuilder {
  private workers: Worker[];
  private pending = new Map<number, (r: Reply) => void>();
  private nextId = 1;

  constructor() {
    const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<Reply>) => {
        const id = e.data.id as number;
        this.pending.get(id)?.(e.data);
        this.pending.delete(id);
      };
      return w;
    });
  }

  private run(worker: number, job: JobInput, transfer: Transferable[] = []): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.workers[worker].postMessage({ ...job, id }, transfer);
    });
  }

  async build(pose: HandPose, h: number): Promise<MeshData> {
    const n = this.workers.length;
    const g = gridFor(buildField(buildSkeleton(pose)), h);
    const sz = g.nx * g.ny;

    // Slabs of block rows, sampled in parallel and stitched together.
    const rows = Array.from({ length: n }, (_, i) => [Math.round((g.bz * i) / n), Math.round((g.bz * (i + 1)) / n)]);
    const slabs = await Promise.all(
      rows.map(([kb0, kb1], i) => (kb1 > kb0 ? this.run(i, { type: 'sample', pose, h, kb0, kb1 }) : null)),
    );
    const values = new Float32Array(sz * g.nz);
    rows.forEach(([kb0], i) => {
      if (slabs[i]) values.set(slabs[i]!.values as Float32Array, kb0 * 4 * sz);
    });

    const surface = await this.run(0, { type: 'surface', pose, h, values }, [values.buffer]);
    const rough = surface.positions as Float32Array;
    const count = rough.length / 3;

    const chunks = Array.from({ length: n }, (_, i) => [Math.round((count * i) / n), Math.round((count * (i + 1)) / n)]);
    const shaded = await Promise.all(
      chunks.map(([a, b], i) => {
        const positions = rough.slice(3 * a, 3 * b);
        return this.run(i, { type: 'shade', pose, positions }, [positions.buffer]);
      }),
    );
    const out: VertexData = {
      positions: new Float32Array(count * 3),
      normals: new Float32Array(count * 3),
      colors: new Float32Array(count * 3),
      shading: new Float32Array(count * 3),
      creases: new Float32Array(count * 4),
      weights: new Float32Array(count * 16),
    };
    chunks.forEach(([a], i) => {
      for (const key of Object.keys(out) as (keyof VertexData)[]) {
        const per = key === 'weights' ? 16 : key === 'creases' ? 4 : 3;
        out[key].set(shaded[i][key] as Float32Array, a * per);
      }
    });
    return { ...out, indices: surface.indices as Uint32Array };
  }
}
