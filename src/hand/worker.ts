// Mesh-building jobs, run off the main thread. Several of these workers share
// the work of one mesh (see builder.ts).

import { buildSkeleton, HandPose, Operation } from './anatomy';
import { buildField, Layer } from './sdf';
import { fieldFor } from './surgery';
import { extractSurface, gridFor, sampleSlab, shadeVertices } from './mesher';

export type Job =
  | { type: 'sample'; id: number; pose: HandPose; op: Operation | null; layer: Layer; h: number; kb0: number; kb1: number }
  | { type: 'surface'; id: number; pose: HandPose; op: Operation | null; layer: Layer; h: number; values: Float32Array }
  | { type: 'shade'; id: number; pose: HandPose; op: Operation | null; layer: Layer; positions: Float32Array };

const post = (msg: unknown, transfer: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  const sk = buildSkeleton(job.pose, job.op);
  const fd = fieldFor(job.pose, job.op, job.layer);
  if (job.type === 'sample') {
    const values = sampleSlab(fd, gridFor(fd, job.h), job.kb0, job.kb1);
    post({ id: job.id, values }, [values.buffer]);
  } else if (job.type === 'surface') {
    const s = extractSurface(gridFor(fd, job.h), job.values);
    post({ id: job.id, ...s }, [s.positions.buffer, s.indices.buffer]);
  } else {
    const v = shadeVertices(sk, fd, job.positions);
    post({ id: job.id, ...v }, [v.positions.buffer, v.normals.buffer, v.colors.buffer, v.shading.buffer, v.creases.buffer, v.weights.buffer]);
  }
};
