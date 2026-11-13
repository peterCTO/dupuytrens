// Theatre mode: a fasciectomy closed with Z-plasties, done by hand.
//
// Every affected ray gets a Z in the palm over its palm cord, and every
// finger with a middle-joint contracture another over its proximal phalanx.
// The user marks and cuts each Z, peels back each flap, divides the cords
// with the scalpel (the joints let go as they are cut), lays the flaps back
// in their transposed places, sews each stitch, then bandages the hand and
// lays a plaster slab along its back.

import * as THREE from 'three';
import { HandView, PointerInfo, SiteMarks, ToolName } from './scene';
import { CUT_Y, Field } from './hand/sdf';
import { Flap, makeFlap, morphFlap, setFlapAngle } from './flaps';
import { makeBundles, makeStitch, makeStitchMark } from './instruments';
import {
  FINGER_IDS,
  FINGER_LABELS,
  FingerId,
  HandPose,
  Operation,
  SiteSpec,
  Vec3,
  buildSkeleton,
  cordKey,
  hasDigitalCord,
} from './hand/anatomy';
import {
  P2,
  SiteGeom,
  cordUnderSite,
  fieldFor,
  pathLength,
  pointAlong,
  project,
  releasedPose,
  siteGeom,
  sitesFor,
  stitchSlots,
  toFrame,
  zShape,
} from './hand/surgery';

type Step = 'mark' | 'incise' | 'raise' | 'divide' | 'transpose' | 'suture' | 'bandage' | 'cast' | 'done';

const STEPS: { id: Step; title: string }[] = [
  { id: 'mark', title: 'Mark each Z-plasty' },
  { id: 'incise', title: 'Incise' },
  { id: 'raise', title: 'Raise the flaps' },
  { id: 'divide', title: 'Divide the cords' },
  { id: 'transpose', title: 'Transpose the flaps' },
  { id: 'suture', title: 'Suture' },
  { id: 'bandage', title: 'Bandage' },
  { id: 'cast', title: 'Plaster slab' },
];

const RAISED = (160 * Math.PI) / 180;
const WRIST = CUT_Y + 0.4;
const TOP = 13.8;

interface Site {
  spec: SiteSpec;
  marked: number;
  cut: number;
  flaps: Flap[];
  /** Flaps swung into their transposed places. */
  transposed: boolean[];
  closed: boolean;
  stitched: boolean[];
  /** Holds the flaps and nerves; on a finger it follows the finger as it straightens. */
  group: THREE.Group;
  /** The site's frame when the group was filled, to follow the finger from. */
  bindFrame: THREE.Matrix4 | null;
  stitches: THREE.Group;
}

const clone = (p: HandPose): HandPose => JSON.parse(JSON.stringify(p));
const V = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

export class Theatre {
  onChange: () => void = () => {};

  private active = false;
  private fingers: FingerId[] = [];
  private step: Step = 'mark';
  private sites: Site[] = [];
  private before: HandPose | null = null;
  private busy = false;
  private anim = 0;
  private timer = 0;
  /** Current site for steps done one site at a time. */
  private focusIndex = -1;
  // Pointer gesture state.
  private stroke: { site: number; last: P2 | null } | null = null;
  private dragFlap: { site: number; which: number; h: THREE.Vector2; t: THREE.Vector2 } | null = null;
  private wrap = { bandage: WRIST, cast: WRIST, last: null as THREE.Vector3 | null };

  constructor(
    private view: HandView,
    private getPose: () => HandPose,
    private setPose: (p: HandPose, structural: boolean) => void,
  ) {
    view.onPointer = (info) => this.pointer(info);
  }

  /** Fingers there is something to operate on. */
  candidates(): FingerId[] {
    const pose = this.before ?? this.getPose();
    return FINGER_IDS.filter((id) => pose[id].cord.present || pose[id].affected);
  }

  enter() {
    this.active = true;
    this.before = clone(this.getPose());
    this.start(this.candidates());
  }

  /** Leave theatre, putting the hand back as it was before the operation. */
  leave() {
    if (!this.active) return;
    this.active = false;
    this.reset();
    if (this.before) this.setPose(this.before, true);
    this.before = null;
    this.view.setOperation(null);
    this.view.goTo('palmar');
  }

  private reset() {
    cancelAnimationFrame(this.anim);
    window.clearTimeout(this.timer);
    this.busy = false;
    this.stroke = null;
    this.dragFlap = null;
    for (const s of this.sites) this.view.surgical.remove(s.group, s.stitches);
    this.sites = [];
    this.view.pickables = [];
    this.view.setTool(null);
    this.view.setSiteMarks([]);
    this.view.clearLayers();
    this.wrap = { bandage: WRIST, cast: WRIST, last: null };
  }

  /** Start (or restart) the operation on a set of fingers. */
  start(fingers: FingerId[]) {
    this.reset();
    if (this.before) this.setPose(this.before, true);
    this.fingers = fingers;
    const pose = this.getPose();
    this.sites = sitesFor(pose, fingers).map((spec) => {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      const stitches = new THREE.Group();
      this.view.surgical.add(group, stitches);
      return { spec, marked: 0, cut: 0, flaps: [], transposed: [false, false], closed: false, stitched: [], group, bindFrame: null, stitches };
    });
    this.view.setOperation(this.op());
    this.go('mark');
  }

