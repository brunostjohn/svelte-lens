# svelte-lens-vite

Development-only Vite instrumentation for the [Svelte Lens](https://github.com/brunostjohn/svelte-lens) Chrome DevTools extension.

The extension can build a component/source tree from Svelte 5 development metadata by itself. This plugin adds live top-level `$props`, `$state`, and `$derived` inspection, safe state editing, precise update receipts, retained local-state checkpoints for rewind, and structured `$effect`/`$effect.pre` diagnostics.

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

The transforms run only during Vite's development server by default. Pass `svelteLens({ enabled: false })` to disable them explicitly.

## Effect diagnostics

For each explicit user `$effect` and `$effect.pre` in a `.svelte` component, the plugin lets the extension report:

- total run and rerun counts, captured-run counts, and synchronous duration;
- the actual dependency graph from the latest captured run, including derived ancestry;
- which dependencies invalidated a rerun, with bounded `before` and current previews;
- values written again by the callback, kept separate as `afterCallback` evidence;
- dependencies added or removed when a conditional branch changes;
- cleanup registration, count, duration, and outcome;
- parent IDs for nested user effects when Svelte exposes the relationship.

Effect capture follows these deliberate boundaries:

- Svelte 5.39 or newer development output is required for exact dependency capture. Private dev-runtime fields are version- and shape-guarded, so an incompatible runtime degrades to unavailable detail without changing application behavior.
- Tracking is synchronous, just like Svelte: a read after `await`, a timer, or another asynchronous boundary is not a dependency of that run.
- Dependencies describe the latest dynamic run, not a cumulative union. A conditional effect can add and remove dependencies on every execution.
- Only `.svelte` components are transformed; runes in `.svelte.ts` and `.svelte.js` modules are not instrumented.
- Counts continue while DevTools recording is paused, but dependency receipts do not; the difference between total and captured runs exposes paused or synchronously overlapped runs without complete evidence. Resuming samples the current graph as a fresh baseline, so subsequent `before` values are relative to resume and cannot explain changes that happened while paused.
- Cleanup reads are not promoted to dependencies. `$effect.root` itself is outside the user-effect adapter, while explicit nested `$effect` and `$effect.pre` callbacks are recorded when they execute.
- Lens dynamically enables Svelte's development write-stack tracing only when detailed recording first starts. Svelte does not expose a matching disable switch, so that runtime bookkeeping remains enabled until page reload; Lens itself stops observers, previews, receipts, and retention when recording is paused or the panel closes.
- Graphs retain at most 60 dependency nodes per run. Lens tracks at most 200 effects per component and 1,000 per page; bounded omissions and oversized-payload compaction remain visible through counts and banners.
- Custom-preprocessed components retain component identity and effect wrapping even when their raw syntax cannot be parsed, while binding inspection degrades to an empty props/state/derived plan.
- Direct proxy objects and arrays are restored in place to preserve Svelte subscribers. Compiler-optimized direct primitives and `$state.raw` values, plus direct non-plain values such as `Date`, `Map`, `Set`, custom classes, and null-prototype objects, are read-only when Svelte emitted no signal or an identity-preserving replacement is not safe.

See the [main repository](https://github.com/brunostjohn/svelte-lens#readme) for the Chrome extension, fixture, and full capture boundaries.

## License

MIT
