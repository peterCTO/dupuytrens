// Theatre mode: a Z-plasty fasciectomy on one finger, step by step.

import * as THREE from 'three';
import { HandView } from './scene';
import { FINGER_IDS, FINGER_LABELS, FingerId, HandPose, Operation, buildSkeleton } from './hand/anatomy';
import { P2, ZPlan, pathLength, planZ, pointAlong, project, releasedAngles } from './hand/surgery';

type Step = 'mark' | 'incise' | 'open' | 'excise' | 'close' | 'suture' | 'done';

const STEPS: { id: Step; title: string }[] = [
  { id: 'mark', title: 'Mark the Z-plasty' },
  { id: 'incise', title: 'Incise' },
  { id: 'open', title: 'Raise the flaps' },
  { id: 'excise', title: 'Excise the cord' },
  { id: 'close', title: 'Transpose the flaps' },
  { id: 'suture', title: 'Suture' },
];

const clone = (p: HandPose): HandPose => JSON.parse(JSON.stringify(p));

export class Theatre {
  onChange: () => void = () => {};

  private active = false;
  private finger: FingerId | null = null;
  private step: Step = 'mark';
  private plan: ZPlan | null = null;
  private op: Operation | null = null;
  private before: HandPose | null = null;
  private marked = 0;
  private cut = 0;
  private cutting = false;
  private stitches: boolean[] = [];
  private busy = false;
  private anim = 0;
  private timer = 0;

  constructor(
    private view: HandView,
    private getPose: () => HandPose,
    private setPose: (p: HandPose, structural: boolean) => void,
  ) {
    view.onPointer = (kind, hit) => this.pointer(kind, hit);
  }

  /** Fingers there is something to operate on. */
  candidates(): FingerId[] {
    const pose = this.before ?? this.getPose();
    return FINGER_IDS.filter((id) => pose[id].cord.present || pose[id].affected);
  }

  enter(preferred: FingerId) {
    this.active = true;
    this.before = clone(this.getPose());
    const c = this.candidates();
    this.start(c.includes(preferred) ? preferred : c[0] ?? null);
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
    this.op = null;
    this.marked = this.cut = 0;
    this.cutting = false;
    this.busy = false;
    this.view.setTool(null);
    this.view.setMarks(null);
    this.view.setWoundDetail(null);
    this.view.setSutures([]);
  }

  /** Start (or restart) the operation on a finger. */
  start(finger: FingerId | null) {
    this.reset();
    if (this.before) this.setPose(this.before, true);
    this.finger = finger;
    this.step = 'mark';
    if (!finger) {
      this.plan = null;
      this.view.setOperation(null);
      this.render();
      return;
    }
    const plan = planZ(this.getPose(), finger);
    this.plan = plan;
    this.op = { finger, a: plan.a, b: plan.b, open: false, excised: false };
    this.stitches = plan.stitches.map(() => false);
    this.view.setOperation(this.op);
    this.showMarks();
    const z = this.view.surfaceZ(plan.centre[0], plan.centre[1]);
    this.view.focus(new THREE.Vector3(plan.centre[0], plan.centre[1], z), new THREE.Vector3(-0.12, -0.42, 1), 23);
    this.render();
  }

  private showMarks() {
    const plan = this.plan;
    if (!plan) return;
    const closed = this.step === 'suture' || this.step === 'done';
    this.view.setMarks({ incision: plan.incision, marked: closed ? 0 : this.marked, cut: closed ? 0 : this.cut, scar: closed ? plan.scar : null });
  }

  private go(step: Step) {
    this.step = step;
    this.view.setTool(step === 'incise' ? 'scalpel' : step === 'excise' ? 'forceps' : step === 'suture' ? 'needle' : null);
    this.render();
  }

  // --- Actions ---------------------------------------------------------------

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

  private markSkin() {
    const total = pathLength(this.plan!.incision);
    this.busy = true;
    this.render();
    this.animate(1400, (t) => {
      this.marked = total * t;
      this.showMarks();
    }, () => {
      this.busy = false;
      this.go('incise');
    });
  }

  private cutForMe() {
    const plan = this.plan!;
    const total = pathLength(plan.incision);
    const from = this.cut;
    this.busy = true;
    this.view.setTool('scalpel');
    this.render();
    this.animate(2200 * (1 - from / total) + 200, (t) => {
      this.cut = from + (total - from) * t;
      this.showMarks();
      this.moveScalpel(this.cut);
    }, () => {
      this.busy = false;
      this.finishIncision();
    });
  }

  private moveScalpel(s: number) {
    const plan = this.plan!;
    const p = pointAlong(plan.incision, s);
    const q = pointAlong(plan.incision, s + 0.05);
    const dir: P2 = [q[0] - p[0], q[1] - p[1]];
    const len = Math.hypot(dir[0], dir[1]);
    const d: P2 = len > 1e-6 ? [dir[0] / len, dir[1] / len] : plan.along;
    this.view.showScalpel(new THREE.Vector3(p[0], p[1], this.view.surfaceZ(p[0], p[1])), d);
  }

