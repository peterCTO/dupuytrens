// Anatomical layout of the model hand and its kinematics.
//
// Units are centimetres. The model is a right hand in its rest frame:
//   +y  points from the wrist towards the fingertips
//   +z  points out of the palm (palmar side), -z is the back of the hand
//   +x  points towards the thumb (radial side), -x towards the little finger
// Flexing a finger rotates it from +y towards +z.

export type Vec3 = [number, number, number];

export type FingerId = 'index' | 'middle' | 'ring' | 'little';
export const FINGER_IDS: FingerId[] = ['index', 'middle', 'ring', 'little'];

export interface FingerPose {
  /** Metacarpophalangeal flexion in degrees. */
  mcp: number;
  /** Proximal interphalangeal flexion in degrees. */
  pip: number;
  /** Distal interphalangeal flexion in degrees (negative is hyperextension). */
  dip: number;
  /** Whether this ray has a Dupuytren's cord. */
  affected: boolean;
}

export type HandPose = Record<FingerId, FingerPose>;

interface FingerSpec {
  /** Centre of the metacarpal head. */
  mcp: Vec3;
  /** Splay in the palm plane, radians; positive leans towards the thumb. */
  splay: number;
  /** Proximal, middle and distal phalanx lengths. */
  lengths: [number, number, number];
  /** Soft-tissue radius at MCP, PIP, DIP and fingertip. */
  radii: [number, number, number, number];
}

export const FINGER_SPECS: Record<FingerId, FingerSpec> = {
  index: { mcp: [2.6, 9.35, 0], splay: 0.07, lengths: [4.0, 2.35, 1.85], radii: [1.04, 0.93, 0.84, 0.75] },
  middle: { mcp: [0.75, 9.75, 0], splay: 0.01, lengths: [4.45, 2.8, 1.95], radii: [1.06, 0.95, 0.86, 0.77] },
  ring: { mcp: [-1.1, 9.4, 0], splay: -0.05, lengths: [4.15, 2.65, 1.9], radii: [1.01, 0.9, 0.81, 0.73] },
  little: { mcp: [-2.8, 8.55, 0], splay: -0.14, lengths: [3.3, 2.0, 1.75], radii: [0.9, 0.8, 0.72, 0.65] },
};

export const FINGER_LABELS: Record<FingerId, string> = {
  index: 'Index',
  middle: 'Middle',
  ring: 'Ring',
  little: 'Little',
};

/** A tapered segment of one digit, with a frame for surface details. */
export interface Segment {
  a: Vec3;
  b: Vec3;
  ra: number;
  rb: number;
  /** Unit vector along the segment. */
  axis: Vec3;
  /** Unit vector pointing out of the palmar (flexor) surface. */
  palmar: Vec3;
  /** Unit vector across the digit. */
  lateral: Vec3;
}

export interface Digit {
  id: FingerId | 'thumb';
  segments: Segment[];
  /** Joint centres from proximal to distal, including the fingertip. */
  joints: Vec3[];
  /** Direction of the digit when fully extended, i.e. the metacarpal axis. */
  restAxis: Vec3;
  affected: boolean;
}

export interface Cord {
  points: Vec3[];
  radius: number;
  nodule: Vec3;
  noduleAxis: Vec3;
}

export interface Skeleton {
  digits: Digit[];
  cords: Cord[];
}

const deg = Math.PI / 180;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

function fingerDigit(id: FingerId, pose: FingerPose): Digit {
  const spec = FINGER_SPECS[id];
  const d0: Vec3 = [Math.sin(spec.splay), Math.cos(spec.splay), 0];
  const n: Vec3 = [0, 0, 1];
  const lateral = norm(cross(d0, n));
  const angles = [pose.mcp, pose.pip, pose.dip].map((a) => a * deg);

  const joints: Vec3[] = [spec.mcp];
  const segments: Segment[] = [];
  let bend = 0;
  for (let i = 0; i < 3; i++) {
    bend += angles[i];
    const axis = add(scale(d0, Math.cos(bend)), scale(n, Math.sin(bend)));
    const palmar = add(scale(d0, -Math.sin(bend)), scale(n, Math.cos(bend)));
    const a = joints[i];
    const b = add(a, scale(axis, spec.lengths[i]));
    joints.push(b);
    segments.push({ a, b, ra: spec.radii[i], rb: spec.radii[i + 1], axis, palmar, lateral });
  }
  return { id, segments, joints, restAxis: d0, affected: pose.affected };
}

