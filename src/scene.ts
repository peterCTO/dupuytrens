// The Three.js stage: a white "plate" with soft studio light, a small plinth
// and the hand model standing on it.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HandPose } from './hand/anatomy';
import { CUT_Y } from './hand/sdf';
import { skinMesh } from './hand/skin';
import { MeshBuilder } from './hand/builder';
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
  private builder = new MeshBuilder();
  private pose: HandPose;
  private bind: Bind | null = null;
  private inFlight = false;
  private queued: number | null = null;
  private remeshTimer = 0;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
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
    this.controls.minDistance = 14;
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
    addSkinShading(this.material, this.backLight);
    this.hand = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.hand.castShadow = true;
    this.hand.receiveShadow = true;
    this.hand.position.y = -CUT_Y;
    this.scene.add(this.hand);

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
    if (instant) {
      this.camera.position.copy(to);
      this.controls.update();
      this.onAspect();
    } else {
      this.flight = { from: this.camera.position.clone(), to, t: 0 };
    }
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
    this.builder.build(pose, h).then((mesh) => this.receive({ pose, mesh }));
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
    g.setAttribute('shading', new THREE.BufferAttribute(mesh.shading, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    this.hand.geometry.dispose();
    this.hand.geometry = g;
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
 * - fine pores and wrinkles, as a procedural bump on the surface normal;
 * - glossy nails against matte skin;
 * - soft darkening in creases and between fingers (ambient occlusion baked per vertex);
 * - warm light scattering through thin flesh, strongest when backlit, as in real
 *   fingers or a cast in translucent resin.
 */
function addSkinShading(material: THREE.MeshPhysicalMaterial, backLight: { value: THREE.Vector3 }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBackLight = backLight;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 shading;
        varying vec3 vShading;
        varying vec3 vObjPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vShading = shading;
        vObjPos = position;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uBackLight;
        varying vec3 vShading;
        varying vec3 vObjPos;
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
        float skinBump(vec3 p) {
          return skinNoise(p * 14.0) * 0.55 + skinNoise(p * 31.0) * 0.3 + skinNoise(p * 4.5) * 0.4;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float pore = skinNoise(vObjPos * 22.0);
        roughnessFactor = mix(roughnessFactor + (pore - 0.5) * 0.12, 0.18, vShading.x);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // Bump the normal with the gradient of the pore noise (object space is
          // world space here: the hand is only translated).
          float e = 0.01;
          float b0 = skinBump(vObjPos);
          vec3 g = vec3(skinBump(vObjPos + vec3(e, 0, 0)), skinBump(vObjPos + vec3(0, e, 0)), skinBump(vObjPos + vec3(0, 0, e))) - b0;
          g /= e;
          vec3 gv = mat3(viewMatrix) * g;
          float strength = 0.002 * (1.0 - vShading.x);
          normal = normalize(normal - strength * (gv - dot(gv, normal) * normal));
        }`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float ao = vShading.y;
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.indirectSpecular *= ao;
          reflectedLight.directDiffuse *= mix(0.55, 1.0, ao);
          reflectedLight.directSpecular *= mix(0.4, 1.0, ao);

          float thin = exp(-vShading.z * 0.9);
          vec3 blood = vec3(0.95, 0.32, 0.2);
          // Light scattered inside the flesh fills the shadow side with warmth.
          reflectedLight.indirectDiffuse += diffuseColor.rgb * blood * (0.1 + 0.35 * thin) * ao;
          // Backlit thin parts (finger edges, webs) glow.
          vec3 L = normalize(mat3(viewMatrix) * uBackLight);
          float behind = pow(clamp(dot(-geometryViewDir, L), 0.0, 1.0), 2.0);
          float edge = pow(1.0 - abs(dot(normal, geometryViewDir)), 2.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * blood * thin * (behind * 1.2 + edge * 0.25);
        }`,
      );
  };
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
