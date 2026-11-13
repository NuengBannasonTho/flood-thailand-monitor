'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Loader, MapPoint } from 'reicon-react';
import { searchPlaces } from '@/lib/api';
import type { Bounds } from '@/lib/config';
import { type Place, placeKey } from '@/lib/places';

export type SearchStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** `next`: offset of the next page, null when there is no more; `more`: state of loading that page */
  | { kind: 'done'; query: string; places: Place[]; next: number | null; more: 'idle' | 'loading' | 'error' }
  | { kind: 'error'; message: string };

export interface PlaceSearch {
  status: SearchStatus;
  /** Searches on demand only: the public geocoder does not allow search-as-you-type. */
  search: (query: string) => void;
  loadMore: () => void;
  /** Cancels whatever is in flight and forgets the results. */
  reset: () => void;
}

/** Place search across Thailand; places inside `near` come first. A new search cancels the last one. */
export function usePlaceSearch(near: Bounds | null = null): PlaceSearch {
  const [status, setStatus] = useState<SearchStatus>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  /** the area the current results were ranked by, so later pages come from the same list */
  const nearRef = useRef(near);

  useEffect(() => () => abortRef.current?.abort(), []);

  const search = (query: string): void => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    nearRef.current = near;
    setStatus({ kind: 'loading' });
    searchPlaces(query, abort.signal, 0, near)
      .then((page) => setStatus({ kind: 'done', query, places: page.places, next: page.next, more: 'idle' }))
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setStatus({ kind: 'error', message: error instanceof Error ? error.message : 'ค้นหาไม่สำเร็จ' });
      });
  };

  /** Appends the next page. Shares the search's AbortController, so a new search or a reset cancels it. */
  const loadMore = (): void => {
    if (status.kind !== 'done' || status.next === null || status.more === 'loading') return;
    const { query, next } = status;
    const signal = abortRef.current?.signal ?? new AbortController().signal;
    setStatus({ ...status, more: 'loading' });
    searchPlaces(query, signal, next, nearRef.current)
      .then((page) =>
        setStatus((s) => {
          if (s.kind !== 'done' || s.query !== query) return s;
          const seen = new Set(s.places.map(placeKey));
          return { ...s, places: [...s.places, ...page.places.filter((p) => !seen.has(placeKey(p)))], next: page.next, more: 'idle' };
        }),
      )
      .catch(() => {
        if (!signal.aborted) setStatus((s) => (s.kind === 'done' && s.query === query ? { ...s, more: 'error' } : s));
      });
  };

  const reset = (): void => {
    abortRef.current?.abort();
    setStatus({ kind: 'idle' });
  };

  return { status, search, loadMore, reset };
}

interface PlaceResultsProps {
  search: PlaceSearch;
  onChoose: (place: Place) => void;
  /** what to say when nothing matched */
  empty: string;
  /** offered before anything is searched */
  suggestions?: { title: string; places: readonly Place[] };
  className?: string;
}

/** Results of a place search, loading the next page when the end of the list scrolls near. */
export function PlaceResults({ search, onChoose, empty, suggestions, className }: PlaceResultsProps): ReactElement {
  const { status, loadMore } = search;
  const listRef = useRef<HTMLUListElement | null>(null);
  const moreRef = useRef<HTMLLIElement | null>(null);

  // Re-subscribes after every page, so a page too short to fill the list is followed straight away by the next one.
  const canLoadMore = status.kind === 'done' && status.next !== null && status.more === 'idle';
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const shown = status.kind === 'done' ? status.places.length : 0;
  useEffect(() => {
    const root = listRef.current;
    const target = moreRef.current;
    if (!canLoadMore || !root || !target) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
    }, { root, rootMargin: '0px 0px 80px 0px' });
    io.observe(target);
    return () => io.disconnect();
  }, [canLoadMore, shown]);

  const places = status.kind === 'done' ? status.places : status.kind === 'idle' ? (suggestions?.places ?? []) : [];

  return (
    <div className={className}>
      {status.kind === 'error' ? <p className="px-3 py-3 text-[13px] text-danger">{status.message}</p> : null}
      {status.kind === 'loading' ? <p className="px-3 py-3 text-[13px] text-muted">กำลังค้นหา…</p> : null}
      {status.kind === 'done' && places.length === 0 ? <p className="px-3 py-3 text-[13px] text-muted">{empty}</p> : null}
      {status.kind === 'idle' && suggestions ? <p className="px-3 pt-2 pb-1 text-[11.5px] text-muted">{suggestions.title}</p> : null}
      <ul ref={listRef} className="scroll-thin max-h-72 overflow-y-auto">
        {places.map((place) => (
          <li key={placeKey(place)}>
            <button type="button" onClick={() => onChoose(place)} className="flex w-full items-center gap-3 rounded-control px-3 py-2 text-left hover:bg-soft">
              <MapPoint size={18} className="shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{place.name}</span>
                <span className="block truncate text-xs text-muted">{place.detail}</span>
              </span>
            </button>
          </li>
        ))}
        {status.kind === 'done' && (status.next !== null || status.more === 'error') ? (
          <li ref={moreRef} className="flex items-center justify-center gap-2 px-3 py-3 text-[12.5px] text-muted">
            {status.more === 'error' ? (
              <>
                โหลดผลเพิ่มไม่สำเร็จ
                <button type="button" onClick={loadMore} className="font-medium text-ink underline underline-offset-2">
                  ลองอีกครั้ง
                </button>
              </>
            ) : (
              <>
                <Loader size={14} className="animate-spin" />
                กำลังโหลดผลเพิ่ม…
              </>
            )}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
