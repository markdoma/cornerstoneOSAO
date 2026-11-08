import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  base: '/widget-assets/',
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        loader: resolve(import.meta.dirname, 'src/loader.ts'),
      },
      output: { entryFileNames: '[name].js', assetFileNames: '[name][extname]' },
    },
  },
});
