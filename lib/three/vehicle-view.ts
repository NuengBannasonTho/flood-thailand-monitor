import * as THREE from 'three';
import type { VehicleId } from '../sim/vehicles';
import { buildVehicle, disposeModel, type VehicleModel } from './models';

export interface VehiclePose {
  /** rotation of the model around the vertical axis, radians; 0 points the nose to screen right */
  yaw: number;
  /** camera height above the horizon, radians; PI/2 looks straight down */
  elevation: number;
}

export interface VehicleMotion {
  /** 0 = parked, 1 = cruising */
  speed: number;
  /** true while moving through water: draws ripples around the vehicle */
  wading: boolean;
}

const easeOutBack = (t: number): number => {
  const c = 1.9;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

/**
 * Draws one vehicle model on a small transparent canvas. Used twice: as the spinning preview in the
 * vehicle picker and as the marker that drives along the route on the map.
 */
export class VehicleView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  private readonly holder = new THREE.Group();
  private readonly shadow: THREE.Mesh;
  private readonly ripples: THREE.Mesh[] = [];
  private model: VehicleModel | null = null;
  private modelId: VehicleId | null = null;
  private pose: VehiclePose = { yaw: 0, elevation: 0.5 };
  private motion: VehicleMotion = { speed: 0, wading: false };
  private poppedAt = 0;
  private last = 0;
  /** world units shown across the canvas */
  private span = 8;

  constructor(canvas: HTMLCanvasElement, sizePx: number, private readonly fixedSpan?: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(sizePx, sizePx, false);
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0b4, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-3, 8, 5);
    this.scene.add(sun);
    this.scene.add(this.holder);

    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0x1b1c27, transparent: true, opacity: 0.16, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.01;
    this.scene.add(this.shadow);

    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      this.ripples.push(ring);
      this.scene.add(ring);
    }
  }

  /** Shows this vehicle. The same one again keeps its model: rebuilding would recompile its shaders. */
  setVehicle(id: VehicleId): void {
    if (this.model && this.modelId === id) return;
    this.modelId = id;
    if (this.model) {
      this.holder.remove(this.model.root);
      disposeModel(this.model);
    }
    this.model = buildVehicle(id);
    this.holder.add(this.model.root);
    this.span = this.fixedSpan ?? this.model.size * 1.5;
    this.shadow.scale.set(this.model.size * 0.5, this.model.size * (this.model.floats ? 0.16 : 0.26), 1);
    this.shadow.visible = !this.model.floats;
    this.poppedAt = performance.now();
  }

  setPose(pose: VehiclePose): void {
    this.pose = pose;
  }

  setMotion(motion: VehicleMotion): void {
    this.motion = motion;
  }

  render(now: number): void {
    const model = this.model;
    if (!model) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    const half = this.span / 2;
    this.camera.left = -half;
    this.camera.right = half;
    this.camera.top = half;
    this.camera.bottom = -half;
    const e = Math.min(Math.PI / 2 - 0.02, Math.max(0.12, this.pose.elevation));
    this.camera.position.set(0, Math.sin(e) * 60, Math.cos(e) * 60);
    this.camera.lookAt(0, model.size * 0.12, 0);
    this.camera.updateProjectionMatrix();

    const pop = Math.min(1, (now - this.poppedAt) / 420);
    this.holder.scale.setScalar(0.55 + 0.45 * easeOutBack(pop));
    this.holder.rotation.y = this.pose.yaw;
    this.shadow.rotation.z = this.pose.yaw;

    const t = now / 1000;
    const { speed, wading } = this.motion;
    for (const spinner of model.spinners) spinner.rotation.z -= dt * (model.floats ? 26 : 9) * speed;
    if (model.floats) {
      model.root.position.y = -0.18 + Math.sin(t * 2.1) * 0.06;
      model.root.rotation.x = Math.sin(t * 1.7) * 0.05;
      model.root.rotation.z = Math.sin(t * 1.3) * 0.025 + speed * 0.04;
    } else {
      // a little suspension bounce while moving
      model.root.position.y = Math.abs(Math.sin(t * 11)) * 0.035 * speed;
      model.root.rotation.z = 0;
    }

    const rippling = wading;
    this.ripples.forEach((ring, i) => {
      const phase = (t * 0.9 + i * 0.5) % 1;
      const scale = model.size * (0.35 + phase * 0.55);
      ring.scale.set(scale, scale * 0.8, 1);
      ring.rotation.z = this.pose.yaw;
      const mat = ring.material;
      if (mat instanceof THREE.MeshBasicMaterial) mat.opacity = rippling ? (1 - phase) * 0.75 : 0;
    });

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.model) disposeModel(this.model);
    this.renderer.dispose();
  }
}
