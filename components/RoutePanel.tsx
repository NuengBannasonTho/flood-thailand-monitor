'use client';

import { Button as ButtonPrimitive } from '@animate-ui/react/primitives/buttons/button';
import { AutoHeight } from '@animate-ui/react/primitives/effects/auto-height';
import { memo, type ReactElement } from 'react';
import { ArrowSwapHorizontal, Bookmark, BookmarkCheck, Play } from 'reicon-react';
import type { Bounds } from '@/lib/config';
import type { Endpoint } from '@/lib/map/controller';
import type { Step } from '@/lib/sim/directions';
import { type Route, WET } from '@/lib/sim/roads';
import { VEHICLES, type Vehicle, type VehicleId } from '@/lib/sim/vehicles';
import type { Stop } from '@/lib/stops';
import { RouteSteps, type StepStop } from './RouteSteps';
import { StopList } from './StopList';
import { Card, cn, IconBtn, PrimaryBtn } from './ui/kit';

const km = (m: number): string => (m >= 10_000 ? `${(m / 1000).toFixed(1)} กม.` : `${(m / 1000).toFixed(2)} กม.`);
const minutes = (s: number): string => `${Math.max(1, Math.round(s / 60))} นาที`;

interface RouteRowProps {
  route: Route;
  index: number;
  selected: boolean;
  dryLength: number | null;
  boat: boolean;
  onSelect: () => void;
}

function RouteRow({ route, index, selected, dryLength, boat, onSelect }: RouteRowProps): ReactElement {
  const extra = dryLength === null ? 0 : route.length - dryLength;
  const wet = route.maxDepth > WET;
  const water = boat ? 'ล่องตามถนนที่น้ำท่วม' : wet ? `ลุยน้ำ ${Math.round(route.wetLength / 10) * 10} ม. ลึกสุด ${Math.round(route.maxDepth * 100)} ซม.` : 'แห้งตลอดทาง';
  return (
    <ButtonPrimitive
      hoverScale={1.01}
      tapScale={0.985}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn('flex w-full items-start gap-3 rounded-tile p-3.5 text-left transition-colors', selected ? 'bg-ink text-white' : 'bg-soft hover:bg-line')}
    >
      <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums', selected ? 'bg-white text-ink' : 'bg-surface text-muted')}>{index + 1}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-[14.5px] font-semibold tabular-nums">{minutes(route.time)}</span>
          <span className={cn('text-[12.5px] whitespace-nowrap tabular-nums', selected ? 'text-white/70' : 'text-muted')}>
            {km(route.length)}
            {extra > 50 ? ` · อ้อม +${km(extra)}` : ''}
          </span>
        </span>
        <span className={cn('mt-0.5 flex items-center gap-1.5 text-xs', selected ? 'text-white/80' : 'text-ink')}>
          <span className={cn('size-1.5 shrink-0 rounded-full', boat ? 'bg-water' : wet ? 'bg-warn' : 'bg-ok')} />
          {water}
        </span>
        {route.roads.length > 0 ? <span className={cn('mt-0.5 block truncate text-xs', selected ? 'text-white/55' : 'text-muted')}>ผ่าน {route.roads.join(' · ')}</span> : null}
      </span>
    </ButtonPrimitive>
  );
}

interface RoutePanelProps {
  ready: boolean;
  /** the map is up, so stops can be searched for even before an area is simulated */
  searchable: boolean;
  stops: readonly Stop[];
  /** id of the stop being pinned on the map */
  picking: string | null;
  /** the simulated area, null before there is one; search lists places in it first */
  near: Bounds | null;
  /** a stop lies outside the analysed area */
  outside: boolean;
  routes: readonly Route[];
  selected: number;
  dryLength: number | null;
  vehicle: Vehicle;
  reach: Partial<Record<VehicleId, boolean>> | null;
  /** the first stretch between two stops this vehicle cannot do, by the stops' names */
  blocked: { from: string; to: string } | null;
  steps: readonly Step[];
  /** the stops the steps refer to */
  stepStops: readonly StepStop[];
  /** the current trip is among the saved ones */
  saved: boolean;
  canSave: boolean;
  onPick: (id: string | null) => void;
  onRemove: (id: string) => void;
  onSet: (id: string, point: Endpoint) => void;
  onReorder: (next: Stop[]) => void;
  onAdd: () => void;
  onSwap: () => void;
  onToggleSave: () => void;
  onSelect: (index: number) => void;
  onVehicle: (id: VehicleId) => void;
  onStep: (step: Step | null) => void;
  onGo: () => void;
}

