// The Three.js stage: a white "plate" with soft studio light, a small plinth
// and the hand model standing on it.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HandPose, Operation, Vec3 } from './hand/anatomy';
import { CUT_Y, PALM_CREASES, Field, Layer, normalAt, sdf } from './hand/sdf';
import { SiteFrame, SiteGeom, fieldFor, framePoint } from './hand/surgery';
import { makeMarker, makeNeedle, makeScalpel, poseTool } from './instruments';
import { skinMesh } from './hand/skin';
import { MeshBuilder } from './hand/builder';
import { growHair } from './hand/hair';
import type { MeshData } from './hand/mesher';

export type ViewName = 'palmar' | 'dorsal' | 'ulnar' | 'radial';

const FINE = 0.12;
const DRAFT = 0.24;
const TARGET = new THREE.Vector3(0.8, 11.5, 1.5);

const VIEWS: Record<ViewName, THREE.Vector3> = {
  palmar: new THREE.Vector3(-26, 20, 56),
  dorsal: new THREE.Vector3(-14, 20, -60),
  ulnar: new THREE.Vector3(-62, 20, 8),
  radial: new THREE.Vector3(62, 20, 8),
};

interface Bind {
  pose: HandPose;
  op: Operation | null;
  positions: Float32Array;
  normals: Float32Array;
  weights: Float32Array;
}

const clonePose = (p: HandPose): HandPose => JSON.parse(JSON.stringify(p));

/** What is drawn on the skin at one Z-plasty site. */
export interface SiteMarks {
  geom: SiteGeom;
  /** How much of the Z has been marked in violet, and how much cut, in cm along it. */
  marked: number;
  cut: number;
  /** Draw the closed, transposed Z instead. */
  scar: boolean;
  /** Show a faint guide for the marker to follow. */
  guide: boolean;
}

export const MAX_SITES = 8;

export type ToolName = 'marker' | 'scalpel' | 'hand' | 'needle' | 'wrap';
export type PointerKind = 'down' | 'move' | 'up';

export interface PointerInfo {
  kind: PointerKind;
  /** Where the pointer meets the skin, in the hand's frame. */
  hit: THREE.Vector3 | null;
  /** The pickable object under the pointer, if any. */
  object: THREE.Object3D | null;
  /** Pointer position in CSS pixels within the canvas. */
  screen: THREE.Vector2;
  pressed: boolean;
}

