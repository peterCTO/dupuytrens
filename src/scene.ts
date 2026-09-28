// The Three.js stage: a white "plate" with soft studio light, a small plinth
// and the hand model standing on it.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HandPose } from './hand/anatomy';
import { CUT_Y } from './hand/sdf';
import { skinMesh } from './hand/skin';
import type { MeshRequest } from './hand/worker';
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
  positions: Float32Array;
  normals: Float32Array;
  weights: Float32Array;
}

const clonePose = (p: HandPose): HandPose => JSON.parse(JSON.stringify(p));

export class HandView {
  onBusy: (busy: boolean) => void = () => {};
  onAspect: () => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private hand: THREE.Mesh;
  private material: THREE.MeshPhysicalMaterial;
  private worker: Worker;
  private pose: HandPose;
  private bind: Bind | null = null;
  private inFlight = false;
  private queued: MeshRequest | null = null;
  private nextId = 1;
  private remeshTimer = 0;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private lastAspect: ViewName = 'palmar';

  constructor(private host: HTMLElement, pose: HandPose) {
    this.pose = clonePose(pose);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xffffff, 0);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(26, 1, 1, 400);
    this.camera.position.copy(VIEWS.palmar);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(TARGET);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 14;
    this.controls.maxDistance = 110;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.addEventListener('start', () => (this.flight = null));

    this.setupLights();
    this.setupStage();

    this.material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.58,
      metalness: 0,
      sheen: 0.6,
      sheenRoughness: 0.45,
      sheenColor: new THREE.Color(0xffd6c4),
      clearcoat: 0.12,
      clearcoatRoughness: 0.55,
      envMapIntensity: 0.55,
    });
    addWaxTranslucency(this.material);
    this.hand = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.hand.castShadow = true;
    this.hand.receiveShadow = true;
    this.hand.position.y = -CUT_Y;
    this.scene.add(this.hand);

    this.worker = new Worker(new URL('./hand/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.receive(e.data);

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

    const key = new THREE.DirectionalLight(0xfff4ea, 2.6);
    key.position.set(-20, 26, 18);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    const s = key.shadow.camera;
    s.left = -14; s.right = 14; s.top = 14; s.bottom = -14; s.near = 5; s.far = 80;
    key.target.position.copy(TARGET);
    this.scene.add(key, key.target);

    const fill = new THREE.DirectionalLight(0xeef2ff, 0.4);
    fill.position.set(22, 8, 14);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xfff6ee, 1.9);
    rim.position.set(6, 18, -26);
    this.scene.add(rim);
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
    if (instant) {
      this.camera.position.copy(to);
      this.controls.update();
      this.onAspect();
    } else {
      this.flight = { from: this.camera.position.clone(), to, t: 0 };
    }
  }

  /** Which face of the hand the camera is looking at. */
  aspect(): ViewName {
    const d = this.camera.position.clone().sub(this.controls.target);
    if (Math.abs(d.x) > Math.abs(d.z)) return d.x < 0 ? 'ulnar' : 'radial';
    return d.z >= 0 ? 'palmar' : 'dorsal';
  }

  private request(h: number) {
    const req: MeshRequest = { id: this.nextId++, pose: clonePose(this.pose), h };
    if (this.inFlight) {
      // Only the latest fine request matters; a queued draft is superseded.
      this.queued = req;
      return;
    }
    this.send(req);
  }

  private send(req: MeshRequest) {
    this.inFlight = true;
    delete document.body.dataset.ready;
    this.onBusy(true);
    this.worker.postMessage(req);
  }

  private receive(msg: { pose: HandPose; mesh: MeshData }) {
    const { mesh } = msg;
    this.bind = {
      pose: msg.pose,
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
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    this.hand.geometry.dispose();
    this.hand.geometry = g;
    // The pose may have moved on while this mesh was being built.
    this.applySkin();

    this.inFlight = false;
    if (this.queued) {
      const next = this.queued;
      this.queued = null;
      next.pose = clonePose(this.pose);
      this.send(next);
    } else {
      this.onBusy(false);
      document.body.dataset.ready = 'true';
    }
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
      const r = THREE.MathUtils.lerp(f.from.distanceTo(TARGET), f.to.distanceTo(TARGET), e);
      const dir = f.from.clone().sub(TARGET).normalize().lerp(f.to.clone().sub(TARGET).normalize(), e);
      if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
      this.camera.position.copy(TARGET).add(dir.setLength(r));
      if (f.t >= 1) this.flight = null;
    }
    this.controls.update();
    const aspect = this.aspect();
    if (aspect !== this.lastAspect) {
      this.lastAspect = aspect;
      this.onAspect();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Softens the terminator and lets a little warm light bleed into the shadow
 * side, the way wax or a painted resin model scatters light.
 */
function addWaxTranslucency(material: THREE.MeshPhysicalMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      {
        float wrap = 0.5 + 0.5 * dot(normal, normalize(vec3(-0.35, 0.8, 0.5)));
        reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.26, 0.11, 0.07) * (1.0 - wrap * 0.6);
      }`,
    );
  };
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
