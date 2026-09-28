// Mesh-building jobs, run off the main thread. Several of these workers share
// the work of one mesh (see builder.ts).

import { buildSkeleton, HandPose } from './anatomy';
import { buildField } from './sdf';
import { extractSurface, gridFor, sampleSlab, shadeVertices } from './mesher';

export type Job =
  | { type: 'sample'; id: number; pose: HandPose; h: number; kb0: number; kb1: number }
  | { type: 'surface'; id: number; pose: HandPose; h: number; values: Float32Array }
  | { type: 'shade'; id: number; pose: HandPose; positions: Float32Array };

const post = (msg: unknown, transfer: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  const sk = buildSkeleton(job.pose);
  const fd = buildField(sk);
  if (job.type === 'sample') {
    const values = sampleSlab(fd, gridFor(fd, job.h), job.kb0, job.kb1);
    post({ id: job.id, values }, [values.buffer]);
  } else if (job.type === 'surface') {
    const s = extractSurface(gridFor(fd, job.h), job.values);
    post({ id: job.id, ...s }, [s.positions.buffer, s.indices.buffer]);
  } else {
    const v = shadeVertices(sk, fd, job.positions);
    post({ id: job.id, ...v }, [v.positions.buffer, v.normals.buffer, v.colors.buffer, v.shading.buffer, v.weights.buffer]);
  }
};
