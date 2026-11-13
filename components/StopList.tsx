'use client';

import { Reorder, useDragControls, type DragControls } from 'motion/react';
import { memo, useEffect, useRef, useState, type ReactElement } from 'react';
import { CloseCircle, MapPoint, Plus, Search } from 'reicon-react';
import type { Bounds } from '@/lib/config';
import type { Endpoint } from '@/lib/map/controller';
import type { Place } from '@/lib/places';
import { MAX_STOPS, moveStop, type Stop, stopLabel, stopLetters } from '@/lib/stops';
import { PlaceResults, usePlaceSearch } from './PlaceResults';
import { cn, IconBtn } from './ui/kit';

interface StopRowProps {
  stop: Stop;
  letter: string | null;
  label: string;
  picking: boolean;
  /** an area is simulated, so the stop can be pinned on the map */
  ready: boolean;
  /** the stop can be searched for; this needs only the map */
  searchable: boolean;
  /** the simulated area; places in it are listed first */
  near: Bounds | null;
  /** the row itself can go, not just its place */
  removable: boolean;
  autoFocus: boolean;
  drag: DragControls;
  onPick: (id: string | null) => void;
  onRemove: (id: string) => void;
  onSet: (id: string, point: Endpoint) => void;
  /** keyboard reordering: -1 up, 1 down */
  onNudge: (id: string, by: -1 | 1) => void;
}

/** One stop: type a place name to search all of Thailand, or pin it on the map. The badge is the drag handle. */
function StopRow({ stop, letter, label, picking, ready, searchable, near, removable, autoFocus, drag, onPick, onRemove, onSet, onNudge }: StopRowProps): ReactElement {
  /** what has been typed; null while the field shows the stop's place */
  const [draft, setDraft] = useState<string | null>(null);
  const search = usePlaceSearch(near);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const keepSelection = useRef(false);
  const typed = (draft ?? '').trim();
  const editing = draft !== null;
  const point = stop.point;

  const close = (): void => {
    setDraft(null);
    search.reset();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Clicking anywhere else, the map included, drops the unfinished search.
  useEffect(() => {
    if (!editing) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) closeRef.current();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [editing]);

  const run = (): void => {
    if (typed.length >= 2) search.search(typed);
  };
  const choose = (place: Place): void => {
    onSet(stop.id, { lng: place.lng, lat: place.lat, name: place.name });
    close();
  };

  return (
    <div
      ref={rootRef}
      className="flex flex-col gap-1.5"
      onBlur={(e) => {
        // Tabbing out drops it too. A click on a result keeps focus inside, or moves it nowhere in Safari.
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-tile py-1.5 pr-1.5 pl-2 transition-colors',
          picking ? 'bg-ink text-white' : 'bg-soft has-[input:focus-visible]:bg-surface has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ink/15',
        )}
      >
        <button
          type="button"
          aria-label={`ย้ายลำดับ${label}${letter ? ` ${letter}` : ''} ลากหรือกดลูกศรขึ้นลง`}
          title="ลากเพื่อสลับลำดับ"
          onPointerDown={(e) => drag.start(e)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              onNudge(stop.id, e.key === 'ArrowUp' ? -1 : 1);
            }
          }}
          className="grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-full active:cursor-grabbing"
        >
          {letter ? (
            <span className={cn('grid size-6 place-items-center rounded-full text-[11px] font-semibold', picking ? 'bg-white text-ink' : 'bg-ink text-white')}>{letter}</span>
          ) : (
            <span className={cn('size-3 rounded-full border-[3px]', picking ? 'border-white' : 'border-ink bg-white')} />
          )}
        </button>
        <label className="min-w-0 flex-1">
          <span className={cn('block text-[11px] leading-tight', picking ? 'text-white/60' : 'text-muted')}>{label}</span>
          {picking ? (
            <span className="block truncate text-[13.5px] leading-snug font-medium">คลิกตำแหน่งบนแผนที่</span>
          ) : (
            <input
              value={draft ?? point?.name ?? ''}
              disabled={!searchable}
              autoFocus={autoFocus}
              placeholder={!searchable ? 'ยังไม่ได้ปัก' : ready ? 'พิมพ์ชื่อสถานที่ หรือปักบนแผนที่' : 'พิมพ์ชื่อสถานที่'}
              autoComplete="off"
              enterKeyHint="search"
              onChange={(e) => {
                setDraft(e.target.value);
                if (search.status.kind !== 'idle') search.reset();
              }}
              onFocus={(e) => {
                // Whole name selected, so typing replaces it. The mouseup that follows would clear the selection.
                e.currentTarget.select();
                keepSelection.current = true;
              }}
              onMouseUp={(e) => {
                if (keepSelection.current) e.preventDefault();
                keepSelection.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  run();
                } else if (e.key === 'Escape' && editing) {
                  e.preventDefault();
                  close();
                }
              }}
              className={cn(
                'block h-5 w-full min-w-0 truncate bg-transparent text-[13.5px] leading-snug font-medium outline-none placeholder:font-normal disabled:placeholder:font-medium',
                searchable ? 'placeholder:text-muted' : 'placeholder:text-ink',
              )}
            />
          )}
        </label>
        {editing && typed.length >= 2 ? <IconBtn type="button" size="sm" tone="dark" label={`ค้นหา${label}`} icon={Search} onClick={run} /> : null}
        {(removable || point) && !picking && !editing ? (
          <IconBtn type="button" size="sm" tone="ghost" label={removable ? `เอา${label}ออก` : `ลบ${label}`} icon={CloseCircle} onClick={() => onRemove(stop.id)} />
        ) : null}
        <IconBtn
          type="button"
          size="sm"
          tone={picking ? 'outline' : editing ? 'ghost' : 'dark'}
          disabled={!ready}
          label={picking ? 'ยกเลิก' : `ปัก${label}บนแผนที่`}
          icon={picking ? CloseCircle : MapPoint}
          onClick={() => {
            close();
            onPick(picking ? null : stop.id);
          }}
        />
      </div>
      {editing && search.status.kind !== 'idle' ? (
        <PlaceResults search={search} onChoose={choose} empty={`ไม่พบ “${typed}” ลองสะกดแบบอื่น${ready ? ' หรือปักบนแผนที่' : ''}`} className="rounded-tile bg-surface p-1.5 ring-1 ring-line" />
      ) : null}
    </div>
  );
}