  private finishIncision() {
    this.cut = pathLength(this.plan!.incision);
    this.showMarks();
    this.view.showScalpel(null, [0, 1]);
    this.go('open');
  }

  private raiseFlaps() {
    this.op = { ...this.op!, open: true };
    this.busy = true;
    this.render();
    this.whenMeshed(() => {
      this.view.setWoundDetail(this.plan);
      this.busy = false;
      this.go('excise');
    });
    this.view.setOperation(this.op);
  }

  private exciseCord() {
    const f = this.finger!;
    this.op = { ...this.op!, excised: true };
    this.view.setOperation(this.op);
    this.busy = true;
    this.view.setTool(null);
    this.render();
    // With the cord gone the finger can be straightened.
    const from = this.getPose()[f];
    const to = releasedAngles(from.mcp, from.pip, from.dip);
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    this.animate(1600, (t) => {
      const e = ease(t);
      const pose = clone(this.getPose());
      pose[f] = {
        ...pose[f],
        mcp: Math.round(from.mcp + (to.mcp - from.mcp) * e),
        pip: Math.round(from.pip + (to.pip - from.pip) * e),
        dip: Math.round(from.dip + (to.dip - from.dip) * e),
      };
      this.setPose(pose, false);
    }, () => {
      this.busy = false;
      this.go('close');
    });
  }

  private transpose() {
    this.op = { ...this.op!, open: false };
    this.view.setWoundDetail(null);
    this.busy = true;
    this.render();
    this.whenMeshed(() => {
      this.busy = false;
      this.go('suture');
      this.showMarks();
    });
    this.view.setOperation(this.op);
  }

  private placeStitch(i: number) {
    this.stitches[i] = true;
    this.view.setSutures(this.plan!.stitches.filter((_, k) => this.stitches[k]));
    if (this.stitches.every(Boolean)) this.go('done');
    else this.render();
  }

