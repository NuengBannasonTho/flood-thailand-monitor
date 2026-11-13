'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore, type PointerEvent, type ReactElement } from 'react';
import { ChevronDown, ChevronUp, Pause, Play, Restart } from 'reicon-react';
import type { MapController, SeqSnapshot } from '@/lib/map/controller';
import { evalTrack, type SeqTrack } from '@/lib/map/sequence';
import { Btn, Card, cn, IconBtn, Tip } from './ui/kit';

interface Layout {
  x0: number;
  span: number;
}

const COLORS = { stripe: '#f4f4f8', grid: '#e9e9f0', text: '#8a8c9c', ink: '#1b1c27', curve: '#b9bbc9', wet: 'rgb(47 127 224 / 0.28)' } as const;
const FONT = 'Sarabun, sans-serif';

function draw(canvas: HTMLCanvasElement, snap: SeqSnapshot, tracks: readonly SeqTrack[] | null, wet: readonly boolean[]): Layout | null {
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!ctx || !w || !h) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  if (!tracks) return null;

  const compact = h < 70;
  const x0 = compact ? 6 : 92;
  const span = w - x0 - 8;
  const X = (u: number): number => x0 + u * span;
  const ruler = compact ? 14 : 18;
  const rows = compact ? 1 : tracks.length;
  const rowH = (h - ruler - 2) / rows;

  ctx.font = `10.5px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  const step = snap.duration > 18 ? 4 : 2;
  for (let s = 0; s <= snap.duration + 1e-6; s += step) ctx.fillText(`${s} วิ`, X(s / snap.duration) + 4, 7);

  for (let r = 0; r < rows; r++) {
    const track = tracks[r];
    const y0 = ruler + r * rowH;
    const yb = y0 + rowH - 7;
    const yt = y0 + 7;
    const Y = (v: number): number => yb - ((v - track.lo) / (track.hi - track.lo)) * (yb - yt);
    ctx.fillStyle = COLORS.stripe;
    ctx.beginPath();
    ctx.roundRect(x0, y0 + 2, span, rowH - 4, 9);
    ctx.fill();
    if (!compact) {
      ctx.fillStyle = COLORS.ink;
      ctx.font = `12px ${FONT}`;
      ctx.fillText(track.name, 2, y0 + rowH / 2);
    }
    if (r === 0 && wet.length > 1) {
      ctx.fillStyle = COLORS.wet;
      const cell = span / (wet.length - 1);
      wet.forEach((isWet, i) => {
        if (isWet) ctx.fillRect(x0 + i * cell - cell / 2, y0 + 2, cell + 0.5, rowH - 4);
      });
    }
    ctx.strokeStyle = r === 0 ? COLORS.ink : COLORS.curve;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    for (let i = 0; i <= span; i += 3) {
      const y = Y(evalTrack(track.kf, i / span));
      if (i === 0) ctx.moveTo(x0, y);
      else ctx.lineTo(x0 + i, y);
    }
    ctx.stroke();
    ctx.fillStyle = r === 0 ? COLORS.ink : COLORS.curve;
    for (const [u, v] of track.kf) {
      ctx.beginPath();
      ctx.arc(X(u), Y(v), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let s = step; s < snap.duration; s += step) {
    const x = Math.round(X(s / snap.duration)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, ruler);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  const px = X(snap.u);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px, ruler - 2);
  ctx.lineTo(px, h - 2);
  ctx.stroke();
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath();
  ctx.arc(px, ruler - 4, 5, 0, Math.PI * 2);
  ctx.fill();
  return { x0, span };
}

/** Playback controls and the keyframed camera tracks of the trip. Drag across it to scrub. */
function Timeline({ controller, onCollapse }: { controller: MapController; onCollapse: () => void }): ReactElement {
  const snap = useSyncExternalStore(controller.seq.subscribe, controller.seq.get, controller.seq.get);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const scrubbing = useRef(false);

  const redraw = useCallback((): void => {
    const canvas = canvasRef.current;
    if (canvas) layoutRef.current = draw(canvas, controller.seq.get(), controller.tracks, controller.wetSpans);
  }, [controller]);

  useEffect(redraw, [redraw, snap]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    void document.fonts.ready.then(redraw);
    return () => observer.disconnect();
  }, [redraw]);

  const scrub = (e: PointerEvent<HTMLCanvasElement>): void => {
    const layout = layoutRef.current;
    if (layout) controller.seek((e.clientX - e.currentTarget.getBoundingClientRect().left - layout.x0) / layout.span);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <IconBtn label={snap.playing ? 'หยุดชั่วคราว' : 'เล่น'} icon={snap.playing ? Pause : Play} active onClick={() => controller.toggle()} />
        <IconBtn label="กลับไปต้นทาง" icon={Restart} onClick={() => controller.seek(0)} />
        <Btn className="h-10 px-3.5 tabular-nums" onClick={() => controller.cycleRate()} aria-label="ความเร็วการเล่น">
          {snap.rate}×
        </Btn>
        <span className="ml-1 hidden text-[13.5px] font-semibold sm:inline">ลำดับภาพการเดินทาง</span>
        <span className="ml-auto text-xs text-muted tabular-nums">
          {(snap.u * snap.duration).toFixed(1)} / {snap.duration.toFixed(1)} วิ
        </span>
        <IconBtn label="ซ่อนไทม์ไลน์" icon={ChevronDown} tone="ghost" onClick={onCollapse} />
      </div>
      <canvas
        ref={canvasRef}
        aria-label="ไทม์ไลน์การเดินทาง ลากเพื่อเลื่อนเวลา"
        className="block h-11 w-full cursor-ew-resize touch-none lg:h-[116px]"
        onPointerDown={(e) => {
          scrubbing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) scrub(e);
        }}
        onPointerUp={() => {
          scrubbing.current = false;
        }}
        onPointerCancel={() => {
          scrubbing.current = false;
        }}
      />
    </div>
  );
}

const RING = 2 * Math.PI * 25;

/** The trip reduced to one button: play or pause, with the progress drawn as a ring around it. */
function PlayRing({ controller }: { controller: MapController }): ReactElement {
  const snap = useSyncExternalStore(controller.seq.subscribe, controller.seq.get, controller.seq.get);
  const label = snap.playing ? 'หยุดชั่วคราว' : snap.u > 0 && snap.u < 1 ? 'เดินทางต่อ' : 'เล่นการเดินทาง';
  return (
    <Tip label={label}>
      <button type="button" aria-label={label} onClick={() => controller.toggle()} className="relative grid size-14 shrink-0 place-items-center rounded-full bg-ink text-white transition-colors hover:bg-ink-soft">
        <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle cx="28" cy="28" r="25" fill="none" stroke="rgb(255 255 255 / 0.18)" strokeWidth="3" />
          <circle cx="28" cy="28" r="25" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - snap.u)} />
        </svg>
        {snap.playing ? <Pause size={20} weight="Filled" /> : <Play size={20} weight="Filled" />}
      </button>
    </Tip>
  );
}

interface TripDockProps {
  controller: MapController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}

/**
 * Trip controls. Closed, it is a single round button so the map stays the subject; open, it shows
 * the full timeline with its camera tracks.
 */
export function TripDock({ controller, open, onOpenChange, className }: TripDockProps): ReactElement {
  if (open) {
    return (
      <Card className={cn('p-4', className)}>
        <Timeline controller={controller} onCollapse={() => onOpenChange(false)} />
      </Card>
    );
  }
  return (
    <div className={cn('pointer-events-none flex justify-center', className)}>
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-surface p-1.5 shadow-float">
        <PlayRing controller={controller} />
        <IconBtn label="แสดงไทม์ไลน์" icon={ChevronUp} tone="ghost" className="mr-1" onClick={() => onOpenChange(true)} />
      </div>
    </div>
  );
}
