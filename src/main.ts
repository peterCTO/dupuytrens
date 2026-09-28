import './style.css';
import { HandView, ViewName } from './scene';
import { Theatre } from './theatre';
import {
  FINGER_IDS,
  FINGER_LABELS,
  FingerId,
  HandPose,
  RELAXED,
  defaultPose,
  totalDeficit,
  tubianaStage,
} from './hand/anatomy';

const pose: HandPose = defaultPose();
let active: FingerId = 'ring';

const view = new HandView(document.getElementById('viewport')!, pose);
view.onBusy = (busy) => {
  document.getElementById('busy')!.hidden = !busy;
};
view.onAspect = () => renderCaption();

type Mode = 'clinic' | 'theatre';
let mode: Mode = 'clinic';
const theatre = new Theatre(
  view,
  () => pose,
  (p, structural) => {
    Object.assign(pose, JSON.parse(JSON.stringify(p)));
    view.setPose(pose, structural);
    renderCaption();
  },
);
theatre.onChange = () => renderCaption();

function setMode(m: Mode) {
  if (m === mode) return;
  mode = m;
  document.body.dataset.mode = m;
  const theatreMode = m === 'theatre';
  document.getElementById('plate-no')!.textContent = theatreMode ? 'Plate II' : 'Plate I';
  document.getElementById('plate-title')!.innerHTML = theatreMode ? 'Fasciectomy with Z-plasty' : 'The Hand in Dupuytren&rsquo;s Contracture';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) b.classList.toggle('active', b.dataset.mode === m);
  if (theatreMode) theatre.enter(active);
  else {
    theatre.leave();
    renderFingers();
    renderSliders();
  }
  renderCaption();
}

const JOINTS = [
  { key: 'mcp', label: 'MCP', name: 'knuckle', min: 0, max: 90 },
  { key: 'pip', label: 'PIP', name: 'middle joint', min: 0, max: 110 },
  { key: 'dip', label: 'DIP', name: 'end joint', min: -20, max: 70 },
] as const;

const fingerList = document.getElementById('fingers')!;
const sliders = document.getElementById('sliders')!;

function renderFingers() {
  fingerList.innerHTML = '';
  for (const id of FINGER_IDS) {
    const p = pose[id];
    const li = document.createElement('li');
    li.className = id === active ? 'active' : '';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = p.affected;
    box.setAttribute('aria-label', `${FINGER_LABELS[id]} finger affected`);
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      const cord = pose[id].cord;
      pose[id] = box.checked ? { mcp: 30, pip: 25, dip: 5, affected: true, cord } : { ...RELAXED, cord };
      active = id;
      update(true);
    });
    const name = document.createElement('span');
    name.textContent = FINGER_LABELS[id];
    const angles = document.createElement('span');
    angles.className = 'angles';
    angles.textContent = summary(id);
    li.append(box, name, angles);
    li.addEventListener('click', () => {
      active = id;
      renderFingers();
      renderSliders();
    });
    fingerList.append(li);
  }
}

function summary(id: FingerId): string {
  const p = pose[id];
  const parts: string[] = [];
  if (p.affected) parts.push(`${p.mcp}° · ${p.pip}°`);
  if (p.cord.present) parts.push('palm cord');
  return parts.length ? parts.join(' · ') : 'unaffected';
}

const CORD_SLIDERS = [
  { key: 'start', label: 'Starts', name: 'cm back from the knuckle', min: 0.5, max: 7 },
  { key: 'length', label: 'Length', name: 'cm', min: 0.5, max: 7 },
] as const;

function renderCord() {
  const c = pose[active].cord;
  const host = document.getElementById('cord')!;
  host.innerHTML = '';
  const row = document.createElement('label');
  row.className = 'tick';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = c.present;
  box.addEventListener('change', () => {
    pose[active] = { ...pose[active], cord: { ...pose[active].cord, present: box.checked } };
    update(true);
  });
  row.append(box, document.createTextNode(` Cord in the palm below the ${FINGER_LABELS[active].toLowerCase()} finger`));
  host.append(row);

  for (const j of CORD_SLIDERS) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const id = `cord-${j.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${j.label} <small>${j.name}</small>`;
    const out = document.createElement('output');
    out.textContent = `${c[j.key].toFixed(1)} cm`;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(j.min);
    input.max = String(j.max);
    input.step = '0.1';
    input.value = String(c[j.key]);
    input.disabled = !c.present;
    input.addEventListener('input', () => {
      pose[active] = { ...pose[active], cord: { ...pose[active].cord, [j.key]: Number(input.value) } };
      out.textContent = `${Number(input.value).toFixed(1)} cm`;
      renderCordNote();
      update(false);
    });
    wrap.append(label, out, input);
    host.append(wrap);
  }
  const note = document.createElement('p');
  note.id = 'cord-note';
  note.className = 'hint';
  host.append(note);
  renderCordNote();
}

