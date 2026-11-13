'use client';

import { memo, type ReactElement } from 'react';
import { ExitFullscreen, Fullscreen, Globe, ThreeDCube } from 'reicon-react';
import { cn, IconBtn } from './ui/kit';

interface MapToolsProps {
  /** 3D relief on or off; off is lighter on slow machines */
  terrain: boolean;
  onTerrain: (on: boolean) => void;
  /** the panels are hidden and the map has the whole screen */
  full: boolean;
  onFull: (on: boolean) => void;
  onShowThailand: () => void;
  className?: string;
}

/** Controls for the map view itself, kept apart from the simulation settings. */
export const MapTools = memo(function MapTools({ terrain, onTerrain, full, onFull, onShowThailand, className }: MapToolsProps): ReactElement {
  return (
    <div className={cn('flex flex-col gap-1 rounded-full bg-surface p-1 shadow-chip', className)}>
      <IconBtn label={full ? 'แสดงแผงควบคุม (Esc)' : 'ซ่อนแผงควบคุม ดูแผนที่เต็มจอ'} icon={full ? ExitFullscreen : Fullscreen} tone="ghost" active={full} onClick={() => onFull(!full)} />
      <IconBtn label={terrain ? 'ปิดภูมิประเทศ 3 มิติ (เร็วขึ้น)' : 'เปิดภูมิประเทศ 3 มิติ'} icon={ThreeDCube} tone="ghost" active={terrain} aria-pressed={terrain} onClick={() => onTerrain(!terrain)} />
      <IconBtn label="ดูทั้งประเทศ" icon={Globe} tone="ghost" onClick={onShowThailand} />
    </div>
  );
});
