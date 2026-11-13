'use client';

import { motion } from 'motion/react';
import { memo, useEffect, useRef, type ReactElement } from 'react';
import { Car, Car3, type IconComponent, Scooter, Ship, Truck } from 'reicon-react';
import { VEHICLES, type Vehicle, type VehicleId, vehicleById } from '@/lib/sim/vehicles';
import { VehicleView } from '@/lib/three/vehicle-view';
import { Card, cn, Tip } from './ui/kit';

export const VEHICLE_ICON: Record<VehicleId, IconComponent> = { motorbike: Scooter, car: Car, pickup: Car3, truck: Truck, boat: Ship };

function wadeLabel(v: Vehicle): string {
  return v.draft > 0 ? `ต้องการน้ำลึก ${Math.round(v.draft * 100)} ซม. ขึ้นไป` : `ลุยน้ำได้ลึก ${Math.round(v.wade * 100)} ซม.`;
}

interface VehicleCardProps {
  value: VehicleId;
  /** per vehicle: can it complete the trip right now; null when there is no trip to judge */
  reach: Partial<Record<VehicleId, boolean>> | null;
  onChange: (id: VehicleId) => void;
  className?: string;
}

/**
 * The chosen vehicle as a turning 3D model, with the picker right under it so a choice and its
 * result sit together. A dot on each vehicle shows whether it gets through.
 */
export const VehicleCard = memo(function VehicleCard({ value, reach, onChange, className }: VehicleCardProps): ReactElement {
  const vehicle = vehicleById(value);
  const reachable = reach ? reach[value] : undefined;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<VehicleView | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let view: VehicleView;
    try {
      view = new VehicleView(canvas, 220);
    } catch {
      return undefined; // no WebGL: the card still names the vehicle
    }
    viewRef.current = view;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const tick = (now: number): void => {
      view.setPose({ yaw: still ? 0.7 : now / 2600, elevation: 0.42 });
      view.render(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      viewRef.current = null;
      view.dispose();
    };
  }, []);

  useEffect(() => {
    viewRef.current?.setVehicle(vehicle.id);
    viewRef.current?.setMotion({ speed: 0.5, wading: false });
  }, [vehicle.id]);

  return (
    <Card dark className={cn('p-4', className)}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] text-white/55">เดินทางด้วย</p>
          <h2 className="text-[17px] leading-tight font-semibold">{vehicle.name}</h2>
          <div className="mt-3 flex flex-wrap gap-1.5 text-[11.5px]">
            <span className="rounded-full bg-white/10 px-2.5 py-1">{wadeLabel(vehicle)}</span>
            {reachable !== undefined ? (
              <span className={cn('flex items-center gap-1.5 rounded-full px-2.5 py-1', reachable ? 'bg-ok/20 text-[#7fe3b8]' : 'bg-danger/20 text-[#ff9c9a]')}>
                <span className={cn('size-1.5 rounded-full', reachable ? 'bg-ok' : 'bg-danger')} />
                {reachable ? 'ไปถึงได้' : 'ไปไม่ถึง'}
              </span>
            ) : null}
          </div>
        </div>
        <canvas ref={canvasRef} width={220} height={220} className="-my-3 -mr-2 hidden size-[132px] shrink-0 lg:block" aria-hidden="true" />
      </div>

      <div role="radiogroup" aria-label="เดินทางด้วย" className="mt-3 flex justify-between gap-1 rounded-tile bg-white/[0.06] p-1.5">
        {VEHICLES.map((v) => {
          const Icon = VEHICLE_ICON[v.id];
          const active = v.id === value;
          const ok = reach ? reach[v.id] : undefined;
          return (
            <Tip key={v.id} label={`${v.name} · ${v.note}`}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={v.name}
                onClick={() => onChange(v.id)}
                className={cn('group relative grid h-12 flex-1 place-items-center rounded-control outline-offset-2 transition-colors focus-visible:outline-white', !active && 'hover:bg-white/10')}
              >
                {active ? <motion.span layoutId="vehicle-active" className="absolute inset-0 rounded-control bg-white" transition={{ type: 'spring', stiffness: 420, damping: 32 }} /> : null}
                <Icon size={22} weight={active ? 'Filled' : 'Outline'} className={cn('relative transition-colors', active ? 'text-ink' : 'text-white/70 group-hover:text-white')} />
                {ok !== undefined ? <span className={cn('absolute top-1.5 right-1.5 size-2 rounded-full ring-2', active ? 'ring-white' : 'ring-ink', ok ? 'bg-ok' : 'bg-danger')} /> : null}
              </button>
            </Tip>
          );
        })}
      </div>
    </Card>
  );
});