function renderCordNote() {
  const c = pose[active].cord;
  const note = document.getElementById('cord-note');
  if (!note) return;
  if (!c.present) note.textContent = 'Palm cords are set separately from the finger joints.';
  else if (c.length > c.start + 0.3)
    note.textContent = `Runs ${(c.length - c.start).toFixed(1)} cm past the knuckle onto the finger, so it bowstrings as the knuckle bends.`;
  else note.textContent = `Ends ${(c.start - c.length).toFixed(1)} cm short of the knuckle, lying in the palm.`;
}

function renderSliders() {
  const p = pose[active];
  document.getElementById('joints-title')!.textContent = `${FINGER_LABELS[active]} finger`;
  sliders.innerHTML = '';
  for (const j of JOINTS) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const id = `slider-${j.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${j.label} <small>${j.name}</small>`;
    const out = document.createElement('output');
    out.textContent = `${p[j.key]}°`;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(j.min);
    input.max = String(j.max);
    input.value = String(p[j.key]);
    input.disabled = !p.affected;
    input.addEventListener('input', () => {
      pose[active] = { ...pose[active], [j.key]: Number(input.value) };
      out.textContent = `${input.value}°`;
      update(false);
    });
    wrap.append(label, out, input);
    sliders.append(wrap);
  }
  renderStage();
  renderCord();
}

function renderStage() {
  const p = pose[active];
  const el = document.getElementById('stage')!;
  if (!p.affected) {
    el.innerHTML = '<em>Tick the box beside this finger to give it a contracture.</em>';
    return;
  }
  const { stage, note } = tubianaStage(p);
  el.innerHTML = `Total deficit <strong>${totalDeficit(p)}°</strong>, Tubiana stage <strong>${stage}</strong> <span class="hint">(${note})</span>`;
}

const ASPECT_NAMES: Record<ViewName, string> = {
  palmar: 'palmar aspect',
  dorsal: 'dorsal aspect',
  ulnar: 'seen from the ulnar (little-finger) side',
  radial: 'seen from the radial (thumb) side',
};

function renderCaption() {
  const affected = FINGER_IDS.filter((id) => pose[id].affected);
  const cords = FINGER_IDS.filter((id) => pose[id].cord.present);
  const listOf = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const cordText = cords.length
    ? `, with ${cords.length === 1 ? 'a palmar cord' : 'palmar cords'} in the ${listOf(cords.map((id) => FINGER_LABELS[id].toLowerCase()))} ${cords.length === 1 ? 'ray' : 'rays'}`
    : '';
  let what = 'no contracture';
  if (affected.length) {
    const parts = affected.map((id) => {
      const p = pose[id];
      return `the ${FINGER_LABELS[id].toLowerCase()} finger (MCP ${p.mcp}°, PIP ${p.pip}°; stage ${tubianaStage(p).stage})`;
    });
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    what = `Dupuytren’s contracture of ${list}`;
  }
  const aspect = view.aspect();
  document.getElementById('caption')!.innerHTML =
    mode === 'theatre'
      ? `<span class="fig">Fig. 2.</span> ${theatre.caption()}`
      : `<span class="fig">Fig. 1.</span> Right hand, ${ASPECT_NAMES[aspect]}, showing ${what}${cordText}.`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#views button')) {
    b.classList.toggle('active', b.dataset.view === aspect);
  }
}

function update(structural: boolean) {
  view.setPose(pose, structural);
  if (structural) {
    renderFingers();
    renderSliders();
  } else {
    // Keep slider focus while dragging; refresh the summaries only.
    const items = fingerList.querySelectorAll('.angles');
    FINGER_IDS.forEach((id, i) => {
      items[i].textContent = summary(id);
    });
    renderStage();
  }
  renderCaption();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#views button')) {
  b.addEventListener('click', () => view.goTo(b.dataset.view as ViewName));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) {
  b.addEventListener('click', () => setMode(b.dataset.mode as Mode));
}
document.body.dataset.mode = 'clinic';
document.querySelector<HTMLButtonElement>('#modes button[data-mode="clinic"]')!.classList.add('active');

renderFingers();
renderSliders();
renderCaption();

// Handy for screenshots and debugging: ?view=ulnar
const params = new URLSearchParams(location.search);
const initial = params.get('view') as ViewName | null;
if (initial && initial in ASPECT_NAMES) view.goTo(initial, true);
if (params.get('zoom')) view.zoom(Number(params.get('zoom')));
// ?mode=theatre&step=excise jumps straight to a step, for screenshots.
if (params.get('mode') === 'theatre') {
  setMode('theatre');
  const step = params.get('step');
  if (step) theatre.skipTo(step);
}
