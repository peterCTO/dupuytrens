// Builds hand meshes off the main thread.

import { buildSkeleton, HandPose } from './anatomy';
import { buildField } from './sdf';
import { meshField } from './mesher';

export interface MeshRequest {
  id: number;
  pose: HandPose;
  /** Grid spacing in centimetres; smaller is finer. */
  h: number;
}

self.onmessage = (e: MessageEvent<MeshRequest>) => {
  const { id, pose, h } = e.data;
  const sk = buildSkeleton(pose);
  const mesh = meshField(sk, buildField(sk), h);
  (self as unknown as Worker).postMessage({ id, pose, h, mesh }, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.colors.buffer,
    mesh.weights.buffer,
    mesh.indices.buffer,
  ]);
};
