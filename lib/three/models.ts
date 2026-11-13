import * as THREE from 'three';
import type { VehicleId } from '../sim/vehicles';

/** A low-poly vehicle built from primitives. Forward is +X, the ground is y = 0, units are metres. */
export interface VehicleModel {
  root: THREE.Group;
  /** wheels and propellers: spun around their local Z axis while moving */
  spinners: THREE.Object3D[];
  /** true for craft that float: they bob instead of rolling */
  floats: boolean;
  /** longest dimension, used to frame the model */
  size: number;
}

const PAINT = {
  white: 0xf5f5f7,
  glass: 0x23252f,
  tyre: 0x1a1b22,
  hub: 0xc9cbd6,
  steel: 0x8a8d9a,
  dark: 0x2b2d39,
  red: 0xe5484d,
  orange: 0xf5762a,
  silver: 0xb9bcc8,
  cargo: 0xe7e8ee,
  teak: 0xb07440,
  teakDark: 0x7c4f2a,
  canopy: 0x2f7fe0,
  lamp: 0xfff2c4,
  tail: 0xd9383d,
  skin: 0xe9b995,
} as const;

const material = (color: number): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color, flatShading: true });

function box(parent: THREE.Object3D, size: [number, number, number], at: [number, number, number], color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
  mesh.position.set(...at);
  parent.add(mesh);
  return mesh;
}

/** A wheel with its axle along Z. Returned so the caller can spin it. */
function wheel(parent: THREE.Object3D, radius: number, width: number, x: number, z: number): THREE.Object3D {
  const group = new THREE.Group();
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 14), material(PAINT.tyre));
  tyre.rotation.x = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.45, radius * 0.45, width * 1.08, 6), material(PAINT.hub));
  hub.rotation.x = Math.PI / 2;
  group.add(tyre, hub);
  group.position.set(x, radius, z);
  parent.add(group);
  return group;
}

function lamps(parent: THREE.Object3D, frontX: number, rearX: number, y: number, halfWidth: number): void {
  for (const z of [-halfWidth, halfWidth]) {
    box(parent, [0.08, 0.16, 0.34], [frontX, y, z], PAINT.lamp);
    box(parent, [0.08, 0.14, 0.3], [rearX, y, z], PAINT.tail);
  }
}

function car(): VehicleModel {
  const root = new THREE.Group();
  box(root, [4.2, 0.6, 1.76], [0, 0.62, 0], PAINT.white);
  box(root, [2.15, 0.52, 1.56], [-0.2, 1.18, 0], PAINT.glass);
  box(root, [1.9, 0.07, 1.5], [-0.2, 1.47, 0], PAINT.white);
  lamps(root, 2.1, -2.1, 0.7, 0.6);
  const spinners = [wheel(root, 0.34, 0.26, 1.3, 0.82), wheel(root, 0.34, 0.26, 1.3, -0.82), wheel(root, 0.34, 0.26, -1.3, 0.82), wheel(root, 0.34, 0.26, -1.3, -0.82)];
  return { root, spinners, floats: false, size: 4.4 };
}

function pickup(): VehicleModel {
  const root = new THREE.Group();
  box(root, [5.1, 0.55, 1.86], [0, 0.78, 0], PAINT.silver);
  box(root, [1.7, 0.62, 1.7], [0.55, 1.36, 0], PAINT.glass);
  box(root, [1.6, 0.07, 1.64], [0.55, 1.7, 0], PAINT.silver);
  box(root, [1.5, 0.3, 1.8], [1.8, 1.05, 0], PAINT.silver); // bonnet
  // open bed: two side walls and a tailgate
  box(root, [2.2, 0.42, 0.08], [-1.45, 1.26, 0.89], PAINT.silver);
  box(root, [2.2, 0.42, 0.08], [-1.45, 1.26, -0.89], PAINT.silver);
  box(root, [0.08, 0.42, 1.86], [-2.51, 1.26, 0], PAINT.silver);
  box(root, [2.1, 0.04, 1.7], [-1.45, 1.08, 0], PAINT.dark);
  lamps(root, 2.55, -2.56, 0.86, 0.66);
  const spinners = [wheel(root, 0.42, 0.3, 1.55, 0.86), wheel(root, 0.42, 0.3, 1.55, -0.86), wheel(root, 0.42, 0.3, -1.5, 0.86), wheel(root, 0.42, 0.3, -1.5, -0.86)];
  return { root, spinners, floats: false, size: 5.3 };
}

function truck(): VehicleModel {
  const root = new THREE.Group();
  box(root, [6.4, 0.32, 1.9], [0, 1.2, 0], PAINT.dark); // chassis, high off the ground
  box(root, [1.7, 1.55, 2.1], [2.3, 2.1, 0], PAINT.orange);
  box(root, [0.1, 0.7, 1.8], [3.16, 2.35, 0], PAINT.glass);
  box(root, [4.2, 1.9, 2.2], [-0.95, 2.32, 0], PAINT.cargo);
  box(root, [4.2, 0.08, 2.2], [-0.95, 1.4, 0], PAINT.steel);
  lamps(root, 3.16, -3.06, 1.5, 0.75);
  const spinners: THREE.Object3D[] = [];
  for (const x of [2.3, -1.3, -2.45]) {
    spinners.push(wheel(root, 0.62, 0.38, x, 0.95), wheel(root, 0.62, 0.38, x, -0.95));
  }
  return { root, spinners, floats: false, size: 6.6 };
}

