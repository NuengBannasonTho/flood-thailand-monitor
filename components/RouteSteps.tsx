'use client';

import { memo, useState, type ReactElement } from 'react';
import { ChevronDown, Flag, MapPoint } from 'reicon-react';
import type { Step, Turn } from '@/lib/sim/directions';
import { WET } from '@/lib/sim/roads';
import { cn } from './ui/kit';

/** Arrows for each kind of turn, drawn for this list; traffic keeps left, so a U-turn swings right. */
const TURN_PATHS: Record<Turn | 'depart', string> = {
  depart: 'M10 15V4M6 8l4-4 4 4',
  straight: 'M10 17V4M6 8l4-4 4 4',
  right: 'M7 17v-6a4 4 0 0 1 4-4h6M13 3l4 4-4 4',
  left: 'M13 17v-6a4 4 0 0 0-4-4H3M7 3 3 7l4 4',
  'slight-right': 'M7 17v-5l7-7M9 5h5v5',
  'slight-left': 'M13 17v-5L6 5M11 5H6v5',
  'sharp-right': 'M6 17V6a2 2 0 0 1 3.4-1.4l6.6 7.4M16 7.5V12h-4.5',
  'sharp-left': 'M14 17V6a2 2 0 0 0-3.4-1.4L4 12M4 7.5V12h4.5',
  uturn: 'M6 17V9a4 4 0 0 1 8 0v7M10.5 12.5 14 16l3.5-3.5',
};

function StepIcon({ step }: { step: Step }): ReactElement {
  if (step.kind === 'arrive') return <Flag size={18} />;
  if (step.kind === 'stop') return <MapPoint size={18} />;
  const path = TURN_PATHS[step.kind === 'depart' ? 'depart' : (step.turn ?? 'straight')];
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
      {step.kind === 'depart' ? <circle cx={10} cy={17} r={2} fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

const COMPASS = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
const compass = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const VERB: Record<Turn, string> = {
  straight: 'ตรงไป',
  'slight-left': 'เบี่ยงซ้าย',
  'slight-right': 'เบี่ยงขวา',
  left: 'เลี้ยวซ้าย',
  right: 'เลี้ยวขวา',
  'sharp-left': 'หักซ้าย',
  'sharp-right': 'หักขวา',
  uturn: 'กลับรถ',
};

/** Thai runs words together, but a Latin name reads better after a space. */
const join = (lead: string, name: string): string => (/^[฀-๿]/.test(name) ? `${lead}${name}` : `${lead} ${name}`);

const distance = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(1)} กม.` : `${Math.max(10, Math.round(m / 10) * 10)} ม.`);

export interface StepStop {
  letter: string | null;
  name: string;
}

function instruction(step: Step, before: Step | undefined, stops: readonly StepStop[]): { text: string; sub: string | null } {
  const stop = step.stop === null ? undefined : stops[step.stop];
  switch (step.kind) {
    case 'depart': {
      const road = step.road ? ` ${join('ตาม', step.road)}` : '';
      return { text: `มุ่งหน้าทิศ${compass(step.heading)}${road}`, sub: stop && step.stop === 0 ? join('ออกจาก', stop.name) : null };
    }
    case 'turn': {
      const verb = VERB[step.turn ?? 'straight'];
      if (!step.road) return { text: step.turn === 'uturn' || step.turn === 'straight' ? verb : `${verb}เข้าถนนไม่มีชื่อ`, sub: null };
      return { text: `${verb}${before?.road === step.road ? join('ไปตาม', step.road) : join('เข้า', step.road)}`, sub: null };
    }
    case 'stop':
      return { text: `ถึงจุดแวะ ${stop?.letter ?? ''}`.trim(), sub: stop?.name ?? null };
    case 'arrive':
      return { text: 'ถึงปลายทาง', sub: stop?.name ?? null };
  }
}

interface RouteStepsProps {
  steps: readonly Step[];
  stops: readonly StepStop[];
  /** a boat: water is the way, not a hazard */
  boat: boolean;
  /** show one step on the map, or none */
  onFocus: (step: Step | null) => void;
}

/** Turn-by-turn directions for the selected route, folded away until asked for. */
export const RouteSteps = memo(function RouteSteps({ steps, stops, boat, onFocus }: RouteStepsProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  if (steps.length === 0) return null;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setActive(-1);
          onFocus(null);
        }}
        className="flex h-10 items-center justify-between rounded-tile px-3 text-[13.5px] font-medium hover:bg-soft"
      >
        <span>
          ขั้นตอนการเดินทาง <span className="font-normal text-muted">· {steps.length} ขั้น</span>
        </span>
        <ChevronDown size={16} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <ol className="mt-1 flex flex-col">
          {steps.map((step, i) => {
            const { text, sub } = instruction(step, steps[i - 1], stops);
            const wet = step.maxDepth > WET && step.length > 0;
            return (
              <li key={i}>
                <button
                  type="button"
                  aria-current={active === i ? 'step' : undefined}
                  onClick={() => {
                    setActive(i);
                    onFocus(step);
                  }}
                  className={cn('flex w-full items-start gap-3 rounded-tile px-3 py-2.5 text-left transition-colors', active === i ? 'bg-ink text-white' : 'hover:bg-soft')}
                >
                  <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full', active === i ? 'bg-white text-ink' : 'bg-soft text-ink')}>
                    <StepIcon step={step} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] leading-snug font-medium">{text}</span>
                    {sub ? <span className={cn('block truncate text-xs', active === i ? 'text-white/70' : 'text-muted')}>{sub}</span> : null}
                    {step.length > 0 ? (
                      <span className={cn('mt-0.5 flex items-center gap-1.5 text-xs tabular-nums', active === i ? 'text-white/70' : 'text-muted')}>
                        {distance(step.length)}
                        {wet ? (
                          <>
                            <span className={cn('size-1.5 rounded-full', boat ? 'bg-water' : 'bg-warn')} />
                            น้ำลึกถึง {Math.round(step.maxDepth * 100)} ซม.
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
});
