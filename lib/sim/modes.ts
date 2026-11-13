import type { FloodMode } from './flood';

export interface ModeSpec {
  id: FloodMode;
  /** the Thai Meteorological Department's name for this kind of flood */
  label: string;
  hint: string;
  /** what the slider sets */
  measure: string;
  unit: string;
  decimals: number;
  max: number;
  step: number;
  initial: number;
  presets: readonly number[];
  /** where the "watch it rise" run stops */
  riseTo: number;
  /** slider units per second during that run */
  riseRate: number;
}

export const MODES: Record<FloodMode, ModeSpec> = {
  river: {
    id: 'river',
    label: 'น้ำล้นตลิ่ง',
    hint: 'แม่น้ำหรือคลองรับน้ำไม่ไหว เอ่อล้นเข้าท่วมสองฝั่ง',
    measure: 'สูงจากระดับน้ำปกติของพื้นที่',
    unit: 'ม.',
    decimals: 1,
    max: 12,
    step: 0.1,
    initial: 2,
    presets: [0, 1, 2, 4],
    riseTo: 6,
    riseRate: 0.55,
  },
  sea: {
    id: 'sea',
    label: 'น้ำทะเลหนุน',
    hint: 'น้ำทะเลขึ้นสูงหรือถูกพายุดันเข้าฝั่ง ท่วมจากชายฝั่งเข้ามา',
    measure: 'สูงจากระดับทะเลปานกลาง',
    unit: 'ม.',
    decimals: 1,
    max: 6,
    step: 0.1,
    initial: 1.5,
    presets: [0, 1, 2, 3],
    riseTo: 4,
    riseRate: 0.4,
  },
  rain: {
    id: 'rain',
    label: 'ฝนตกหนักในพื้นที่',
    hint: 'ฝนตกแล้วระบายไม่ทัน น้ำขังตามที่ลุ่มและแอ่ง',
    measure: 'ปริมาณฝนสะสม 24 ชั่วโมง',
    unit: 'มม.',
    decimals: 0,
    max: 400,
    step: 5,
    initial: 120,
    presets: [35, 90, 150, 250],
    riseTo: 300,
    riseRate: 28,
  },
};

export const MODE_ORDER: readonly FloodMode[] = ['river', 'rain', 'sea'];

/** Thai Meteorological Department classes for rain over 24 hours (07:00 to 07:00), in millimetres. */
export function rainClass(mm: number): string {
  if (mm < 0.1) return 'ไม่มีฝน';
  if (mm <= 10) return 'ฝนเล็กน้อย';
  if (mm <= 35) return 'ฝนปานกลาง';
  if (mm <= 90) return 'ฝนหนัก';
  return 'ฝนหนักมาก';
}
