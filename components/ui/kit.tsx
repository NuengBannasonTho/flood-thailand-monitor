'use client';

import { Button as ButtonPrimitive } from '@animate-ui/react/primitives/buttons/button';
import { RippleButton, RippleButtonRipples } from '@animate-ui/react/primitives/buttons/ripple';
import * as Slider from '@animate-ui/react/primitives/radix-ui/slider';
import * as Tooltip from '@animate-ui/react/primitives/radix-ui/tooltip';
import { SlidingNumber } from '@animate-ui/react/primitives/texts/sliding-number';
import type { HTMLMotionProps } from 'motion/react';
import type { ReactElement, ReactNode } from 'react';
import type { IconComponent } from 'reicon-react';

export function cn(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Native button props as the animated primitives accept them, with plain React children. */
type NativeButtonProps = Omit<HTMLMotionProps<'button'>, 'children'>;

/* ---------- surfaces ---------- */

export function Card({ dark = false, className, children }: { dark?: boolean; className?: string; children: ReactNode }): ReactElement {
  return <div className={cn('rounded-card shadow-float', dark ? 'bg-ink text-white' : 'bg-surface text-ink', className)}>{children}</div>;
}

/* ---------- buttons ---------- */

type Tone = 'soft' | 'ghost' | 'dark' | 'outline';

const TONE: Record<Tone, string> = {
  soft: 'bg-soft text-ink hover:bg-line',
  ghost: 'bg-transparent text-ink hover:bg-soft',
  dark: 'bg-ink text-white hover:bg-ink-soft',
  outline: 'bg-surface text-ink ring-1 ring-line hover:bg-soft',
};

interface BtnProps extends NativeButtonProps {
  tone?: Tone;
  active?: boolean;
  icon?: IconComponent;
  children?: ReactNode;
}

export function Btn({ tone = 'soft', active = false, icon: Icon, className, children, ...props }: BtnProps): ReactElement {
  return (
    <ButtonPrimitive
      hoverScale={1.03}
      tapScale={0.96}
      className={cn('inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:opacity-40', active ? TONE.dark : TONE[tone], className)}
      {...props}
    >
      {Icon ? <Icon size={16} weight={active ? 'Filled' : 'Outline'} /> : null}
      {children}
    </ButtonPrimitive>
  );
}

interface IconBtnProps extends NativeButtonProps {
  label: string;
  icon: IconComponent;
  tone?: Tone;
  active?: boolean;
  size?: 'sm' | 'md';
}

/** Round icon button; the label doubles as tooltip and accessible name. */
export function IconBtn({ label, icon: Icon, tone = 'soft', active = false, size = 'md', className, ...props }: IconBtnProps): ReactElement {
  return (
    <Tip label={label}>
      <ButtonPrimitive
        aria-label={label}
        hoverScale={1.06}
        tapScale={0.92}
        className={cn('grid shrink-0 place-items-center rounded-full transition-colors disabled:opacity-40', size === 'sm' ? 'size-8' : 'size-10', active ? TONE.dark : TONE[tone], className)}
        {...props}
      >
        <Icon size={size === 'sm' ? 16 : 18} weight={active ? 'Filled' : 'Outline'} />
      </ButtonPrimitive>
    </Tip>
  );
}

export function PrimaryBtn({ className, children, ...props }: NativeButtonProps & { children: ReactNode }): ReactElement {
  return (
    <RippleButton
      hoverScale={1.015}
      tapScale={0.97}
      className={cn('relative inline-flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-full bg-ink px-5 text-[15px] font-medium text-white transition-colors hover:bg-ink-soft disabled:bg-line disabled:text-muted', className)}
      {...props}
    >
      {children}
      <RippleButtonRipples color="rgb(255 255 255 / 0.35)" />
    </RippleButton>
  );
}

/* ---------- tooltip ---------- */

export const TipProvider = Tooltip.Provider;

export function Tip({ label, side = 'top', children }: { label: string; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactElement }): ReactElement {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={10} className="z-50 max-w-60 rounded-control bg-ink px-3 py-1.5 text-xs text-white shadow-chip">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/* ---------- slider ---------- */

interface LevelSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function LevelSlider({ value, min, max, step, label, disabled = false, onChange }: LevelSliderProps): ReactElement {
  return (
    <Slider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next) => {
        const first = next[0];
        if (first !== undefined) onChange(first);
      }}
      className="relative flex h-8 w-full touch-none items-center select-none data-disabled:opacity-40"
    >
      <Slider.Track className="relative h-3 grow overflow-hidden rounded-full bg-soft">
        <Slider.Range className="absolute h-full rounded-full bg-water" />
      </Slider.Track>
      <Slider.Thumb aria-label={label} className="block size-7 rounded-full bg-white shadow-knob ring-1 ring-line outline-none focus-visible:ring-2 focus-visible:ring-ink" />
    </Slider.Root>
  );
}

/* ---------- numbers ---------- */

interface StatProps {
  value: number;
  decimals: number;
  unit: string;
  label: string;
  swatch?: string;
}

export function Stat({ value, decimals, unit, label, swatch }: StatProps): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-tile bg-soft p-3.5">
      <span className="flex items-center gap-1.5 text-[11.5px] leading-tight text-muted">
        {swatch ? <span className={cn('size-2 shrink-0 rounded-full', swatch)} /> : null}
        {label}
      </span>
      <span className="flex items-baseline gap-1 text-[20px] leading-none font-semibold tabular-nums">
        <SlidingNumber number={value} decimalPlaces={decimals} initiallyStable />
        <span className="text-[11px] font-normal text-muted">{unit}</span>
      </span>
    </div>
  );
}

export { SlidingNumber };