/** A row in the reorderable list; it owns the drag handle's controls. */
function StopItem(props: Omit<StopRowProps, 'drag'> & { onDragEnd: () => void }): ReactElement {
  const drag = useDragControls();
  const { onDragEnd, ...row } = props;
  return (
    <Reorder.Item as="div" value={props.stop} dragListener={false} dragControls={drag} onDragEnd={onDragEnd} className="relative">
      <StopRow {...row} drag={drag} />
    </Reorder.Item>
  );
}

interface StopListProps {
  stops: readonly Stop[];
  picking: string | null;
  ready: boolean;
  searchable: boolean;
  near: Bounds | null;
  onPick: (id: string | null) => void;
  onRemove: (id: string) => void;
  onSet: (id: string, point: Endpoint) => void;
  onReorder: (next: Stop[]) => void;
  onAdd: () => void;
}

/** The trip's stops in order. Rows reorder by dragging their badge, or with the arrow keys on it. */
export const StopList = memo(function StopList({ stops, picking, ready, searchable, near, onPick, onRemove, onSet, onReorder, onAdd }: StopListProps): ReactElement {
  /** the order while a row is being dragged; committed when it is let go */
  const [dragging, setDragging] = useState<Stop[] | null>(null);
  const shown = dragging ?? stops;
  const letters = stopLetters(shown);

  // A row just added, still empty, takes the focus.
  const known = useRef<ReadonlySet<string> | null>(null);
  const fresh = known.current ? stops.find((s) => !known.current?.has(s.id) && !s.point)?.id : undefined;
  useEffect(() => {
    known.current = new Set(stops.map((s) => s.id));
  });

  const nudge = (id: string, by: -1 | 1): void => {
    const from = stops.findIndex((s) => s.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= stops.length) return;
    onReorder(moveStop(stops, from, to));
  };

  return (
    <div className="flex flex-col gap-2">
      <Reorder.Group as="div" axis="y" values={[...shown]} onReorder={setDragging} className="flex flex-col gap-2">
        {shown.map((stop, i) => (
          <StopItem
            key={stop.id}
            stop={stop}
            letter={letters[i]}
            label={stopLabel(shown, i)}
            picking={picking === stop.id}
            ready={ready}
            searchable={searchable}
            near={near}
            removable={stops.length > 2}
            autoFocus={stop.id === fresh}
            onPick={onPick}
            onRemove={onRemove}
            onSet={onSet}
            onNudge={nudge}
            onDragEnd={() => {
              if (dragging) onReorder(dragging);
              setDragging(null);
            }}
          />
        ))}
      </Reorder.Group>
      <button
        type="button"
        onClick={onAdd}
        disabled={!searchable || stops.length >= MAX_STOPS}
        className="flex h-9 items-center gap-2 self-start rounded-full px-3 text-[13px] font-medium text-ink hover:bg-soft disabled:text-muted disabled:hover:bg-transparent"
      >
        <Plus size={16} />
        {stops.length >= MAX_STOPS ? `เพิ่มได้สูงสุด ${MAX_STOPS} จุด` : 'เพิ่มจุดแวะ'}
      </button>
    </div>
  );
});
