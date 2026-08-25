# svelte-lens-vite

Development-only Vite instrumentation for the [Svelte Lens](https://github.com/brunostjohn/svelte-lens) Chrome DevTools extension.

The extension can build a component/source tree from Svelte 5 development metadata by itself. This plugin adds live top-level `$props`, `$state`, and `$derived` inspection, safe state editing, precise update receipts, and retained local-state checkpoints for rewind.

## Install

```bash
pnpm add -D svelte-lens-vite
```

## Vite

```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { svelteLens } from 'svelte-lens-vite';

export default defineConfig({
  plugins: [svelteLens(), svelte()]
});
```

## SvelteKit

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { svelteLens } from 'svelte-lens-vite';

export default defineConfig({
  plugins: [svelteLens(), sveltekit()]
});
```

The transforms run only during Vite's development server by default. Pass `svelteLens({ enabled: false })` to disable them explicitly. See the [main repository](https://github.com/brunostjohn/svelte-lens#readme) for the Chrome extension and current capture boundaries.

## License

MIT