function motorbike(): VehicleModel {
  const root = new THREE.Group();
  const spinners = [wheel(root, 0.32, 0.12, 0.68, 0), wheel(root, 0.32, 0.12, -0.68, 0)];
  box(root, [1.15, 0.26, 0.24], [0, 0.56, 0], PAINT.red);
  box(root, [0.62, 0.1, 0.28], [-0.25, 0.78, 0], PAINT.dark); // seat
  const fork = box(root, [0.08, 0.72, 0.08], [0.58, 0.68, 0], PAINT.steel);
  fork.rotation.z = -0.32;
  box(root, [0.06, 0.06, 0.62], [0.48, 1.02, 0], PAINT.dark); // handlebar
  box(root, [0.1, 0.14, 0.16], [0.6, 0.86, 0], PAINT.lamp);
  // rider
  box(root, [0.3, 0.56, 0.4], [-0.2, 1.14, 0], PAINT.white);
  box(root, [0.5, 0.12, 0.12], [0.12, 1.2, 0.2], PAINT.white);
  box(root, [0.5, 0.12, 0.12], [0.12, 1.2, -0.2], PAINT.white);
  const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.19, 1), material(PAINT.orange));
  helmet.position.set(-0.16, 1.6, 0);
  root.add(helmet);
  return { root, spinners, floats: false, size: 2.4 };
}

/** A Thai long-tail boat: narrow teak hull, upswept bow with garlands, engine on a long propeller shaft. */
function boat(): VehicleModel {
  const root = new THREE.Group();
  const outline = (scale: number): THREE.Shape => {
    const shape = new THREE.Shape();
    shape.moveTo(-3.6, -0.55 * scale);
    shape.lineTo(1.6, -0.78 * scale);
    shape.lineTo(4.3, 0);
    shape.lineTo(1.6, 0.78 * scale);
    shape.lineTo(-3.6, 0.55 * scale);
    shape.closePath();
    return shape;
  };
  const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(outline(1), { depth: 0.5, bevelEnabled: false }), material(PAINT.teak));
  hull.rotation.x = -Math.PI / 2;
  root.add(hull);
  const deck = new THREE.Mesh(new THREE.ShapeGeometry(outline(0.78)), material(PAINT.teakDark));
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 0.51;
  deck.scale.setScalar(0.94);
  root.add(deck);
  const prow = box(root, [1.5, 0.14, 0.2], [4.6, 0.86, 0], PAINT.teak);
  prow.rotation.z = 0.5;
  // garlands tied to the bow for luck
  box(root, [0.12, 0.34, 0.26], [4.75, 0.8, 0], PAINT.red);
  box(root, [0.12, 0.3, 0.26], [4.58, 0.7, 0], PAINT.lamp);
  box(root, [0.12, 0.26, 0.26], [4.42, 0.62, 0], PAINT.canopy);
  for (const x of [-1.6, -0.3, 1.0]) box(root, [0.22, 0.06, 1.2], [x, 0.62, 0], PAINT.teak); // benches
  for (const [x, z] of [[-2.0, 0.55], [-2.0, -0.55], [1.2, 0.6], [1.2, -0.6]] as const) box(root, [0.06, 1.0, 0.06], [x, 1.0, z], PAINT.steel);
  box(root, [3.5, 0.07, 1.4], [-0.4, 1.52, 0], PAINT.canopy);
  // engine and long tail
  box(root, [0.6, 0.45, 0.45], [-3.2, 0.95, 0], PAINT.dark);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3.2, 6), material(PAINT.steel));
  shaft.rotation.z = Math.PI / 2 - 0.22;
  shaft.position.set(-4.85, 0.6, 0);
  root.add(shaft);
  const propeller = new THREE.Group();
  propeller.position.set(-6.4, 0.25, 0);
  propeller.rotation.y = Math.PI / 2;
  const blade = box(propeller, [0.5, 0.08, 0.04], [0, 0, 0], PAINT.steel);
  blade.rotation.z = 0.4;
  const blade2 = box(propeller, [0.08, 0.5, 0.04], [0, 0, 0], PAINT.steel);
  blade2.rotation.z = 0.4;
  root.add(propeller);
  root.position.x = 1.0; // centre the model, tail included
  const wrap = new THREE.Group();
  wrap.add(root);
  return { root: wrap, spinners: [propeller], floats: true, size: 8.4 };
}

const BUILDERS: Record<VehicleId, () => VehicleModel> = { motorbike, car, pickup, truck, boat };

export function buildVehicle(id: VehicleId): VehicleModel {
  return BUILDERS[id]();
}

export function disposeModel(model: VehicleModel): void {
  model.root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      const mats: THREE.Material[] = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) m.dispose();
    }
  });
}