export class HandView {
  onBusy: (busy: boolean) => void = () => {};
  onAspect: () => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private hand: THREE.Mesh;
  private hairFixed: THREE.LineSegments;
  private hairFingers: THREE.LineSegments;
  private material: THREE.MeshPhysicalMaterial;
  private builder = new MeshBuilder();
  private pose: HandPose;
  private bind: Bind | null = null;
  private inFlight = false;
  private queued: number | null = null;
  private remeshTimer = 0;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; t: number } | null = null;
  private op: Operation | null = null;
  /** The field of the mesh on screen, for finding where the pointer meets the skin. */
  private pickField: Field | null = null;
  private marks = {
    uSiteO: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector3()) },
    uSiteU: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector3()) },
    uSiteV: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector3()) },
    uSiteN: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector3()) },
    uSiteL: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) },
    uSiteState: { value: Array.from({ length: MAX_SITES }, () => new THREE.Vector4()) },
    uSiteCount: { value: 0 },
  };
  /** Flaps, sutures and other surgical detail, in the hand's frame. */
  readonly surgical = new THREE.Group();
  /** Objects the pointer can pick up (flaps). */
  pickables: THREE.Object3D[] = [];
  private tools: Record<string, THREE.Object3D> = { scalpel: makeScalpel(), marker: makeMarker(), needle: makeNeedle() };
  private tool: ToolName | null = null;
  private dragging = false;
  private layers: Partial<Record<Layer, THREE.Mesh>> = {};
  private reveal = { bandage: { value: -99 }, cast: { value: -99 } };
  /** Called with the pointer's state while a tool is in use. */
  onPointer: (info: PointerInfo) => void = () => {};
  /** Called whenever a new mesh has been built and is on screen. */
  onMeshReady: () => void = () => {};
  private lastAspect: ViewName = 'palmar';
  private key = new THREE.DirectionalLight(0xfff4ea, 2.7);
  private fill = new THREE.DirectionalLight(0xeef2ff, 0.45);
  private rim = new THREE.DirectionalLight(0xfff6ee, 1.5);
  /** World direction towards the rim light, for light bleeding through thin flesh. */
  private backLight = { value: new THREE.Vector3(0, 0, -1) };

  constructor(private host: HTMLElement, pose: HandPose) {
    this.pose = clonePose(pose);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xffffff, 0);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(26, 1, 1, 400);
    this.camera.position.copy(VIEWS.palmar);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(TARGET);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 110;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.addEventListener('start', () => (this.flight = null));

    this.setupLights();
    this.setupStage();

    this.material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0,
      sheen: 0.5,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0xffd6c4),
      clearcoat: 0.1,
      clearcoatRoughness: 0.5,
      envMapIntensity: 0.6,
    });
    addSkinShading(this.material, this.backLight, this.marks);
    this.hand = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.hand.castShadow = true;
    this.hand.receiveShadow = true;
    this.hand.position.y = -CUT_Y;
    this.scene.add(this.hand);
    const hairMaterial = new THREE.LineBasicMaterial({ color: 0x6a5242, transparent: true, opacity: 0.36, depthWrite: false });
    this.hairFixed = new THREE.LineSegments(new THREE.BufferGeometry(), hairMaterial);
    this.hairFingers = new THREE.LineSegments(new THREE.BufferGeometry(), hairMaterial);
    this.hand.add(this.hairFixed, this.hairFingers, this.surgical);
    for (const t of Object.values(this.tools)) {
      t.visible = false;
      this.hand.add(t);
    }
    this.setupPointer();

    this.request(DRAFT);
    this.request(FINE);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private setupLights() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.4;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xe9e2d8, 0.3));

    // The lights ride with the camera, like a photographer's studio rig, so
    // the model is modelled by raking light from whichever side it is seen.
    const key = this.key;
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 5;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    const s = key.shadow.camera;
    s.left = -14; s.right = 14; s.top = 14; s.bottom = -14; s.near = 5; s.far = 80;
    key.target.position.copy(TARGET);
    this.scene.add(key, key.target);

    this.scene.add(this.fill, this.rim);
    this.fill.target.position.copy(TARGET);
    this.rim.target.position.copy(TARGET);
    this.scene.add(this.fill.target, this.rim.target);
  }

  /** Place the lights relative to the camera: key high left, fill low right, rim behind. */
  private placeLights() {
    const back = this.camera.position.clone().sub(TARGET).normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, back).normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    const at = (r: number, u: number, b: number, dist: number) =>
      TARGET.clone().add(right.clone().multiplyScalar(r).add(up.clone().multiplyScalar(u)).add(back.clone().multiplyScalar(b)).normalize().multiplyScalar(dist));
    this.key.position.copy(at(-0.75, 0.8, 0.55, 40));
    this.fill.position.copy(at(0.9, -0.1, 0.5, 40));
    this.rim.position.copy(at(0.45, 0.6, -0.9, 40));
    this.backLight.value.copy(this.rim.position).sub(TARGET).normalize();
  }

  private setupStage() {
    // A shallow white plinth, as a museum model would stand on.
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(4.2, 4.4, 0.9, 96),
      new THREE.MeshStandardMaterial({ color: 0xf7f5f1, roughness: 0.85 }),
    );
    plinth.position.y = -0.45;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    this.scene.add(plinth);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.ShadowMaterial({ opacity: 0.1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.9;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  setPose(pose: HandPose, structural: boolean) {
    this.pose = clonePose(pose);
    if (this.bind) this.applySkin();
    window.clearTimeout(this.remeshTimer);
    this.remeshTimer = window.setTimeout(() => this.request(FINE), structural ? 0 : 160);
  }

  goTo(name: ViewName, instant = false) {
    const offset = VIEWS[name].clone();
    const to = TARGET.clone().add(offset.sub(TARGET).setLength(this.camera.position.distanceTo(this.controls.target)));
    this.fly(TARGET.clone(), to, instant);
  }

  /** Fly to one of the standard aspects, far enough back to see the whole hand. */
  overview(name: ViewName) {
    const to = TARGET.clone().add(VIEWS[name].clone().sub(TARGET).setLength(52));
    this.fly(TARGET.clone(), to, false);
  }

  /** Look at a point on the hand (its own frame) from a direction and distance. */
  focus(at: THREE.Vector3, dir: THREE.Vector3, distance: number, instant = false) {
    const target = at.clone().add(this.hand.position);
    this.fly(target, target.clone().add(dir.clone().normalize().multiplyScalar(distance)), instant);
  }

  private fly(target: THREE.Vector3, to: THREE.Vector3, instant: boolean) {
    if (instant) {
      this.controls.target.copy(target);
      this.camera.position.copy(to);
      this.controls.update();
      this.onAspect();
    } else {
      this.flight = { from: this.camera.position.clone(), to, fromTarget: this.controls.target.clone(), toTarget: target, t: 0 };
    }
  }

  /** The operation shaping the model (wound, cords removed), or null. */
  setOperation(op: Operation | null) {
    this.op = op ? { ...op } : null;
    window.clearTimeout(this.remeshTimer);
    this.request(FINE);
  }

  /** The skin's own material, for pieces of skin (flaps) made outside the mesher. */
  get skinMaterial(): THREE.Material {
    return this.material;
  }

  get currentPose(): HandPose {
    return this.pose;
  }

  setSiteMarks(sites: SiteMarks[]) {
    const u = this.marks;
    u.uSiteCount.value = Math.min(MAX_SITES, sites.length);
    sites.slice(0, MAX_SITES).forEach((m, i) => {
      const f = m.geom.frame;
      u.uSiteO.value[i].set(...f.o);
      u.uSiteU.value[i].set(...f.u);
      u.uSiteV.value[i].set(...f.v);
      u.uSiteN.value[i].set(...f.n);
      u.uSiteL.value[i].set(m.geom.limb, m.geom.back, 0, 0);
      u.uSiteState.value[i].set(m.marked, m.cut, m.scar ? 1 : 0, m.guide ? 1 : 0);
    });
  }

  setTool(tool: ToolName | null) {
    this.tool = tool;
    const drawn = tool === 'scalpel' || tool === 'marker' || tool === 'needle';
    this.renderer.domElement.style.cursor = drawn ? 'none' : tool === 'hand' ? 'grab' : tool ? 'crosshair' : '';
    for (const [name, t] of Object.entries(this.tools)) if (name !== tool) t.visible = false;
  }

  /** Show the current tool touching the skin at a point, moving along dir, with the skin's normal n. */
  showTool(at: THREE.Vector3 | null, dir: Vec3, n: Vec3) {
    const t = this.tool ? this.tools[this.tool] : undefined;
    if (!t) return;
    t.visible = at !== null;
    if (at) poseTool(t, at, new THREE.Vector3(...dir), new THREE.Vector3(...n));
  }

  /** Where the skin is under a point of a site's frame, marching in along -n. */
  surfacePoint(f: SiteFrame, u: number, v: number, fd: Field | null = this.pickField): { p: Vec3; hit: boolean } {
    const start = framePoint(f, u, v, 3);
    const hit = fd ? this.march(new THREE.Vector3(...start), new THREE.Vector3(...f.n).negate(), fd) : null;
    return hit ? { p: [hit.x, hit.y, hit.z], hit: true } : { p: framePoint(f, u, v, 0.8), hit: false };
  }

  /** The skin's normal at a point, from the field of the mesh on screen. */
  normalAt(p: Vec3): Vec3 {
    return this.pickField ? normalAt(this.pickField, p) : [0, 0, 1];
  }

  /** A point in the hand's frame, in CSS pixels on the canvas. */
  toScreen(p: Vec3): THREE.Vector2 {
    const v = new THREE.Vector3(...p).add(this.hand.position).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height);
  }

  /** Build a dressing over the hand as it is now; it stays hidden until revealed. */
  async buildLayer(layer: 'bandage' | 'cast'): Promise<void> {
    const mesh = await this.builder.build(clonePose(this.pose), this.op ? { ...this.op } : null, FINE, layer);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    const colors = mesh.colors;
    for (let i = 0; i < colors.length; i++) colors[i] = srgbToLinear(colors[i]);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    this.layers[layer]?.geometry.dispose();
    let m = this.layers[layer];
    if (!m) {
      m = new THREE.Mesh(g, dressingMaterial(layer, this.reveal[layer]));
      m.castShadow = true;
      m.receiveShadow = true;
      this.layers[layer] = m;
      this.hand.add(m);
    } else m.geometry = g;
  }

  /** Show a dressing up to a height along the hand (cm from the wrist cut); -99 hides it. */
  setReveal(layer: 'bandage' | 'cast', y: number) {
    this.reveal[layer].value = y;
  }

  clearLayers() {
    for (const m of Object.values(this.layers)) {
      if (!m) continue;
      this.hand.remove(m);
      m.geometry.dispose();
    }
    this.layers = {};
    this.reveal.bandage.value = this.reveal.cast.value = -99;
  }

  /** Sphere-trace a ray (hand frame) against the model's field. */
  private march(o: THREE.Vector3, d: THREE.Vector3, fd: Field | null = this.pickField): THREE.Vector3 | null {
    if (!fd) return null;
    let t = 0;
    for (let i = 0; i < 256 && t < 400; i++) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const dist = sdf(fd, x, y, z);
      if (dist < 0.002) return new THREE.Vector3(x, y, z);
      t += Math.max(dist * 0.8, 0.002);
    }
    return null;
  }

  private pointerInfo(e: PointerEvent, kind: PointerKind): PointerInfo {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin.clone().sub(this.hand.position);
    const hit = this.march(o, ray.ray.direction);
    const hits = this.pickables.length ? ray.intersectObjects(this.pickables, true) : [];
    // Walk up to the object that was registered as pickable.
    let object: THREE.Object3D | null = hits[0]?.object ?? null;
    while (object && !this.pickables.includes(object)) object = object.parent;
    return { kind, hit, object, screen: new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top), pressed: this.dragging };
  }

  private setupPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (!this.tool) return;
      const info = this.pointerInfo(e, 'down');
      if (!info.hit && !info.object) return;
      // Work on the hand rather than turning the model.
      this.dragging = true;
      info.pressed = true;
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      this.onPointer(info);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.tool) return;
      this.onPointer(this.pointerInfo(e, 'move'));
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.controls.enabled = true;
      this.onPointer(this.pointerInfo(e, 'up'));
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => {
      if (!this.dragging) for (const t of Object.values(this.tools)) t.visible = false;
    });
  }

  /** Move the camera closer (factor < 1) or further away along its current line. */
  zoom(factor: number) {
    const d = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(d);
    this.controls.update();
  }

  /** Which face of the hand the camera is looking at. */
  aspect(): ViewName {
    const d = this.camera.position.clone().sub(this.controls.target);
    if (Math.abs(d.x) > Math.abs(d.z)) return d.x < 0 ? 'ulnar' : 'radial';
    return d.z >= 0 ? 'palmar' : 'dorsal';
  }

  private request(h: number) {
    if (this.inFlight) {
      // Only the latest request matters; it runs with whatever the pose is then.
      this.queued = h;
      return;
    }
    this.send(h);
  }

  private send(h: number) {
    this.inFlight = true;
    delete document.body.dataset.ready;
    this.onBusy(true);
    const pose = clonePose(this.pose);
    const op = this.op ? { ...this.op } : null;
    this.builder.build(pose, op, h).then((mesh) => this.receive({ pose, op, mesh, h }));
  }

  private receive(msg: { pose: HandPose; op: Operation | null; mesh: MeshData; h: number }) {
    const { mesh } = msg;
    this.pickField = fieldFor(msg.pose, msg.op);
    this.bind = {
      pose: msg.pose,
      op: msg.op,
      positions: mesh.positions,
      normals: mesh.normals,
      weights: mesh.weights,
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals.slice(), 3));
    // The palette is authored in sRGB; lighting works in linear space.
    const colors = mesh.colors;
    for (let i = 0; i < colors.length; i++) colors[i] = srgbToLinear(colors[i]);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('shading', new THREE.BufferAttribute(mesh.shading, 3));
    g.setAttribute('crease', new THREE.BufferAttribute(mesh.creases, 4));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    this.hand.geometry.dispose();
    this.hand.geometry = g;

    const hair = growHair(msg.pose, mesh.positions, mesh.normals, mesh.weights, mesh.shading, msg.h * msg.h);
    for (const [obj, verts] of [[this.hairFixed, hair.fixed], [this.hairFingers, hair.fingers]] as const) {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      obj.geometry.dispose();
      obj.geometry = hg;
    }
    // The pose may have moved on while this mesh was being built.
    this.applySkin();

    this.inFlight = false;
    if (this.queued !== null) {
      const next = this.queued;
      this.queued = null;
      this.send(next);
    } else {
      this.onBusy(false);
      document.body.dataset.ready = 'true';
    }
    this.onMeshReady();
  }

  private applySkin() {
    if (!this.bind) return;
    const g = this.hand.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    skinMesh(
      this.bind.pose,
      this.pose,
      this.bind.positions,
      this.bind.normals,
      this.bind.weights,
      pos.array as Float32Array,
      nrm.array as Float32Array,
    );
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    g.computeBoundingSphere();
    // Finger hair is rebuilt with the mesh; hide it while the finger is being bent.
    this.hairFingers.visible = JSON.stringify(this.bind.pose) === JSON.stringify(this.pose);
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + 0.035);
      const e = f.t < 0.5 ? 2 * f.t * f.t : 1 - (-2 * f.t + 2) ** 2 / 2;
      // Swing around the model rather than cutting through it.
      const target = f.fromTarget.clone().lerp(f.toTarget, e);
      const r = THREE.MathUtils.lerp(f.from.distanceTo(f.fromTarget), f.to.distanceTo(f.toTarget), e);
      const dir = f.from.clone().sub(f.fromTarget).normalize().lerp(f.to.clone().sub(f.toTarget).normalize(), e);
      if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(dir.setLength(r));
      if (f.t >= 1) this.flight = null;
    }
    this.controls.update();
    this.placeLights();
    const aspect = this.aspect();
    if (aspect !== this.lastAspect) {
      this.lastAspect = aspect;
      this.onAspect();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Skin details that a plain physical material lacks:
 * - pores and a dense network of fine creases (joint creases, knuckle
 *   wrinkles, the fine lines of the palm and the diamond pattern on the back
 *   of the hand), drawn procedurally so they stay sharp up close;
 * - glossy nails against matte skin;
 * - soft darkening in creases and between fingers (ambient occlusion baked per vertex);
 * - warm light scattering through thin flesh, strongest when backlit.
 */
function addSkinShading(material: THREE.MeshPhysicalMaterial, backLight: { value: THREE.Vector3 }, marks: Record<string, { value: unknown }>) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBackLight = backLight;
    Object.assign(shader.uniforms, marks);
    shader.uniforms.uPalmCreases = { value: PALM_SEGMENTS };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 shading;
        attribute vec4 crease;
        varying vec3 vShading;
        varying vec4 vCrease;
        varying vec3 vObjPos;
        varying vec3 vObjNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vShading = shading;
        vCrease = crease;
        vObjPos = position;
        vObjNormal = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SKIN_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float skinHeight = 0.0;
        float skinDark = 0.0;
        skinDetail(skinHeight, skinDark);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.6, 0.55), skinDark);
        surgeryMarks(diffuseColor.rgb, skinHeight);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float pore = skinNoise(vObjPos * 22.0);
        roughnessFactor = mix(roughnessFactor + (pore - 0.5) * 0.12 + skinDark * 0.1, 0.18, vShading.x);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // Bump mapping from screen-space derivatives of the height.
          vec3 dpdx = dFdx(-vViewPosition);
          vec3 dpdy = dFdy(-vViewPosition);
          float hx = dFdx(skinHeight);
          float hy = dFdy(skinHeight);
          vec3 r1 = cross(dpdy, normal);
          vec3 r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          vec3 grad = sign(det) * (hx * r1 + hy * r2);
          normal = normalize(abs(det) * normal - grad);
        }`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // The open wound is lit by the theatre lamp, so don't let it sink into darkness.
          float ao = mix(max(vShading.y, 0.75), vShading.y, step(-0.5, vCrease.w));
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.indirectSpecular *= ao;
          reflectedLight.directDiffuse *= mix(0.55, 1.0, ao);
          reflectedLight.directSpecular *= mix(0.4, 1.0, ao);
          // The theatre lamp shines straight into an open wound, filling its shadows.
          float wound = 1.0 - step(-0.5, vCrease.w);
          reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.55 * wound;
          reflectedLight.indirectSpecular *= 1.0 - 0.6 * wound;

          // Tissue inside a wound is lit plainly, without the glow of light through skin.
          float thin = exp(-vShading.z * 0.9) * step(-0.5, vCrease.w);
          vec3 blood = vec3(0.95, 0.32, 0.2);
          // Light scattered inside the flesh fills the shadow side with warmth.
          reflectedLight.indirectDiffuse += diffuseColor.rgb * blood * (0.1 + 0.35 * thin) * ao * mix(0.3, 1.0, step(-0.5, vCrease.w));
          // Backlit thin parts (finger edges, webs) glow.
          vec3 L = normalize(mat3(viewMatrix) * uBackLight);
          float behind = pow(clamp(dot(-geometryViewDir, L), 0.0, 1.0), 2.0);
          float edge = pow(1.0 - abs(dot(normal, geometryViewDir)), 2.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * blood * thin * (behind * 1.2 + edge * 0.25);
        }`,
      );
  };
}