export const RoutePanel = memo(function RoutePanel(props: RoutePanelProps): ReactElement {
  const { ready, searchable, stops, picking, near, outside, routes, selected, dryLength, vehicle, reach, blocked, steps, stepStops, saved, canSave } = props;
  const both = stops[0]?.point != null && stops[stops.length - 1]?.point != null;
  const others = reach ? VEHICLES.filter((v) => v.id !== vehicle.id && reach[v.id]) : [];
  const several = stops.filter((s) => s.point).length > 2;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">เส้นทาง</h2>
        <div className="flex items-center gap-1">
          <IconBtn size="sm" tone="ghost" label="กลับทิศ สลับต้นทางกับปลายทาง" icon={ArrowSwapHorizontal} className="[&_svg]:rotate-90" disabled={!stops.some((s) => s.point)} onClick={props.onSwap} />
          <IconBtn
            size="sm"
            tone="ghost"
            active={saved}
            aria-pressed={saved}
            label="บันทึกการเดินทางนี้"
            icon={saved ? BookmarkCheck : Bookmark}
            disabled={!canSave && !saved}
            onClick={props.onToggleSave}
          />
        </div>
      </div>

      <StopList stops={stops} picking={picking} ready={ready} searchable={searchable} near={near} onPick={props.onPick} onRemove={props.onRemove} onSet={props.onSet} onReorder={props.onReorder} onAdd={props.onAdd} />

      <AutoHeight deps={[routes.length, both, outside, ready, others.length, blocked?.from]}>
        <div className="flex flex-col gap-2" aria-live="polite">
          {!ready ? <p className="text-[13px] text-muted">พิมพ์ชื่อจุดเริ่มต้นและปลายทางได้เลย ระบบจะจำลองน้ำท่วมรอบ ๆ ให้ หรือค้นหาเมืองด้านบนแล้วปักจุดบนแผนที่</p> : null}
          {ready && !both ? <p className="text-[13px] text-muted">พิมพ์ชื่อสถานที่ หรือปักจุดเริ่มต้นและปลายทางบนแผนที่ ระบบจะหาเส้นทางที่ {vehicle.name} ยังไปได้ที่ระดับน้ำนี้</p> : null}
          {ready && both && outside ? <p className="rounded-tile bg-warn/12 p-3.5 text-[13px]">มีจุดอยู่นอกกรอบพื้นที่ที่จำลอง ปักใหม่ภายในกรอบเส้นประ หรือเลื่อนแผนที่แล้วจำลองพื้นที่ใหม่</p> : null}
          {routes.map((r, i) => (
            <RouteRow key={i} route={r} index={i} selected={i === selected} dryLength={dryLength} boat={vehicle.draft > 0} onSelect={() => props.onSelect(i)} />
          ))}
          {ready && both && !outside && routes.length === 0 ? (
            <div className="rounded-tile bg-danger/10 p-3.5 text-[13px]">
              <p className="font-semibold text-danger">{vehicle.name}ไปไม่ถึง</p>
              <p className="mt-0.5 text-ink">
                {blocked && several ? `ช่วง ${blocked.from} → ${blocked.to} ` : ''}
                {vehicle.draft > 0 ? 'น้ำยังไม่ลึกพอให้เรือไปได้ตลอดทาง' : 'ทุกเส้นทางมีช่วงที่น้ำลึกเกินกว่าจะลุยได้'}
              </p>
              {others.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted">ที่ยังไปได้:</span>
                  {others.map((v) => (
                    <button key={v.id} type="button" onClick={() => props.onVehicle(v.id)} className="rounded-full bg-surface px-3 py-1 text-xs font-medium ring-1 ring-line hover:bg-soft">
                      {v.name}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted">ไม่มีพาหนะใดไปถึงได้ที่ระดับน้ำนี้</p>
              )}
            </div>
          ) : null}
          {routes.length > 0 ? <p className="hidden px-1 text-xs text-muted lg:block">ลากเส้นทางบนแผนที่เพื่อให้ผ่านถนนที่ต้องการ หรือลากหมุดเพื่อย้ายจุด</p> : null}
        </div>
      </AutoHeight>

      <RouteSteps key={selected} steps={steps} stops={stepStops} boat={vehicle.draft > 0} onFocus={props.onStep} />

      <PrimaryBtn disabled={routes.length === 0} onClick={props.onGo}>
        <Play size={18} weight="Filled" />
        ออกเดินทาง
      </PrimaryBtn>
    </Card>
  );
});