  // --- State ------------------------------------------------------------------

  private op(): Operation {
    const excised: string[] = [];
    for (const f of FINGER_IDS) for (const k of ['palm', 'digital'] as const) if (this.cut.has(cordKey(f, k))) excised.push(cordKey(f, k));
    return { sites: this.sites.map((s) => ({ ...s.spec })), excised };
  }

  private cut = new Set<string>();

  private geom(i: number): SiteGeom {
    const pose = this.getPose();
    return siteGeom(this.sites[i].spec, pose, buildSkeleton(pose, this.op()));
  }

  private showMarks() {
    const marks: SiteMarks[] = this.sites.map((s, i) => ({
      geom: this.geom(i),
      marked: s.marked,
      cut: s.transposed.some(Boolean) ? 0 : s.cut,
      scar: s.closed,
      guide: this.step === 'mark',
    }));
    this.view.setSiteMarks(marks);
  }

  /** Keep finger sites' flaps and nerves on the finger as it moves. */
  private follow() {
    this.sites.forEach((s, i) => {
      if (!s.bindFrame) return;
      const now = frameMatrix(this.geom(i));
      s.group.matrix.copy(now.multiply(s.bindFrame.clone().invert()));
      s.group.matrixWorldNeedsUpdate = true;
    });
  }

  private applyPose(p: HandPose, structural: boolean) {
    this.setPose(p, structural);
    this.follow();
    this.showMarks();
  }

  private toolFor(step: Step): ToolName | null {
    return ({ mark: 'marker', incise: 'scalpel', raise: 'hand', divide: 'scalpel', transpose: 'hand', suture: 'needle', bandage: 'wrap', cast: 'wrap' } as Record<Step, ToolName>)[step] ?? null;
  }

  private go(step: Step) {
    this.step = step;
    this.view.setTool(this.busy ? null : this.toolFor(step));
    this.view.pickables = step === 'raise' || step === 'transpose' ? this.sites.flatMap((s) => s.flaps.map((f) => f.mesh)) : [];
    this.focusIndex = -1;
    this.showMarks();
    this.refocus();
    this.render();
  }

  private setBusy(b: boolean) {
    this.busy = b;
    this.view.setTool(b ? null : this.toolFor(this.step));
    this.render();
  }

  /** Whether a site still has work in the current step. */
  private pending(i: number): boolean {
    const s = this.sites[i];
    const total = pathLength(zShape(this.geom(i).limb).incision);
    switch (this.step) {
      case 'mark':
        return s.marked < total;
      case 'incise':
        return s.cut < total;
      case 'raise':
        return s.flaps.some((f) => f.angle < RAISED - 0.01);
      case 'divide':
        return this.cordsUnder(i).length > 0;
      case 'transpose':
        return !s.closed;
      case 'suture':
        return s.stitched.some((x) => !x);
      default:
        return false;
    }
  }

  /** Point the camera at the first site with work left, when that changes. */
  private refocus() {
    if (this.step === 'bandage') {
      this.view.overview('palmar');
      return;
    }
    if (this.step === 'cast' || this.step === 'done') {
      this.view.overview('dorsal');
      return;
    }
    const i = this.sites.findIndex((_, k) => this.pending(k));
    if (i < 0 || i === this.focusIndex) return;
    this.focusIndex = i;
    const g = this.geom(i);
    const c = this.view.surfacePoint(g.frame, 0, 0);
    const n = V(g.frame.n);
    // Look along the site's normal, tipped a little towards the wrist.
    const dir = n.clone().multiplyScalar(1).add(new THREE.Vector3(-0.1, -0.35, 0)).normalize();
    this.view.focus(V(c.p), dir, this.sites[i].spec.where === 'palm' ? 19 : 16);
  }

  /** Cords of the site's finger still running under its window. */
  private cordsUnder(i: number) {
    const g = this.geom(i);
    const f = this.sites[i].spec.finger;
    return buildSkeleton(this.getPose(), this.op()).cords.filter((c) => c.finger === f && cordUnderSite(g, c));
  }

  // --- Doing the work -----------------------------------------------------------

