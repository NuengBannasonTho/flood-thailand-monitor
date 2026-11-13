'use client';

import { memo, type ReactElement } from 'react';
import { Trash } from 'reicon-react';
import { vehicleById } from '@/lib/sim/vehicles';
import type { SavedTrip } from '@/lib/trips';
import { Card, cn, IconBtn } from './ui/kit';

const day = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' });

interface SavedTripsProps {
  trips: readonly SavedTrip[];
  onLoad: (trip: SavedTrip) => void;
  onRemove: (id: string) => void;
  className?: string;
}

/** Trips saved in this browser. Choosing one puts its stops and vehicle back. */
export const SavedTrips = memo(function SavedTrips({ trips, onLoad, onRemove, className }: SavedTripsProps): ReactElement | null {
  if (trips.length === 0) return null;
  return (
    <Card className={cn('flex flex-col gap-2 p-5', className)}>
      <h2 className="text-[15px] font-semibold">การเดินทางที่บันทึกไว้</h2>
      <ul className="flex flex-col gap-1.5">
        {trips.map((trip) => {
          const first = trip.stops[0].point.name;
          const last = trip.stops[trip.stops.length - 1].point.name;
          const middle = trip.stops.slice(1, -1);
          const stopsAt = middle.filter((s) => !s.via).length;
          const passes = middle.length - stopsAt;
          return (
            <li key={trip.id} className="flex items-center gap-1 rounded-tile bg-soft pr-1.5">
              <button type="button" onClick={() => onLoad(trip)} className="min-w-0 flex-1 rounded-tile px-3.5 py-2.5 text-left hover:bg-line">
                <span className="block truncate text-[13.5px] font-medium">
                  {first} → {last}
                </span>
                <span className="block truncate text-xs text-muted">
                  {vehicleById(trip.vehicle).name}
                  {stopsAt > 0 ? ` · แวะ ${stopsAt} จุด` : ''}
                  {passes > 0 ? ` · ผ่าน ${passes} จุด` : ''} · บันทึก {day.format(trip.savedAt)}
                </span>
              </button>
              <IconBtn size="sm" tone="ghost" label={`ลบการเดินทาง ${first} ไป ${last}`} icon={Trash} onClick={() => onRemove(trip.id)} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
});