function thumbDigit(): Digit {
  // The thumb is posed at rest: slightly flexed and rotated so its pad faces the fingers.
  const joints: Vec3[] = [
    [2.0, 2.1, 0.6],
    [4.05, 5.35, 1.95],
    [4.85, 7.95, 3.0],
    [5.15, 9.95, 3.55],
  ];
  const radii = [1.35, 1.12, 1.0, 0.85];
  const segments: Segment[] = [];
  for (let i = 0; i < 3; i++) {
    const axis = norm(sub(joints[i + 1], joints[i]));
    const toward: Vec3 = [-0.75, 0.1, 0.65];
    const palmar = norm(sub(toward, scale(axis, dot(toward, axis))));
    const lateral = norm(cross(axis, palmar));
    segments.push({ a: joints[i], b: joints[i + 1], ra: radii[i], rb: radii[i + 1], axis, palmar, lateral });
  }
  return { id: 'thumb', segments, joints, restAxis: segments[0].axis, affected: false };
}

/** A point on the palmar skin of a segment, a fraction t along it. */
function palmarPoint(s: Segment, t: number, inset: number): Vec3 {
  const r = s.ra + (s.rb - s.ra) * t;
  return add(lerp(s.a, s.b, t), scale(s.palmar, r - inset));
}

function cordFor(digit: Digit, pose: FingerPose): Cord {
  const mcp = digit.joints[0];
  const severity = Math.min(1, (pose.mcp + pose.pip) / 120);
  const radius = 0.3 + 0.12 * severity;
  // The pretendinous cord arises in the palm and inserts on the proximal
  // phalanx; a PIP contracture adds a central cord onto the middle phalanx.
  // Under tension it bowstrings straight across the flexed joints.
  const origin: Vec3 = [mcp[0] - 0.1, mcp[1] - 3.4, 0.9];
  const points: Vec3[] = [origin];
  points.push(palmarPoint(digit.segments[0], 0.4, 0.3));
  if (pose.pip > 5) points.push(palmarPoint(digit.segments[1], 0.2, 0.3));
  const nodule: Vec3 = [mcp[0] - 0.05, mcp[1] - 1.9, 1.25];
  return { points, radius, nodule, noduleAxis: norm(sub(points[1], origin)) };
}

export function buildSkeleton(pose: HandPose): Skeleton {
  const digits: Digit[] = [thumbDigit()];
  const cords: Cord[] = [];
  for (const id of FINGER_IDS) {
    const digit = fingerDigit(id, pose[id]);
    digits.push(digit);
    if (pose[id].affected) cords.push(cordFor(digit, pose[id]));
  }
  return { digits, cords };
}

/** Total passive extension deficit, used for Tubiana staging. */
export function totalDeficit(p: FingerPose): number {
  return Math.max(0, p.mcp) + Math.max(0, p.pip) + Math.max(0, p.dip);
}

export function tubianaStage(p: FingerPose): { stage: string; note: string } {
  const t = totalDeficit(p);
  if (!p.affected || t === 0) return { stage: 'N', note: 'No contracture' };
  if (t <= 45) return { stage: 'I', note: '0–45° total deficit' };
  if (t <= 90) return { stage: 'II', note: '45–90° total deficit' };
  if (t <= 135) return { stage: 'III', note: '90–135° total deficit' };
  return { stage: 'IV', note: 'over 135° total deficit' };
}

export const RELAXED: FingerPose = { mcp: 6, pip: 10, dip: 5, affected: false };

export function defaultPose(): HandPose {
  return {
    index: { ...RELAXED, mcp: 4, pip: 7, dip: 4 },
    middle: { ...RELAXED },
    ring: { mcp: 35, pip: 45, dip: 5, affected: true },
    little: { ...RELAXED, mcp: 9, pip: 14, dip: 7 },
  };
}