  private animate(duration: number, tick: (t: number) => void, done: () => void) {
    cancelAnimationFrame(this.anim);
    const t0 = performance.now();
    const loop = () => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      tick(t);
      if (t < 1) this.anim = requestAnimationFrame(loop);
      else done();
    };
    this.anim = requestAnimationFrame(loop);
  }

  /** Run once the next mesh is on screen. */
  private whenMeshed(fn: () => void) {
    const prev = this.view.onMeshReady;
    this.view.onMeshReady = () => {
      this.view.onMeshReady = prev;
      fn();
    };
  }

  /** After each change, move on when the step is finished, or to the next site. */
  private progress() {
    if (this.sites.every((_, i) => !this.pending(i))) this.finishStep();
    else {
      this.refocus();
      this.render();
    }
  }

  private finishStep() {
    switch (this.step) {
      case 'mark':
        return this.go('incise');
      case 'incise':
        return this.openSites();
      case 'raise':
        return this.go('divide');
      case 'divide': {
        // Remake the raised flaps where the straightened fingers now hold them.
        const whole = this.wholeField();
        this.sites.forEach((s, i) => {
          this.fillSite(i, whole);
          s.flaps.forEach((f) => setFlapAngle(f, RAISED));
        });
        return this.go('transpose');
      }
      case 'transpose':
        return this.whenAllMeshed(() => this.startSuture());
      case 'suture':
        return this.startDressing();
      case 'bandage':
        return this.go('cast');
      case 'cast':
        return this.go('done');
    }
  }

  private whenAllMeshed(fn: () => void) {
    if (!this.busy) fn();
    else this.timer = window.setTimeout(() => this.whenAllMeshed(fn), 100);
  }

  /** Trace a site's Z with the marker or the scalpel, as far as s (cm). */
  private trace(i: number, s: number) {
    const site = this.sites[i];
    if (this.step === 'mark') site.marked = Math.max(site.marked, s);
    else site.cut = Math.max(site.cut, s);
    this.showMarks();
  }

  /** Mark or cut every site that is left, one after another. */
  private traceForMe() {
    const left = this.sites.map((_, i) => i).filter((i) => this.pending(i));
    this.setBusy(true);
    const next = () => {
      const i = left.shift();
      if (i === undefined) {
        this.view.showTool(null, [0, 1, 0], [0, 0, 1]);
        this.setBusy(false);
        this.progress();
        return;
      }
      const g = this.geom(i);
      const path = zShape(g.limb).incision;
      const total = pathLength(path);
      const from = this.step === 'mark' ? this.sites[i].marked : this.sites[i].cut;
      this.focusIndex = -1;
      this.refocusTo(i);
      this.view.setTool(this.toolFor(this.step));
      this.animate(1400 * (1 - from / total) + 150, (t) => {
        const s = from + (total - from) * t;
        this.trace(i, s);
        this.toolAt(i, s);
      }, next);
    };
    next();
  }

  private refocusTo(i: number) {
    this.focusIndex = i;
    const g = this.geom(i);
    const c = this.view.surfacePoint(g.frame, 0, 0);
    const dir = V(g.frame.n).add(new THREE.Vector3(-0.1, -0.35, 0)).normalize();
    this.view.focus(V(c.p), dir, this.sites[i].spec.where === 'palm' ? 19 : 16);
  }

  /** Put the tool on the skin at a distance along a site's Z. */
  private toolAt(i: number, s: number) {
    const g = this.geom(i);
    const path = zShape(g.limb).incision;
    const p = pointAlong(path, s);
    const q = pointAlong(path, s + 0.05);
    const a = this.view.surfacePoint(g.frame, p[0], p[1]);
    const b = this.view.surfacePoint(g.frame, q[0], q[1]);
    const dir: Vec3 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
    this.view.showTool(V(a.p), Math.hypot(...dir) > 1e-6 ? dir : g.frame.u, g.frame.n);
  }

  /** With every Z cut, hollow out under the flaps and put the flaps in place. */
  private openSites() {
    for (const s of this.sites) s.spec.open = true;
    this.step = 'raise';
    this.setBusy(true);
    this.whenMeshed(() => {
      // The flaps are cut from the skin as it was before it was hollowed out.
      const whole = this.wholeField();
      this.sites.forEach((_, i) => this.fillSite(i, whole));
      this.setBusy(false);
      this.go('raise');
    });
    this.view.setOperation(this.op());
    this.render();
  }

  /** The skin as it was before it was hollowed out, for the pose as it is now. */
  private wholeField(): Field {
    return fieldFor(this.getPose(), { sites: this.sites.map((s) => ({ ...s.spec, open: false })), excised: this.op().excised });
  }

  private fillSite(i: number, whole: Field) {
    const s = this.sites[i];
    const g = this.geom(i);
    s.group.clear();
    s.flaps = [0, 1].map((k) => makeFlap(whole, g, k as 0 | 1, this.view.skinMaterial));
    for (const f of s.flaps) s.group.add(f.pivot);
    s.group.add(makeBundles([1, -1].map((side) => bundlePaths(this.view, whole, g, side))));
    s.bindFrame = frameMatrix(g);
    s.group.matrix.identity();
  }

  private raiseForMe() {
    this.setBusy(true);
    const todo = this.sites.flatMap((s) => s.flaps.filter((f) => f.angle < RAISED));
    const from = todo.map((f) => f.angle);
    this.animate(900, (t) => todo.forEach((f, k) => setFlapAngle(f, from[k] + (RAISED - from[k]) * ease(t))), () => {
      this.setBusy(false);
      this.progress();
    });
  }

  /** Cut the cords under a site; the finger lets go as far as the remaining cords allow. */
  private divide(i: number) {
    const cords = this.cordsUnder(i);
    if (!cords.length) return;
    const f = this.sites[i].spec.finger;
    for (const c of cords) this.cut.add(cordKey(f, c.kind));
    const b = this.before![f];
    const target = releasedPose(b, this.cut.has(cordKey(f, 'palm')), this.cut.has(cordKey(f, 'digital')), b.cord.present, hasDigitalCord(b));
    const from = this.getPose()[f];
    this.view.setOperation(this.op());
    this.setBusy(true);
    this.animate(1500, (t) => {
      const e = ease(t);
      const pose = clone(this.getPose());
      pose[f] = {
        ...pose[f],
        mcp: Math.round(from.mcp + (target.mcp - from.mcp) * e),
        pip: Math.round(from.pip + (target.pip - from.pip) * e),
        dip: Math.round(from.dip + (target.dip - from.dip) * e),
      };
      this.applyPose(pose, false);
    }, () => {
      this.setBusy(false);
      this.progress();
    });
  }

  private divideForMe() {
    const i = this.sites.findIndex((_, k) => this.pending(k));
    if (i < 0) return this.progress();
    this.refocusTo(i);
    this.divide(i);
    // Carry on with the rest once this one settles.
    const wait = () => (this.busy ? (this.timer = window.setTimeout(wait, 100)) : this.step === 'divide' && this.divideForMe());
    this.timer = window.setTimeout(wait, 100);
  }

  /** Lay a raised flap down and swing it into its transposed place. */
  private transpose(i: number, which: number) {
    const s = this.sites[i];
    const flap = s.flaps[which];
    if (s.transposed[which]) return;
    s.transposed[which] = true;
    this.showMarks();
    const whole = this.wholeField();
    const g = this.geom(i);
    const start = flap.angle;
    this.animate(500, (t) => setFlapAngle(flap, start * (1 - ease(t))), () => {
      this.animate(700, (t) => morphFlap(flap, whole, g, which as 0 | 1, t), () => {
        if (s.transposed.every(Boolean)) this.closeSite(i);
        else this.render();
      });
    });
  }

  private closeSite(i: number) {
    const s = this.sites[i];
    s.spec.open = false;
    s.closed = true;
    this.setBusy(true);
    this.whenMeshed(() => {
      s.group.clear();
      s.flaps = [];
      this.view.pickables = this.sites.flatMap((x) => x.flaps.map((f) => f.mesh));
      this.showMarks();
      this.setBusy(false);
      this.progress();
    });
    this.view.setOperation(this.op());
  }

  private transposeForMe() {
    const i = this.sites.findIndex((s) => !s.closed && !s.transposed.every(Boolean));
    if (i < 0) return;
    this.refocusTo(i);
    const s = this.sites[i];
    s.flaps.forEach((_, k) => this.transpose(i, k));
    const wait = () => (this.busy || this.sites[i].spec.open ? (this.timer = window.setTimeout(wait, 150)) : this.step === 'transpose' && this.transposeForMe());
    this.timer = window.setTimeout(wait, 400);
  }

  // --- Sutures ------------------------------------------------------------------

  private slots(i: number) {
    return stitchSlots(this.geom(i).limb);
  }

  private startSuture() {
    this.sites.forEach((s, i) => {
      s.stitched = this.slots(i).map(() => false);
      this.drawStitches(i);
    });
    this.go('suture');
  }

  private drawStitches(i: number) {
    const s = this.sites[i];
    const g = this.geom(i);
    s.stitches.clear();
    this.slots(i).forEach((slot, k) => {
      const a = this.view.surfacePoint(g.frame, slot.at[0], slot.at[1]);
      const n = normalFrom(this.view, g, slot.at);
      if (s.stitched[k]) {
        const along: Vec3 = [0, 1, 2].map((c) => g.frame.u[c] * slot.dir[0] + g.frame.v[c] * slot.dir[1]) as Vec3;
        s.stitches.add(makeStitch(a.p, along, n));
      } else s.stitches.add(makeStitchMark(a.p, n));
    });
  }

  private stitch(i: number, k: number) {
    this.sites[i].stitched[k] = true;
    this.drawStitches(i);
    this.progress();
  }

  private sutureForMe() {
    const left: [number, number][] = [];
    this.sites.forEach((s, i) => s.stitched.forEach((x, k) => !x && left.push([i, k])));
    this.setBusy(true);
    const next = () => {
      const item = left.shift();
      if (!item) {
        this.setBusy(false);
        this.progress();
        return;
      }
      this.sites[item[0]].stitched[item[1]] = true;
      this.drawStitches(item[0]);
      this.timer = window.setTimeout(next, 90);
    };
    next();
  }

  // --- Dressing -----------------------------------------------------------------

  private startDressing() {
    this.step = 'bandage';
    this.setBusy(true);
    this.view.buildLayer('bandage').then(() => this.view.buildLayer('cast')).then(() => {
      this.view.setReveal('bandage', WRIST);
      this.view.setReveal('cast', -99);
      this.setBusy(false);
      this.go('bandage');
    });
    this.view.overview('palmar');
  }

  private dressForMe(layer: 'bandage' | 'cast') {
    const from = this.wrap[layer];
    this.setBusy(true);
    this.animate(1600, (t) => {
      this.wrap[layer] = from + (TOP - from) * ease(t);
      this.view.setReveal(layer, this.wrap[layer]);
      this.render();
    }, () => {
      this.setBusy(false);
      this.finishStep();
    });
  }

  // --- Pointer --------------------------------------------------------------------

  private pointer(info: PointerInfo) {
    if (this.busy) return;
    switch (this.step) {
      case 'mark':
      case 'incise':
        return this.pointerTrace(info);
      case 'raise':
      case 'transpose':
        return this.pointerFlap(info);
      case 'divide':
        return this.pointerDivide(info);
      case 'suture':
        return this.pointerSuture(info);
      case 'bandage':
      case 'cast':
        return this.pointerWrap(info);
    }
  }

  /** The site under a point on the skin, and the point in its (u, v). */
  private siteAt(hit: THREE.Vector3): { i: number; uv: P2 } | null {
    let best: { i: number; uv: P2; d: number } | null = null;
    this.sites.forEach((_, i) => {
      const g = this.geom(i);
      const [u, v, w] = toFrame(g.frame, [hit.x, hit.y, hit.z]);
      if (w < -g.back) return;
      const d = Math.max(Math.abs(u), Math.abs(v)) / g.limb;
      if (d < 1.4 && (!best || d < best.d)) best = { i, uv: [u, v], d };
    });
    return best;
  }

  private pointerTrace(info: PointerInfo) {
    if (!info.hit) {
      this.view.showTool(null, [0, 1, 0], [0, 0, 1]);
      return;
    }
    const at = this.siteAt(info.hit);
    const hitN = normalAtHit(this.view, info.hit);
    if (info.kind === 'up') this.stroke = null;
    if (!at) {
      this.view.showTool(info.hit, [0, 1, 0], hitN);
      return;
    }
    const g = this.geom(at.i);
    const path = zShape(g.limb).incision;
    const total = pathLength(path);
    const done = this.step === 'mark' ? this.sites[at.i].marked : this.sites[at.i].cut;
    // Cutting follows the marks; both start where the last stroke ended.
    const allowed = this.step === 'mark' ? total : this.sites[at.i].marked;
    const pr = project(path, at.uv[0], at.uv[1]);
    if (info.kind === 'down') this.stroke = pr.dist < 0.3 && pr.s < done + 0.35 ? { site: at.i, last: at.uv } : null;
    if (this.stroke && this.stroke.site === at.i && info.kind === 'move' && pr.dist < 0.35 && pr.s > done && pr.s < done + 0.5 && pr.s <= allowed + 0.05) {
      this.trace(at.i, pr.s > total - 0.08 ? total : pr.s);
      this.render();
    }
    if (this.stroke) this.toolAt(at.i, this.step === 'mark' ? this.sites[at.i].marked : this.sites[at.i].cut);
    else {
      const t = pointAlong(path, pr.s + 0.05), p = pointAlong(path, pr.s);
      const dir: Vec3 = [0, 1, 2].map((c) => g.frame.u[c] * (t[0] - p[0]) + g.frame.v[c] * (t[1] - p[1])) as Vec3;
      this.view.showTool(info.hit, dir, hitN);
    }
    if (!this.pending(at.i)) {
      this.stroke = null;
      this.progress();
    }
  }

  private pointerFlap(info: PointerInfo) {
    if (info.kind === 'down') {
      this.dragFlap = null;
      if (!info.object) return;
      this.sites.forEach((s, i) =>
        s.flaps.forEach((f, k) => {
          if (f.mesh !== info.object) return;
          if (this.step === 'transpose' && s.transposed[k]) return;
          if (this.step === 'transpose' && this.cordsUnder(i).length) return;
          const m = s.group.matrix;
          const h = this.view.toScreen(mid(f.hinge, m));
          const t = this.view.toScreen(V(f.tip).applyMatrix4(m).toArray() as Vec3);
          this.dragFlap = { site: i, which: k, h, t };
        }),
      );
      return;
    }
    const d = this.dragFlap;
    if (!d) return;
    const flap = this.sites[d.site].flaps[d.which];
    const axis = d.t.clone().sub(d.h);
    const s = info.screen.clone().sub(d.h).dot(axis) / axis.lengthSq();
    const angle = Math.min(RAISED, Math.acos(Math.max(-1, Math.min(1, s))));
    if (info.kind === 'move') setFlapAngle(flap, angle);
    if (info.kind === 'up') {
      this.dragFlap = null;
      if (this.step === 'raise') {
        const to = flap.angle > 1.6 ? RAISED : 0;
        const from = flap.angle;
        this.animate(250, (t) => setFlapAngle(flap, from + (to - from) * t), () => this.progress());
      } else if (flap.angle < 1.2) this.transpose(d.site, d.which);
      else {
        const from = flap.angle;
        this.animate(250, (t) => setFlapAngle(flap, from + (RAISED - from) * t), () => this.render());
      }
    }
  }

  private pointerDivide(info: PointerInfo) {
    if (!info.hit) {
      this.view.showTool(null, [0, 1, 0], [0, 0, 1]);
      return;
    }
    const at = this.siteAt(info.hit);
    const hitN = normalAtHit(this.view, info.hit);
    const g = at ? this.geom(at.i) : null;
    this.view.showTool(info.hit, g ? g.frame.v : [1, 0, 0], hitN);
    if (!at || !g) return;
    if (info.kind === 'down') this.stroke = { site: at.i, last: at.uv };
    else if (info.kind === 'up') this.stroke = null;
    else if (this.stroke && this.stroke.site === at.i && this.stroke.last) {
      // A stroke across the cord (the site's midline) divides it.
      const [u0, v0] = this.stroke.last;
      const [u1, v1] = at.uv;
      if (Math.sign(v0) !== Math.sign(v1) && Math.abs(u1) < g.limb * 0.45 && Math.abs(v1 - v0) < 1.2) {
        this.stroke = null;
        this.divide(at.i);
        return;
      }
      this.stroke.last = at.uv;
    }
  }

  private pointerSuture(info: PointerInfo) {
    if (!info.hit) {
      this.view.showTool(null, [0, 1, 0], [0, 0, 1]);
      return;
    }
    const at = this.siteAt(info.hit);
    const hitN = normalAtHit(this.view, info.hit);
    this.view.showTool(info.hit, at ? this.geom(at.i).frame.v : [1, 0, 0], hitN);
    if (!at) return;
    const slots = this.slots(at.i);
    const near = (uv: P2) => {
      let best = -1;
      let bd = 0.3;
      slots.forEach((s, k) => {
        const d = Math.hypot(uv[0] - s.at[0], uv[1] - s.at[1]);
        if (!this.sites[at.i].stitched[k] && d < bd) {
          best = k;
          bd = d;
        }
      });
      return best;
    };
    if (info.kind === 'down') this.stroke = { site: at.i, last: at.uv };
    else if (this.stroke && this.stroke.site === at.i && this.stroke.last) {
      // A pass of the needle across the scar near a mark places that stitch.
      const scar = zShape(this.geom(at.i).limb).scar;
      const a = this.stroke.last;
      const crossed = crosses(scar, a, at.uv);
      if (crossed) {
        const k = near(crossed);
        if (k >= 0) {
          this.stroke = { site: at.i, last: at.uv };
          this.stitch(at.i, k);
          return;
        }
      }
      if (info.kind === 'up') {
        // A plain click on a mark works too.
        const k = Math.hypot(a[0] - at.uv[0], a[1] - at.uv[1]) < 0.1 ? near(at.uv) : -1;
        this.stroke = null;
        if (k >= 0) this.stitch(at.i, k);
        return;
      }
      this.stroke.last = at.uv;
    }
  }

  private pointerWrap(info: PointerInfo) {
    const layer = this.step === 'bandage' ? 'bandage' : 'cast';
    if (info.kind !== 'move' || !info.pressed || !info.hit) {
      this.wrap.last = info.kind === 'down' ? info.hit : null;
      return;
    }
    if (layer === 'bandage') {
      // Each pass over the hand winds on a little more bandage.
      if (this.wrap.last) this.wrap.bandage = Math.min(TOP, this.wrap.bandage + info.hit.distanceTo(this.wrap.last) * 0.35);
      this.wrap.last = info.hit.clone();
    } else if (info.hit.y < this.wrap.cast + 1.5) {
      // The plaster is smoothed on from the wrist towards the fingertips.
      this.wrap.cast = Math.max(this.wrap.cast, Math.min(TOP, info.hit.y + 0.4));
    }
    this.view.setReveal(layer, this.wrap[layer]);
    if (this.wrap[layer] >= TOP - 0.05) this.finishStep();
    else this.render();
  }

  // --- For screenshots ------------------------------------------------------------

  /** Run the operation forward to a step, doing each step for the user. */
  async skipTo(target: string) {
    const order = [...STEPS.map((s) => s.id), 'done'];
    if (!order.includes(target as Step)) return;
    const settle = () =>
      new Promise<void>((resolve) => {
        const check = () => (!this.busy ? resolve() : window.setTimeout(check, 50));
        window.setTimeout(check, 60);
      });
    await new Promise<void>((r) => this.whenMeshed(r));
    let guard = 0;
    while (this.step !== target && this.step !== 'done' && guard++ < 20) {
      const from = this.step;
      this.doForMe();
      // Wait for the step to finish, nudging it again if it stalls.
      for (let k = 0; k < 400 && this.step === from; k++) await settle();
    }
    document.body.dataset.theatre = this.step;
  }

  private doForMe() {
    switch (this.step) {
      case 'mark':
      case 'incise':
        return this.traceForMe();
      case 'raise':
        return this.raiseForMe();
      case 'divide':
        return this.divideForMe();
      case 'transpose':
        return this.transposeForMe();
      case 'suture':
        return this.sutureForMe();
      case 'bandage':
        return this.dressForMe('bandage');
      case 'cast':
        return this.dressForMe('cast');
    }
  }

  // --- Panel ------------------------------------------------------------------------

  caption(): string {
    if (!this.sites.length) return 'No finger has a contracture or cord to operate on. Set one up in the clinic first.';
    const names = this.fingers.map((f) => FINGER_LABELS[f].toLowerCase());
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    const rays = `the ${list} ${names.length > 1 ? 'fingers' : 'finger'}`;
    const what: Record<Step, string> = {
      mark: `Z-plasties marked out over the cords of ${rays}`,
      incise: `the Z-plasties marked in violet over the cords of ${rays}`,
      raise: `the triangular flaps being raised`,
      divide: `the flaps folded back, showing each cord with the digital nerves (yellow) and arteries (red) beside it`,
      transpose: `${rays} released once the cords are divided`,
      suture: `the flaps transposed, turning each Z across the line of the finger`,
      bandage: `the wounds closed with interrupted sutures`,
      cast: `the hand in a crepe bandage`,
      done: `a plaster slab along the back of the hand, holding the fingers straight`,
    };
    return `Right hand, fasciectomy with Z-plasty: ${what[this.step]}.`;
  }

  private render() {
    const pickHost = document.getElementById('op-finger')!;
    const steps = document.getElementById('op-steps')!;
    const instruction = document.getElementById('op-instruction')!;
    const actions = document.getElementById('op-actions')!;

    pickHost.innerHTML = '';
    pickHost.className = 'op-finger';
    const started = this.step !== 'mark' || this.sites.some((s) => s.marked > 0);
    for (const id of this.candidates()) {
      const b = document.createElement('button');
      b.textContent = FINGER_LABELS[id];
      b.className = this.fingers.includes(id) ? 'active' : '';
      b.disabled = this.busy || started;
      b.title = started ? 'Start again to change which fingers are operated on' : 'Include or leave out this finger';
      b.addEventListener('click', () => {
        const next = this.fingers.includes(id) ? this.fingers.filter((f) => f !== id) : [...this.fingers, id];
        if (next.length) this.start(next);
      });
      pickHost.append(b);
    }

    steps.innerHTML = '';
    const at = STEPS.findIndex((s) => s.id === this.step);
    STEPS.forEach((s, i) => {
      const li = document.createElement('li');
      li.textContent = s.title;
      li.className = this.step === 'done' || i < at ? 'done' : i === at ? 'current' : '';
      steps.append(li);
    });

    actions.innerHTML = '';
    const button = (label: string, fn: () => void, primary = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = primary ? 'primary' : '';
      b.disabled = this.busy;
      b.addEventListener('click', fn);
      actions.append(b);
    };
    document.querySelectorAll('#theatre .progress').forEach((e) => e.remove());
    const bar = (fraction: number) => {
      const el = document.createElement('div');
      el.className = 'progress';
      el.innerHTML = `<span style="width:${Math.round(100 * Math.min(1, fraction))}%"></span>`;
      instruction.after(el);
    };

    if (!this.sites.length) {
      instruction.textContent = 'Nothing to operate on yet. Go back to the clinic and give a finger a contracture or a palm cord.';
      this.onChange();
      return;
    }
    const left = this.sites.filter((_, i) => this.pending(i)).length;
    const count = `${left} of ${this.sites.length} Z-plast${this.sites.length > 1 ? 'ies' : 'y'} to go.`;
    const where = (): string => {
      const i = this.sites.findIndex((_, k) => this.pending(k));
      if (i < 0) return '';
      const s = this.sites[i].spec;
      return s.where === 'palm' ? ` Now: the palm below the ${FINGER_LABELS[s.finger].toLowerCase()} finger.` : ` Now: the ${FINGER_LABELS[s.finger].toLowerCase()} finger.`;
    };
    switch (this.step) {
      case 'mark':
        instruction.textContent = `Draw each Z with the marker, following the dotted guide from the end on the little-finger side: a line along the cord with a limb at 60° from each end. ${count}${where()}`;
        button('Mark for me', () => this.traceForMe());
        break;
      case 'incise':
        instruction.textContent = `Cut along each violet Z with the scalpel in one steady stroke. ${count}${where()}`;
        button('Cut for me', () => this.traceForMe());
        break;
      case 'raise':
        instruction.textContent = this.busy && !this.sites.some((s) => s.flaps.length)
          ? 'Freeing the skin and fat from the cord…'
          : `Take hold of each triangular flap by its point and peel it back over its base. ${this.sites.flatMap((s) => s.flaps).filter((f) => f.angle < RAISED - 0.01).length} flaps to go.`;
        button('Raise them for me', () => this.raiseForMe());
        break;
      case 'divide':
        instruction.textContent = `Draw the scalpel across each white cord to divide it, keeping clear of the nerves and arteries beside it. The finger lets go as its cords are cut. ${count}${where()}`;
        button('Divide for me', () => this.divideForMe());
        break;
      case 'transpose': {
        const summary = this.fingers
          .map((f) => `${FINGER_LABELS[f]}: knuckle ${this.before![f].mcp}° to ${this.getPose()[f].mcp}°, middle joint ${this.before![f].pip}° to ${this.getPose()[f].pip}°.`)
          .join(' ');
        instruction.textContent = `${summary} Now fold each flap back down; it swings across into its partner's place, lengthening the skin. ${count}`;
        button('Transpose for me', () => this.transposeForMe());
        break;
      }
      case 'suture': {
        const stitches = this.sites.flatMap((s) => s.stitched);
        const done = stitches.filter(Boolean).length;
        instruction.textContent = `Pass the needle across the scar at each violet dot to tie a stitch. ${stitches.length - done} stitches to go.`;
        bar(done / Math.max(1, stitches.length));
        button('Sew for me', () => this.sutureForMe());
        break;
      }
      case 'bandage':
        instruction.textContent = this.busy
          ? 'Cutting the bandage and wetting the plaster…'
          : 'Drag round and round over the hand to wind on the crepe bandage, from the wrist up over the palm and the operated fingers.';
        bar((this.wrap.bandage - WRIST) / (TOP - WRIST));
        button('Bandage for me', () => this.dressForMe('bandage'));
        break;
      case 'cast':
        instruction.textContent = 'Smooth the plaster slab on along the back of the hand, dragging from the wrist to the fingertips, to hold the fingers straight while they heal.';
        bar((this.wrap.cast - WRIST) / (TOP - WRIST));
        button('Plaster for me', () => this.dressForMe('cast'));
        break;
      case 'done': {
        const lines = this.fingers.map((f) => {
          const b = this.before![f];
          const now = this.getPose()[f];
          return `${FINGER_LABELS[f]}: ${b.mcp}° and ${b.pip}° to ${now.mcp}° and ${now.pip}°.`;
        });
        instruction.textContent = `Done. Knuckle and middle joint, before and after: ${lines.join(' ')} Next comes hand therapy: the bandage comes off, the wounds are cleaned and a thermoplastic splint is made.`;
        button('Operate again', () => this.start(this.fingers), true);
        break;
      }
    }
    this.onChange();
  }
}

