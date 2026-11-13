import type { NextConfig } from 'next';
import { version } from './package.json';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Built into the page, which shows it under the model note.
  env: { APP_VERSION: version },
};

export default config;
