'use client';

import type { ReactElement } from 'react';
import { CloudRain, CloudStorm, type IconComponent, Pause, Play, Water, Wind } from 'reicon-react';
import type { FloodMode } from '@/lib/sim/flood';
import { MODE_ORDER, MODES, rainClass } from '@/lib/sim/modes';
import { Btn, Card, cn, LevelSlider, SlidingNumber, Stat, Tip } from './ui/kit';

const MODE_ICON: Record<FloodMode, IconComponent> = { river: Water, rain: CloudRain, sea: Wind };

const TONE = { calm: 'bg-ok/12 text-ok', watch: 'bg-warn/15 text-[#b87400]', flood: 'bg-water-soft text-water', severe: 'bg-danger/12 text-danger' } as const;

function statusOf(mode: FloodMode, value: number): { label: string; tone: string } {
  if (mode === 'rain') {
    // Rain is named by the Thai Meteorological Department's 24-hour classes.
    return { label: rainClass(value), tone: value <= 10 ? TONE.calm : value <= 35 ? TONE.watch : value <= 90 ? TONE.flood : TONE.severe };
  }
  const share = value / MODES[mode].max;
  if (share < 0.04) return { label: 'ปกติ', tone: TONE.calm };
  if (share < 0.13) return { label: 'เฝ้าระวัง', tone: TONE.watch };
  if (share < 0.34) return { label: 'น้ำท่วม', tone: TONE.flood };
  return { label: 'วิกฤต', tone: TONE.severe };
}

interface LevelCardProps {
  ready: boolean;
  mode: FloodMode;
  /** per cause: false when it cannot happen in this area */
  available: Record<FloodMode, boolean>;
  value: number;
  /** water surface in metres above mean sea level, when the cause has one */
  surface: number | null;
  areaKm2: number;
  shutKm: number;
  wadeKm: number;
  rising: boolean;
  onMode: (mode: FloodMode) => void;
  onValue: (value: number) => void;
  onToggleRise: () => void;
}

export function LevelCard({ ready, mode, available, value, surface, areaKm2, shutKm, wadeKm, rising, onMode, onValue, onToggleRise }: LevelCardProps): ReactElement {
  const spec = MODES[mode];
  const status = statusOf(mode, value);
  const detail = !ready ? 'เลือกพื้นที่บนแผนที่ก่อน แล้วจึงปรับได้' : surface !== null ? `${spec.measure} · ผิวน้ำ ${surface.toFixed(1)} ม.รทก.` : spec.measure;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">น้ำท่วมจากอะไร</h2>
        {ready ? <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium', status.tone)}>{status.label}</span> : null}
      </div>

      <div>
        <div role="radiogroup" aria-label="สาเหตุน้ำท่วม" className="grid grid-cols-2 gap-1.5">
          {MODE_ORDER.map((id) => {
            const Icon = MODE_ICON[id];
            const active = id === mode;
            const usable = available[id];
            const button = (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!usable}
                onClick={() => onMode(id)}
                className={cn('flex h-11 items-center gap-2 rounded-control px-3 text-left text-[13px] font-medium transition-colors disabled:opacity-40', active ? 'bg-ink text-white' : 'bg-soft hover:bg-line')}
              >
                <Icon size={17} weight={active ? 'Filled' : 'Outline'} className="shrink-0" />
                <span className="truncate">{MODES[id].label}</span>
              </button>
            );
            return usable ? (
              button
            ) : (
              <Tip key={id} label="พื้นที่ที่จำลองอยู่ไม่ติดทะเล">
                <span>{button}</span>
              </Tip>
            );
          })}
          <Tip label="น้ำป่าไหลหลากและน้ำท่วมฉับพลันต้องใช้แบบจำลองการไหลของน้ำ แอปนี้ยังจำลองไม่ได้">
            <span className="flex h-11 items-center gap-2 rounded-control bg-soft px-3 text-[13px] font-medium text-muted opacity-60">
              <CloudStorm size={17} className="shrink-0" />
              <span className="truncate">น้ำป่าไหลหลาก</span>
            </span>
          </Tip>
        </div>
        <p className="mt-2 text-[12.5px] text-muted">{spec.hint}</p>
      </div>

      <div>
        <div className="flex items-baseline gap-1.5">
          <span className="flex items-baseline text-[44px] leading-none font-semibold tracking-tight tabular-nums">
            {mode === 'rain' ? null : '+'}
            <SlidingNumber number={value} decimalPlaces={spec.decimals} initiallyStable />
          </span>
          <span className="text-[15px] font-medium">{spec.unit}</span>
        </div>
        <p className="mt-1.5 text-[12.5px] text-muted">{detail}</p>
      </div>

      <div>
        <LevelSlider value={value} min={0} max={spec.max} step={spec.step} disabled={!ready} label={`${spec.measure} (${spec.unit})`} onChange={onValue} />
        <div className="flex justify-between text-[11px] text-muted tabular-nums">
          <span>0</span>
          <span>
            {spec.max / 2} {spec.unit}
          </span>
          <span>
            {spec.max} {spec.unit}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {spec.presets.map((preset) => (
          <Btn key={preset} className="h-8 px-3 tabular-nums" disabled={!ready} active={ready && !rising && value === preset} onClick={() => onValue(preset)}>
            {mode === 'rain' ? preset : `+${preset}`}
          </Btn>
        ))}
        <Btn className="ml-auto h-8 px-3" tone="outline" disabled={!ready} icon={rising ? Pause : Play} active={rising} onClick={onToggleRise}>
          {rising ? 'หยุด' : mode === 'rain' ? 'ฝนตกต่อ' : 'น้ำขึ้น'}
        </Btn>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat swatch="bg-water" value={areaKm2} decimals={1} unit="ตร.กม." label="ใต้น้ำ" />
        <Stat swatch="bg-warn" value={wadeKm} decimals={1} unit="กม." label="ลุยได้" />
        <Stat swatch="bg-danger" value={shutKm} decimals={1} unit="กม." label="ผ่านไม่ได้" />
      </div>
    </Card>
  );
}
