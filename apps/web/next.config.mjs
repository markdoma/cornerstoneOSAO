import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), quiet: true });
const api =
  process.env.API_URL ??
  (process.env.NODE_ENV === 'production' ? 'http://api:4000' : 'http://localhost:4000');
export default {
  output: 'standalone',
  distDir: process.env.AO_NEXT_DIST_DIR ?? '.next',
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/backend/:path*', destination: `${api}/:path*` }];
  },
  env: { NEXT_PUBLIC_WIDGET_ORIGIN: process.env.WIDGET_ORIGIN ?? 'http://localhost:4000' },
};
