import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// Sarabun in the three weights the interface uses; each file holds Thai and Latin, loaded per unicode-range.
import '@fontsource/sarabun/400.css';
import '@fontsource/sarabun/500.css';
import '@fontsource/sarabun/600.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'จำลองน้ำท่วมประเทศไทย',
  description: 'เพิ่มระดับน้ำบนแผนที่ 3 มิติของประเทศไทย ดูว่าน้ำท่วมถึงไหน และหาเส้นทางที่ยังไปได้',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. LocatorJS) inject attributes on <html> before hydration
    <html lang="th" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
