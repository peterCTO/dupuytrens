// The Three.js stage: a white "plate" with soft studio light, a small plinth
// and the hand model standing on it.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HandPose } from './hand/anatomy';
import { CUT_Y, PALM_CREASES } from './hand/sdf';
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
  private hairFixed: THREE.LineSegments;
  private hairFingers: THREE.LineSegments;
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
    const hairMaterial = new THREE.LineBasicMaterial({ color: 0x6a5242, transparent: true, opacity: 0.36, depthWrite: false });
    this.hairFixed = new THREE.LineSegments(new THREE.BufferGeometry(), hairMaterial);
    this.hairFingers = new THREE.LineSegments(new THREE.BufferGeometry(), hairMaterial);
    this.hand.add(this.hairFixed, this.hairFingers);

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
    this.builder.build(pose, h).then((mesh) => this.receive({ pose, mesh, h }));
  }

  private receive(msg: { pose: HandPose; mesh: MeshData; h: number }) {
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
 * - pores and a dense network of fine creases (joint creases, knuckle
 *   wrinkles, the fine lines of the palm and the diamond pattern on the back
 *   of the hand), drawn procedurally so they stay sharp up close;
 * - glossy nails against matte skin;
 * - soft darkening in creases and between fingers (ambient occlusion baked per vertex);
 * - warm light scattering through thin flesh, strongest when backlit.
 */
function addSkinShading(material: THREE.MeshPhysicalMaterial, backLight: { value: THREE.Vector3 }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBackLight = backLight;
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
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.78, 0.6, 0.55), skinDark);`,
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
}
`;

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
