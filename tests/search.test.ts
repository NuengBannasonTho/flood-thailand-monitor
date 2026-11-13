import { describe, expect, it } from 'vitest';
import { boxAround, boxContains, haversine } from '../lib/geo';
import type { Place } from '../lib/places';
import { photonPlace } from '../lib/server/photon';
import { insideFirst, mergePlaces } from '../lib/server/search';

const place = (name: string, lng: number, lat: number): Place => ({ name, detail: '', lng, lat });
/** about 111 m of latitude */
const STEP = 0.001;

describe('joining search results', () => {
  it('keeps the first list first and drops repeats from the second', () => {
    const nominatim = [place('ตลาดกิมหยง', 100.47, 7.0), place('สถานีรถไฟชุมทางหาดใหญ่', 100.48, 7.01)];
    const photon = [place('ตลาดกิมหยง', 100.47, 7.0 + 2 * STEP), place('เซ็นทรัล หาดใหญ่', 100.483, 6.992)];
    expect(mergePlaces([nominatim, photon]).map((p) => p.name)).toEqual(['ตลาดกิมหยง', 'สถานีรถไฟชุมทางหาดใหญ่', 'เซ็นทรัล หาดใหญ่']);
  });

  it('keeps places that share a name but lie far apart', () => {
    const temples = [place('วัดพระแก้ว', 100.49, 13.75), place('วัดพระแก้ว', 99.83, 19.91)];
    expect(mergePlaces([temples])).toHaveLength(2);
  });

  it('treats one spot as one place whatever it is called', () => {
    expect(mergePlaces([[place('Hat Yai International Airport', 100.393, 6.933)], [place('ท่าอากาศยานนานาชาติหาดใหญ่', 100.3932, 6.9331)]])).toHaveLength(1);
  });

  it('lists places in the area first, otherwise in the order found', () => {
    const area = { west: 100.42, south: 6.97, east: 100.52, north: 7.04 };
    const found = [place('เซ็นทรัล พระราม 3', 100.538, 13.698), place('เซ็นทรัล หาดใหญ่', 100.483, 6.992), place('เซ็นทรัล รามอินทรา', 100.602, 13.872)];
    expect(insideFirst(found, area).map((p) => p.name)).toEqual(['เซ็นทรัล หาดใหญ่', 'เซ็นทรัล พระราม 3', 'เซ็นทรัล รามอินทรา']);
  });
});

describe('Photon results', () => {
  it('reads a named place with its area as the detail', () => {
    const feature = {
      geometry: { type: 'Point', coordinates: [100.475, 7.01] },
      properties: { name: 'โรงเรียนหาดใหญ่วิทยาลัย', street: 'ถนนเพชรเกษม', district: 'คอหงส์', city: 'หาดใหญ่', state: 'สงขลา', countrycode: 'TH' },
    };
    expect(photonPlace(feature)).toEqual({ name: 'โรงเรียนหาดใหญ่วิทยาลัย', detail: 'ถนนเพชรเกษม · คอหงส์ · หาดใหญ่', lng: 100.475, lat: 7.01 });
  });

  it('names an address by its street and drops places outside Thailand', () => {
    expect(photonPlace({ geometry: { coordinates: [100.4, 7] }, properties: { street: 'ถนนแสงศรี', housenumber: '12', countrycode: 'TH' } })?.name).toBe('ถนนแสงศรี 12');
    expect(photonPlace({ geometry: { coordinates: [101.7, 3.1] }, properties: { name: 'Kuala Lumpur', countrycode: 'MY' } })).toBeNull();
    expect(photonPlace({ geometry: { coordinates: [100.4, 7] }, properties: {} })).toBeNull();
  });
});

describe('an area around the route ends', () => {
  const W = 10_000;
  const H = 7_000;

  it('is the full size and holds both ends with room to spare', () => {
    const a = { lng: 100.45, lat: 7.0 };
    const b = { lng: 100.5, lat: 7.02 };
    const box = boxAround([a, b], W, H, 400);
    expect(box).not.toBeNull();
    if (!box) return;
    expect(boxContains(box, a.lng, a.lat) && boxContains(box, b.lng, b.lat)).toBe(true);
    const mid = (box.south + box.north) / 2;
    expect(haversine(box.west, mid, box.east, mid)).toBeCloseTo(W, -1);
    expect(haversine(box.west, box.south, box.west, box.north)).toBeCloseTo(H, -1);
  });

  it('is null when the ends are too far apart', () => {
    expect(boxAround([{ lng: 100.45, lat: 7.0 }, { lng: 100.6, lat: 7.0 }], W, H, 400)).toBeNull();
    expect(boxAround([{ lng: 100.45, lat: 7.0 }, { lng: 100.45, lat: 7.07 }], W, H, 400)).toBeNull();
  });
});