// The principal palm creases as line segments (x0, y0, x1, y1).
const PALM_SEGMENTS = PALM_CREASES.flatMap((line) =>
  line.slice(1).map((b, i) => new THREE.Vector4(line[i][0], line[i][1], b[0], b[1])),
);

const SKIN_GLSL = /* glsl */ `
#define PALM_SEGMENTS ${PALM_SEGMENTS.length}
uniform vec3 uBackLight;
uniform vec4 uPalmCreases[PALM_SEGMENTS];
varying vec3 vShading;
varying vec4 vCrease;
varying vec3 vObjPos;
varying vec3 vObjNormal;
#define MAX_SITES ${MAX_SITES}
uniform vec3 uSiteO[MAX_SITES];
uniform vec3 uSiteU[MAX_SITES];
uniform vec3 uSiteV[MAX_SITES];
uniform vec3 uSiteN[MAX_SITES];
uniform vec4 uSiteL[MAX_SITES];
uniform vec4 uSiteState[MAX_SITES];
uniform int uSiteCount;

float skinHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float skinNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skinHash(i), skinHash(i + vec3(1, 0, 0)), f.x),
                 mix(skinHash(i + vec3(0, 1, 0)), skinHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(skinHash(i + vec3(0, 0, 1)), skinHash(i + vec3(1, 0, 1)), f.x),
                 mix(skinHash(i + vec3(0, 1, 1)), skinHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

// A thin line wherever coord is near a multiple of spacing, faded out when the
// lines get too dense on screen to draw without shimmering.
float lines(float coord, float spacing, float width) {
  float fw = fwidth(coord);
  float d = abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
  // Never thinner than about a pixel and a half, so lines don't stair-step;
  // widened lines are drawn fainter to keep their weight.
  float w = max(width, fw * 1.5);
  float fade = clamp(1.5 - 2.0 * fw / spacing, 0.0, 1.0);
  return (1.0 - smoothstep(0.0, w, d)) * fade * sqrt(width / w);
}

// A single crease line at offset o along coord.
float creaseAt(float coord, float o, float width) {
  float w = max(width, fwidth(coord) * 1.5);
  return (1.0 - smoothstep(0.0, w, abs(coord - o))) * sqrt(width / w);
}

// Distance to the nearest edge of a 3D Voronoi cell pattern: skin's fine
// relief is a mesh of small polygons.
float cellEdge(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = vec3(skinHash(i + g), skinHash(i + g + 17.0), skinHash(i + g + 31.0));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return d2 - d1;
}

float cellLines(vec3 p, float width) {
  float e = cellEdge(p);
  float fw = fwidth(p.x) + fwidth(p.y);
  float fade = clamp(1.4 - fw * 2.0, 0.0, 1.0);
  return (1.0 - smoothstep(0.0, width + fw * 0.5, e)) * fade;
}

void skinDetail(out float height, out float dark) {
  vec3 P = vObjPos;
  float nail = vShading.x;
  // Pores.
  height = ((skinNoise(P * 24.0) - 0.5) * 0.5 + (skinNoise(P * 9.0) - 0.5) * 0.5) * 0.006;
  dark = 0.0;
  float wob = skinNoise(P * 2.1) - 0.5;
  float wob2 = skinNoise(P * 1.3 + 11.0) - 0.5;
  float breakup = smoothstep(0.3, 0.6, skinNoise(P * 2.6 + 5.0));

  // --- Digits ---
  // Halfway between two crease sites the nearest site flips, and a triangle
  // straddling the flip interpolates a false crease; its coordinate then
  // changes far faster than distance on the skin, so fade it out there.
  vec3 dP = fwidth(vObjPos);
  float jump = fwidth(vCrease.x) / max(length(dP), 1e-5);
  float trust = 1.0 - smoothstep(2.0, 4.0, jump);
  float dg = vCrease.y;
  if (dg > 0.01) {
    float t = vCrease.x + wob * 0.07;
    float pal = smoothstep(0.1, 0.7, vCrease.z);
    float dor = smoothstep(0.0, 0.75, -vCrease.z);
    float site = vCrease.w;
    float c = 0.0;
    // Main flexion creases: doubled at the PIP, single at DIP and palmodigital.
    if (site > 0.25 && site < 0.75) {
      c = max(creaseAt(t, -0.09, 0.022), creaseAt(t, 0.07, 0.022));
    } else {
      c = max(creaseAt(t, 0.0, 0.022), creaseAt(t, site < 0.25 ? 0.13 : 0.1, 0.014) * 0.6);
    }
    // Finer broken lines clustered around each crease.
    float cluster = lines(t + wob2 * 0.06, 0.05, 0.009) * (1.0 - smoothstep(0.08, 0.3, abs(t))) * 0.6 * breakup;
    float palmar = max(c, cluster) * pal;
    // Knuckle wrinkles on the back: a few wavy concentric folds over PIP and DIP.
    float span = site > 0.75 ? 0.3 : (site > 0.25 ? 0.48 : 0.0);
    float knuckle = 0.0;
    if (span > 0.0) {
      float env = 1.0 - smoothstep(span * 0.35, span, abs(t));
      // Soft folds rather than hairlines, so they read at any distance.
      float phase = (t + wob2 * 0.08 + wob * 0.05) / 0.1 * 6.2831853;
      float fold = pow(0.5 + 0.5 * cos(phase), 5.0);
      knuckle = fold * env * dor * mix(0.55, 1.0, breakup) * 0.85;
    }
    // The fine polygonal relief of skin, everywhere on the finger.
    float relief = cellLines(P * 4.0, 0.03) * 0.12;
    float f = max(max(palmar, knuckle) * trust, relief) * dg * (1.0 - nail);
    dark = max(dark, f * 0.55);
    height -= f * 0.012;
  }

  // --- Palm, back of the hand and forearm ---
  float body = 1.0 - dg;
  if (body > 0.01) {
    float palmSide = smoothstep(0.15, 0.6, vObjNormal.z);
    float backSide = 1.0 - palmSide;
    // Palm: secondary creases, mostly transverse with a few running along the
    // palm, each broken into segments, over a mesh of fine polygons.
    float warpA = (skinNoise(vec3(P.xy * 0.9, 1.0)) - 0.5) * 1.2;
    float warpB = (skinNoise(vec3(P.xy * 1.1, 7.0)) - 0.5) * 1.4;
    float tA = P.y + 0.3 * sin(P.x * 0.7 + 1.0) + warpA + P.x * 0.15;
    float tB = P.x + warpB + 0.2 * P.y;
    float segA = smoothstep(0.55, 0.7, skinNoise(vec3(P.x * 1.3, P.y * 2.4, 0.0) + 3.0));
    float segB = smoothstep(0.6, 0.72, skinNoise(vec3(P.x * 2.6, P.y * 1.0, 0.0) + 9.0));
    float secondary = max(lines(tA, 0.5, 0.018) * segA, lines(tB, 0.85, 0.016) * segB * 0.8);
    // A third, finer oblique family, like the small lines that criss-cross a palm.
    float tC = dot(P.xy, vec2(0.6, 0.8)) + warpA * 0.8;
    float segC = smoothstep(0.5, 0.65, skinNoise(vec3(P.xy * 2.2, 13.0)));
    secondary = max(secondary, lines(tC, 0.28, 0.012) * segC * 0.6);
    // The principal creases: deep, sharp and slightly irregular.
    float dMain = 9.0;
    for (int i = 0; i < PALM_SEGMENTS; i++) {
      vec4 sg = uPalmCreases[i];
      vec2 ab = sg.zw - sg.xy;
      vec2 ap = P.xy - sg.xy;
      float h = clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
      dMain = min(dMain, length(ap - ab * h));
    }
    dMain += wob * 0.03;
    float mainW = max(0.028, fwidth(dMain) * 1.5);
    float mainCrease = (1.0 - smoothstep(0.0, mainW, dMain)) * sqrt(0.028 / mainW);
    float mainShade = 1.0 - smoothstep(0.0, 0.14, dMain);
    float palmLines = max(max(secondary, mainCrease), cellLines(P * 2.6, 0.03) * 0.25);
    dark = max(dark, mainShade * 0.18 * palmSide * body);
    // Back of the hand: the diamond pattern of skin lines, broken up by noise.
    vec2 xy = P.xy;
    float a = dot(xy, vec2(0.87, 0.5)) + wob * 0.2;
    float b = dot(xy, vec2(-0.87, 0.5)) + wob2 * 0.2;
    float diamonds = max(lines(a, 0.2, 0.014), lines(b, 0.2, 0.014)) * breakup * 0.45;
    diamonds = max(diamonds, cellLines(P * 3.0, 0.03) * 0.14);
    float f = (palmLines * palmSide + diamonds * backSide) * body;
    dark = max(dark, f * 0.45);
    height -= f * 0.008;
  }
  // Inside a wound there is no skin to crease.
  float skin = step(-0.5, vCrease.w);
  dark *= skin;
  height *= skin;
}

// Distance from p to a three-limbed path, and how far along the path the nearest point lies.
float pathDist(vec2 p, vec2 q0, vec2 q1, vec2 q2, vec2 q3, out float s) {
  vec2 pts[4] = vec2[4](q0, q1, q2, q3);
  float best = 99.0;
  float base = 0.0;
  s = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 a = pts[i];
    vec2 ab = pts[i + 1] - a;
    float l = length(ab);
    float t = clamp(dot(p - a, ab) / (l * l), 0.0, 1.0);
    float d = length(p - a - ab * t);
    if (d < best) { best = d; s = base + t * l; }
    base += l;
  }
  return best;
}

// Surgical marker, the incision and the closed scar at each Z-plasty site.
void surgeryMarks(inout vec3 col, inout float height) {
  if (uSiteCount == 0) return;
  float skin = step(-0.5, vCrease.w);
  for (int i = 0; i < MAX_SITES; i++) {
    if (i >= uSiteCount) break;
    vec3 rel = vObjPos - uSiteO[i];
    float L = uSiteL[i].x;
    // Only on this side of the hand, facing the way the site faces.
    float facing = step(-uSiteL[i].y, dot(rel, uSiteN[i])) * smoothstep(0.0, 0.3, dot(vObjNormal, uSiteN[i])) * skin;
    if (facing <= 0.0) continue;
    vec2 p = vec2(dot(rel, uSiteU[i]), dot(rel, uSiteV[i]));
    if (abs(p.x) > L * 1.2 || abs(p.y) > L * 1.2) continue;
    vec4 st = uSiteState[i];
    float h = L * 0.5;
    float s60 = L * 0.8660254;
    float s;
    if (st.z > 0.5) {
      // The closed, transposed Z.
      float ds = pathDist(p, vec2(-s60, 0.0), vec2(0.0, h), vec2(0.0, -h), vec2(s60, 0.0), s);
      float w = max(0.014, fwidth(ds) * 1.2);
      float line = 1.0 - smoothstep(w * 0.5, w, ds);
      float flush = (1.0 - smoothstep(w, 0.09, ds)) * 0.4;
      col = mix(col, vec3(0.86, 0.55, 0.5), flush * facing);
      col = mix(col, vec3(0.5, 0.18, 0.17), line * facing);
      height -= line * 0.008 * facing;
      continue;
    }
    float d = pathDist(p, vec2(0.0, -s60), vec2(-h, 0.0), vec2(h, 0.0), vec2(0.0, s60), s);
    if (st.w > 0.5 && s > st.x) {
      // A faint dotted guide for the marker.
      float w = max(0.022, fwidth(d) * 1.5);
      float dots = smoothstep(0.35, 0.5, fract(s * 7.0)) * (1.0 - smoothstep(0.8, 0.95, fract(s * 7.0)));
      col = mix(col, vec3(0.42, 0.3, 0.55), (1.0 - smoothstep(w * 0.5, w, d)) * dots * 0.75 * facing);
    }
    if (s < st.x) {
      // Gentian violet from a skin marker: a soft line with a little ink variation.
      float w = max(0.03, fwidth(d) * 1.5);
      float ink = (1.0 - smoothstep(w * 0.45, w, d)) * (0.7 + 0.3 * skinNoise(vObjPos * 30.0));
      col = mix(col, vec3(0.34, 0.18, 0.5), ink * 0.8 * facing);
    }
    if (s < st.y) {
      // A clean incision: a fine dark line with a sliver of cut edge either side.
      float w = max(0.012, fwidth(d) * 1.2);
      float cut = 1.0 - smoothstep(w * 0.5, w, d);
      float lip = (1.0 - smoothstep(w, w * 3.0, d)) * 0.35;
      col = mix(col, vec3(0.78, 0.45, 0.42), lip * facing);
      col = mix(col, vec3(0.36, 0.08, 0.08), cut * facing);
      height -= (cut * 0.012 + lip * 0.004) * facing;
    }
  }
}
`;

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/**
 * Crepe bandage or plaster of Paris, revealed from the wrist up to a height
 * as it is applied. The bandage shows the overlapping edges of its turns.
 */
