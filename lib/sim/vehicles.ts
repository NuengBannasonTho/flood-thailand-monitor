import type { RoadClass } from './roads';

export type VehicleId = 'motorbike' | 'car' | 'pickup' | 'truck' | 'boat';

export interface Vehicle {
  id: VehicleId;
  name: string;
  /** one-line description of how it handles water */
  note: string;
  /** deepest water it can drive through, metres; 0 for boats */
  wade: number;
  /** shallowest water it needs to float, metres; 0 for road vehicles */
  draft: number;
  /** top speed cap, km/h */
  maxKmh: number;
  /** road classes it may not use */
  banned: readonly RoadClass[];
}

/** Wading depths are rough rules of thumb, not manufacturer figures. */
export const VEHICLES: readonly Vehicle[] = [
  { id: 'motorbike', name: 'มอเตอร์ไซค์', note: 'ลุยน้ำได้ไม่เกิน 20 ซม. ห้ามขึ้นทางด่วน', wade: 0.2, draft: 0, maxKmh: 80, banned: ['motorway', 'motorway_link'] },
  { id: 'car', name: 'รถยนต์นั่ง', note: 'ลุยน้ำได้ไม่เกิน 30 ซม.', wade: 0.3, draft: 0, maxKmh: 120, banned: [] },
  { id: 'pickup', name: 'รถกระบะ', note: 'ลุยน้ำได้ไม่เกิน 50 ซม.', wade: 0.5, draft: 0, maxKmh: 110, banned: [] },
  { id: 'truck', name: 'รถบรรทุกยกสูง', note: 'ลุยน้ำได้ไม่เกิน 80 ซม.', wade: 0.8, draft: 0, maxKmh: 80, banned: [] },
  { id: 'boat', name: 'เรือหางยาว', note: 'ไปได้เฉพาะถนนที่น้ำท่วมลึกเกิน 40 ซม.', wade: 0, draft: 0.4, maxKmh: 14, banned: [] },
];

export const vehicleById = (id: VehicleId): Vehicle => VEHICLES.find((v) => v.id === id) ?? VEHICLES[1];
