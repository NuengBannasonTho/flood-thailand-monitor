'use client';

import { memo, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { CloseCircle, Loader, Search } from 'reicon-react';
import { QUICK_PLACES, type Place } from '@/lib/places';
import { PlaceResults, usePlaceSearch } from './PlaceResults';
import { Card, cn } from './ui/kit';

interface SearchBarProps {
  onSelect: (place: Place) => void;
  /** the clear button was pressed */
  onClear?: () => void;
  className?: string;
}

/** Place search across Thailand. Searches on submit only: the public geocoder does not allow search-as-you-type. */
export const SearchBar = memo(function SearchBar({ onSelect, onClear, className }: SearchBarProps): ReactElement {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const search = usePlaceSearch();
  const { status, reset } = search;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (e: PointerEvent): void => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    search.search(q);
    setOpen(true);
  };

  const choose = (place: Place): void => {
    setOpen(false);
    setQuery(place.name);
    onSelect(place);
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {/* Focus shows on the whole pill instead of an outline inside it */}
      <Card className="p-1.5 transition-shadow has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ink/15">
        <form onSubmit={submit} className="flex items-center gap-1" role="search">
          <Search size={18} className="ml-3.5 shrink-0 text-muted" />
          <input
            id="place-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (status.kind !== 'idle') reset();
            }}
            onFocus={() => setOpen(true)}
            placeholder="ค้นหาเมือง ตำบล หรือสถานที่ในไทย"
            aria-label="ค้นหาสถานที่"
            autoComplete="off"
            enterKeyHint="search"
            className="h-11 min-w-0 flex-1 bg-transparent px-2 text-[14.5px] outline-none placeholder:text-muted"
          />
          {query ? (
            <button
              type="button"
              aria-label="ล้างคำค้น"
              onClick={() => {
                setQuery('');
                reset();
                onClear?.();
              }}
              className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:text-ink"
            >
              <CloseCircle size={18} />
            </button>
          ) : null}
          <button type="submit" disabled={query.trim().length < 2} className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-medium text-white transition-colors hover:bg-ink-soft disabled:bg-line disabled:text-muted">
            {status.kind === 'loading' ? <Loader size={16} className="animate-spin" /> : null}
            ค้นหา
          </button>
        </form>
      </Card>

      {open ? (
        <Card className="absolute inset-x-0 top-full z-20 mt-2 p-2">
          <PlaceResults search={search} onChoose={choose} empty="ไม่พบสถานที่ชื่อนี้ในประเทศไทย ลองสะกดแบบอื่น" suggestions={{ title: 'เมืองที่เคยน้ำท่วมหนัก', places: QUICK_PLACES }} />
        </Card>
      ) : null}
    </div>
  );
});
