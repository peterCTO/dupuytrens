import './style.css';
import { HandView, ViewName } from './scene';
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
      pose[id] = box.checked ? { mcp: 30, pip: 25, dip: 5, affected: true } : { ...RELAXED };
      active = id;
      update(true);
    });
    const name = document.createElement('span');
    name.textContent = FINGER_LABELS[id];
    const angles = document.createElement('span');
    angles.className = 'angles';
    angles.textContent = p.affected ? `${p.mcp}° · ${p.pip}°` : 'unaffected';
    li.append(box, name, angles);
    li.addEventListener('click', () => {
      active = id;
      renderFingers();
      renderSliders();
    });
    fingerList.append(li);
  }
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
  document.getElementById('caption')!.innerHTML = `<span class="fig">Fig. 1.</span> Right hand, ${ASPECT_NAMES[aspect]}, showing ${what}.`;
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
      const p = pose[id];
      items[i].textContent = p.affected ? `${p.mcp}° · ${p.pip}°` : 'unaffected';
    });
    renderStage();
  }
  renderCaption();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#views button')) {
  b.addEventListener('click', () => view.goTo(b.dataset.view as ViewName));
}

renderFingers();
renderSliders();
renderCaption();

// Handy for screenshots and debugging: ?view=ulnar
const initial = new URLSearchParams(location.search).get('view') as ViewName | null;
if (initial && initial in ASPECT_NAMES) view.goTo(initial, true);
