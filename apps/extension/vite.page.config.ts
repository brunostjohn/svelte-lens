import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'chrome116',
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/page/page-hook.ts'),
      formats: ['iife'],
      name: 'SvelteLensPageHook',
      fileName: () => 'page-hook.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
