import { crx } from '@crxjs/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import manifest from './src/manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [svelte(), crx({ manifest })],
  build: {
    target: 'chrome116',
    modulePreload: false,
    rollupOptions: {
      input: {
        devtools: 'src/devtools/devtools.html',
        panel: 'src/panel/panel.html'
      }
    }
  }
});