// --- Helpers ----------------------------------------------------------------------

function ease(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** A site's frame as a matrix, for following a finger. */
function frameMatrix(g: SiteGeom): THREE.Matrix4 {
  const f = g.frame;
  return new THREE.Matrix4().makeBasis(V(f.u), V(f.v), V(f.n)).setPosition(V(f.o));
}

function mid(h: [Vec3, Vec3], m: THREE.Matrix4): Vec3 {
  return V(h[0]).add(V(h[1])).multiplyScalar(0.5).applyMatrix4(m).toArray() as Vec3;
}

/** The skin's normal at a point, from the field of the mesh on screen. */
function normalAtHit(view: HandView, hit: THREE.Vector3): Vec3 {
  return view.normalAt([hit.x, hit.y, hit.z]);
}

function normalFrom(view: HandView, g: SiteGeom, at: P2): Vec3 {
  const a = view.surfacePoint(g.frame, at[0], at[1]);
  return normalAtHit(view, V(a.p));
}

/** Nerve and artery on one side of a site, lying on the floor of the wound. */
function bundlePaths(view: HandView, whole: Field, g: SiteGeom, side: number): { nerve: Vec3[]; artery: Vec3[] } {
  const reach = g.limb * 0.75;
  const path = (off: number, sink: number) => {
    const pts: Vec3[] = [];
    for (let k = 0; k <= 8; k++) {
      const u = -reach + (2 * reach * k) / 8;
      const v = side * (off + Math.sin(u * 2.3 + side * 1.7) * 0.03) * Math.min(1, g.limb / 1.4);
      const s = view.surfacePoint(g.frame, u, v, whole);
      // Straight in under the skin to the floor of the wound.
      const base = s.hit ? s.p : [0, 1, 2].map((c) => g.frame.o[c] + g.frame.u[c] * u + g.frame.v[c] * v + g.frame.n[c] * 0.8);
      pts.push([0, 1, 2].map((c) => base[c] - g.frame.n[c] * (g.depth - sink)) as Vec3);
    }
    return pts;
  };
  return { nerve: path(0.42, 0.07), artery: path(0.54, 0.05) };
}

/** Where the segment a-b first crosses a polyline, if it does. */
function crosses(poly: P2[], a: P2, b: P2): P2 | null {
  for (let i = 0; i + 1 < poly.length; i++) {
    const [p, q] = [poly[i], poly[i + 1]];
    const d = (b[0] - a[0]) * (q[1] - p[1]) - (b[1] - a[1]) * (q[0] - p[0]);
    if (Math.abs(d) < 1e-9) continue;
    const t = ((p[0] - a[0]) * (q[1] - p[1]) - (p[1] - a[1]) * (q[0] - p[0])) / d;
    const u = ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / d;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  return null;
}
