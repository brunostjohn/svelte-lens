# svelte-lens-vite

Development-only Vite instrumentation for the [Svelte Lens](https://github.com/brunostjohn/svelte-lens) Chrome DevTools extension.

The extension can build a component/source tree from Svelte 5 development metadata by itself. This plugin adds live top-level `$props`, `$state`, and `$derived` inspection, rune-bearing class inspection from `.svelte.js`/`.svelte.ts` modules, safe state editing, precise update receipts, retained local-state checkpoints for rewind, and structured `$effect`/`$effect.pre` diagnostics.

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

The plugin is fail-closed and participates only in Vite's development server. `vite build` omits it regardless of the selected mode, and `vite preview` omits it as well, so Lens instrumentation and runtime hooks cannot enter a production bundle merely because the plugin or browser extension is installed. Pass `svelteLens({ enabled: false })` to disable development instrumentation explicitly.

Playwright-hosted application servers can opt out without changing their Vite config. When the Vite process has `IN_PLAYWRIGHT=true` or `VITE_PLAYWRIGHT=true`, `svelteLens()` returns no plugins and existing plugin hooks stay inert. Matching is exact and intentionally does not use broad signals such as `CI`.

## Rune-bearing objects and classes

Named classes compiled from `.svelte.js` and `.svelte.ts` modules expose their compiler-known `$state`, private `$state`, constructor-initialized `$state`, and `$derived` fields to the panel. Lens does not enumerate prototypes, discover accessors, or invoke arbitrary getters. The transform emits field adapters from Svelte's compiled private signals and recovers each field's original source location through Vite's combined source map.

Registration retains the instance through `WeakRef` only. Snapshots send class and field metadata without reading field values; values are evaluated only when the panel explicitly inspects that instance. An inspection shares a 2,000-node/250,000-character serialization budget, and at most 64 fields per class and 1,000 live instances per page are registered. Anonymous classes are deliberately skipped because they have no stable source identity.

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
- Effect callbacks are wrapped only in `.svelte` components. Named rune-bearing classes in `.svelte.ts` and `.svelte.js` modules receive the separate, lazy object-inspection adapter described above.
- Counts continue while DevTools recording is paused, but dependency receipts do not; the difference between total and captured runs exposes paused or synchronously overlapped runs without complete evidence. Resuming samples the current graph as a fresh baseline, so subsequent `before` values are relative to resume and cannot explain changes that happened while paused.
- Cleanup reads are not promoted to dependencies. `$effect.root` itself is outside the user-effect adapter, while explicit nested `$effect` and `$effect.pre` callbacks are recorded when they execute.
- Lens does not enable Svelte's irreversible development write-stack tracing flag. Why-rerun evidence comes from bounded dependency identity, write versions, and previews, while user-authored `$inspect.trace` continues to work normally.
- Graphs retain at most 60 dependency nodes per run. Lens tracks at most 200 effects per component and 1,000 per page; bounded omissions and oversized-payload compaction remain visible through counts and banners.
- Custom-preprocessed components retain component identity and effect wrapping even when their raw syntax cannot be parsed, while binding inspection degrades to an empty props/state/derived plan.
- Direct proxy objects and arrays are restored in place to preserve Svelte subscribers. Compiler-optimized direct primitives and `$state.raw` values, plus direct non-plain values such as `Date`, `Map`, `Set`, custom classes, and null-prototype objects, are read-only when Svelte emitted no signal or an identity-preserving replacement is not safe.

See the [main repository](https://github.com/brunostjohn/svelte-lens#readme) for the Chrome extension, fixture, and full capture boundaries.

## License

MIT