function dressingMaterial(layer: Layer, reveal: { value: number }): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: layer === 'cast' ? 0.95 : 0.85, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = reveal;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uReveal;
        varying vec3 vObjPos;
        float dHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // The dressing is wound on from the wrist; its leading edge wobbles a little.
        float edge = uReveal + 0.25 * sin(atan(vObjPos.z, vObjPos.x) * 1.0 + vObjPos.y);
        if (vObjPos.y > edge) discard;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${
          layer === 'bandage'
            ? `// Turns of the bandage: each overlaps the last, leaving a soft ridge.
        float turn = fract((vObjPos.y + 0.35 * atan(vObjPos.z, vObjPos.x)) * 0.9);
        diffuseColor.rgb *= 0.88 + 0.12 * smoothstep(0.0, 0.12, turn);
        // The crinkled weave of crepe.
        float weave = sin(vObjPos.y * 60.0 + sin(vObjPos.x * 9.0) * 2.0) * sin(vObjPos.x * 55.0 + vObjPos.z * 40.0);
        diffuseColor.rgb *= 0.96 + 0.04 * weave;`
            : `// Plaster: chalky, with the faint texture of the gauze it soaks into.
        float grain = dHash(floor(vObjPos * 40.0));
        diffuseColor.rgb *= 0.94 + 0.06 * grain;`
        }`,
      );
  };
  return m;
}
