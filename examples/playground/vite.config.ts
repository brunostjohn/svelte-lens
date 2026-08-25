import { svelteLens } from 'svelte-lens-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelteLens(), svelte()]
});