  private finishSutures() {
    const left = this.stitches.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0);
    this.busy = true;
    this.render();
    let n = 0;
    const next = () => {
      if (n >= left.length) {
        this.busy = false;
        this.render();
        return;
      }
      this.placeStitch(left[n++]);
      this.timer = window.setTimeout(next, 120);
    };
    next();
  }

  /** Run once the next mesh (with the latest operation state) is on screen. */
  private whenMeshed(fn: () => void) {
    const prev = this.view.onMeshReady;
    this.view.onMeshReady = () => {
      this.view.onMeshReady = prev;
      fn();
    };
  }

  /** Run the operation forward to a step, doing each step for the user. */
  async skipTo(target: string) {
    const order = [...STEPS.map((s) => s.id), 'done'];
    if (!order.includes(target as Step)) return;
    const actions: Partial<Record<Step, () => void>> = {
      mark: () => this.markSkin(),
      incise: () => this.cutForMe(),
      open: () => this.raiseFlaps(),
      excise: () => this.exciseCord(),
      close: () => this.transpose(),
      suture: () => this.finishSutures(),
    };
    const settle = (from: Step) =>
      new Promise<void>((resolve) => {
        const check = () => (this.step !== from && !this.busy ? resolve() : window.setTimeout(check, 50));
        check();
      });
    await new Promise<void>((r) => this.whenMeshed(r));
    while (this.step !== target && this.step !== 'done') {
      const from = this.step;
      actions[from]?.();
      await settle(from);
    }
    document.body.dataset.theatre = this.step;
  }

  // --- Pointer ---------------------------------------------------------------

  private pointer(kind: 'down' | 'move' | 'up', hit: THREE.Vector3 | null) {
    if (!this.plan || this.busy) return;
    const plan = this.plan;
    if (this.step === 'incise') {
      const total = pathLength(plan.incision);
      if (!hit) {
        this.view.showScalpel(null, [0, 1]);
        return;
      }
      const pr = project(plan.incision, hit.x, hit.y);
      if (kind === 'down') this.cutting = pr.dist < 0.35 && pr.s < this.cut + 0.4;
      if (kind === 'up') this.cutting = false;
      if (this.cutting && kind === 'move' && pr.dist < 0.4 && pr.s > this.cut && pr.s < this.cut + 0.6) {
        this.cut = pr.s;
        this.showMarks();
        this.render();
      }
      // The blade follows the pointer; while cutting it rides the line.
      if (this.cutting) this.moveScalpel(this.cut);
      else this.view.showScalpel(hit, this.tangent(pr.s));
      if (this.cut > total - 0.08) {
        this.cutting = false;
        this.finishIncision();
      }
    } else if (this.step === 'excise' && kind === 'down' && hit) {
      if (this.onCord(hit)) this.exciseCord();
    } else if (this.step === 'suture' && kind === 'down' && hit) {
      let best = -1;
      let bestD = 0.3;
      plan.stitches.forEach((s, i) => {
        const d = Math.hypot(hit.x - s.at[0], hit.y - s.at[1]);
        if (!this.stitches[i] && d < bestD) {
          best = i;
          bestD = d;
        }
      });
      if (best >= 0) this.placeStitch(best);
    }
  }

  private tangent(s: number): P2 {
    const plan = this.plan!;
    const p = pointAlong(plan.incision, s);
    const q = pointAlong(plan.incision, s + 0.05);
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  }

  private onCord(hit: THREE.Vector3): boolean {
    const sk = buildSkeleton(this.getPose());
    for (const c of sk.cords) {
      if (c.finger !== this.finger) continue;
      for (let i = 0; i + 1 < c.points.length; i++) {
        const a = new THREE.Vector3(...c.points[i]);
        const b = new THREE.Vector3(...c.points[i + 1]);
        const closest = new THREE.Line3(a, b).closestPointToPoint(hit, true, new THREE.Vector3());
        if (closest.distanceTo(hit) < c.radius + 0.2) return true;
      }
    }
    return false;
  }

  // --- Panel -----------------------------------------------------------------

  caption(): string {
    if (!this.finger) return 'No finger has a contracture or cord to operate on. Set one up in the clinic first.';
    const name = FINGER_LABELS[this.finger].toLowerCase();
    const what: Record<Step, string> = {
      mark: `the Z-plasty about to be marked over the cord of the ${name} finger`,
      incise: `the Z-plasty marked in violet over the cord of the ${name} finger`,
      open: `the incision along the cord of the ${name} finger`,
      excise: `the flaps held open by skin hooks, showing the cord with the digital nerves (yellow) and arteries (red) on either side`,
      close: `the ${name} finger released once the cord is removed`,
      suture: `the flaps transposed, turning the Z across the line of the finger`,
      done: `the wound closed with interrupted sutures`,
    };
    return `Right hand, palmar aspect, fasciectomy with Z-plasty: ${what[this.step]}.`;
  }

  private render() {
    const pickHost = document.getElementById('op-finger')!;
    const steps = document.getElementById('op-steps')!;
    const instruction = document.getElementById('op-instruction')!;
    const actions = document.getElementById('op-actions')!;

    pickHost.innerHTML = '';
    pickHost.className = 'op-finger';
    for (const id of this.candidates()) {
      const b = document.createElement('button');
      b.textContent = FINGER_LABELS[id];
      b.className = id === this.finger ? 'active' : '';
      b.disabled = this.busy;
      b.addEventListener('click', () => this.start(id));
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

    if (!this.finger || !this.plan) {
      instruction.textContent = 'Nothing to operate on yet. Go back to the clinic and give a finger a contracture or a palm cord.';
      this.onChange();
      return;
    }
    const name = FINGER_LABELS[this.finger].toLowerCase();
    const total = pathLength(this.plan.incision);
    switch (this.step) {
      case 'mark':
        instruction.textContent = `Draw a Z over the cord of the ${name} finger: a central line along the cord, with a limb at 60° from each end, on opposite sides.`;
        button('Mark the skin', () => this.markSkin(), true);
        break;
      case 'incise': {
        instruction.textContent = 'Take the scalpel and trace the violet line in one steady stroke, starting from the end on the little-finger side.';
        const bar = document.createElement('div');
        bar.className = 'progress';
        bar.innerHTML = `<span style="width:${Math.round((100 * this.cut) / total)}%"></span>`;
        instruction.after(bar);
        button('Cut for me', () => this.cutForMe());
        break;
      }
      case 'open':
        instruction.textContent = 'Lift the skin and fat off the cord, then hold the edges apart with skin hooks.';
        button('Raise the flaps', () => this.raiseFlaps(), true);
        break;
      case 'excise':
        instruction.textContent = 'The white cord lies in the middle of the wound. Keep clear of the nerves and arteries beside it and click the cord to cut it out.';
        button('Excise the cord', () => this.exciseCord());
        break;
      case 'close': {
        const b = this.before![this.finger];
        const now = this.getPose()[this.finger];
        instruction.textContent = `The finger now straightens: knuckle ${b.mcp}° to ${now.mcp}°, middle joint ${b.pip}° to ${now.pip}°. Swap the two triangular flaps over to lengthen the skin.`;
        button('Transpose the flaps', () => this.transpose(), true);
        break;
      }
      case 'suture': {
        const left = this.stitches.filter((s) => !s).length;
        instruction.textContent = `Click along the scar to place each stitch. ${left} to go.`;
        button('Finish the sutures', () => this.finishSutures());
        break;
      }
      case 'done': {
        const b = this.before![this.finger];
        const now = this.getPose()[this.finger];
        instruction.textContent = `Done. The ${name} finger went from ${b.mcp}° at the knuckle and ${b.pip}° at the middle joint to ${now.mcp}° and ${now.pip}°. Hand therapy starts once the wound has settled.`;
        button('Operate again', () => this.start(this.finger), true);
        break;
      }
    }
    // Remove a stale progress bar when not incising.
    if (this.step !== 'incise') document.querySelectorAll('#theatre .progress').forEach((e) => e.remove());
    else document.querySelectorAll('#theatre .progress').forEach((e, i, all) => i < all.length - 1 && e.remove());
    this.onChange();
  }
}
