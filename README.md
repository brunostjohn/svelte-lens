# Svelte Lens

Svelte 5 debugging with receipts — packaged as a Chrome DevTools extension.

Svelte Lens reads the development metadata Svelte 5 attaches to DOM nodes to build a component tree, map page elements back to `.svelte` source, highlight component fragments, and record DOM update receipts. An optional Vite plugin adds live props, top-level rune values, precise `$inspect` updates, local-state rewind, and run-by-run `$effect` receipts with dependency changes and cleanup activity.

Inspired by [React Lens](https://github.com/Fausto95/react-lens), with a Svelte-native capture layer and a Svelte 5 panel.

## What works

- Svelte component and block tree from `__svelte_meta`
- Page element picker and component highlighting
- Source file, line, and invocation metadata
- DOM mutation/update receipts associated with recent interactions
- Late DevTools connection and bounded replay across MV3 worker restarts
- Optional live `$props`, `$state`, and `$derived` inspection
- `$effect` and `$effect.pre` run/rerun counts, last-run dependencies, rerun reasons, dynamic dependency deltas, and cleanup receipts
- Inline JSON editing for writable, JSON-safe state bindings
- Optional rewind/go-live for writable, top-level local state
- Automatic return to live state when capture pauses or DevTools closes
- Clear degraded state for production or non-Svelte pages

The base extension does not patch Svelte's private runtime. Svelte currently exposes development DOM/source ancestry, but no stable global Svelte 5 lifecycle/state hook. Enhanced state features therefore use an explicit Vite transform instead of silently depending on a brittle runtime monkey patch.

Lens capture sleeps by default. The page hook keeps only lightweight enhanced-component identity and effect counters while the panel is closed; mutation tracing, dependency previews, effect receipts, checkpoints, state previews, and automatic snapshots start when the Svelte Lens panel is visible and stop again when it is hidden or disconnected. The first detailed effect-capture session dynamically enables Svelte's development write-stack tracing. Svelte does not expose a way to turn that flag back off, so its own write-stack bookkeeping remains enabled until the inspected page reloads even though Lens stops observing, serializing, and retaining data when the panel closes.

## Build and load the extension

Requirements: Node 20.19+ (or 22.12+) and pnpm.

```bash
pnpm install
pnpm build:extension
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `apps/extension/dist`.
4. Open a Svelte 5 app in development mode.
5. Open Chrome DevTools and choose **Svelte Lens**.
6. Reload the inspected page once after initially loading or updating the extension, so the page hook runs at `document_start`.

The extension requests `<all_urls>` because Chrome must install its page-world hook before the inspected app evaluates. Capture stays inside the inspected tab and extension; there are no remote scripts, analytics, or network uploads.

## Run the fixture

```bash
pnpm dev
```

Open the printed local URL, then use the Svelte Lens panel. The fixture includes nested components, conditional mount/unmount, primitive state, deep proxy state, derived values, props, keyed each blocks, parent/child interactions, and deterministic `$effect` controls. “Pulse effect” changes a primitive dependency, “Branch” swaps the effect's dynamic dependency set, and “Deep +1” invalidates a nested proxy read; the same effect returns a cleanup and the counters also include `$effect.pre`. `/lens-smoke.html` is a direct browser integration fixture for the Vite transform plus page runtime; `/panel-preview.html` renders the panel with representative data.

## Enable live state and rewind

Add the plugin before or alongside the regular Svelte/SvelteKit Vite plugin. Its two transforms use `enforce: 'pre'` and `enforce: 'post'`, so array position is not significant.

```bash
pnpm add -D svelte-lens-vite
```

```ts
// vite.config.ts
import { svelteLens } from 'svelte-lens-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelteLens(), svelte()]
});
```

For SvelteKit:

```ts
import { svelteLens } from 'svelte-lens-vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelteLens(), sveltekit()]
});
```

The enhancer runs only in Vite's development server by default and does not modify production builds. It instruments:

- destructured `$props()` bindings;
- top-level `$state(...)` and `$state.raw(...)` bindings, with setters where legal;
- top-level `$derived(...)` and `$derived.by(...)` bindings;
- a component-scoped compiled `$.inspect(...)` update callback;
- explicit user `$effect(...)` and `$effect.pre(...)` callbacks preserved through compilation, including nested user effects;
- public `onDestroy` cleanup, an initialization-abort guard, and the AST-identified component `$.pop(...)` boundary.

## Commands

```bash
pnpm test              # protocol, replay buffer, and transform tests
pnpm check             # Svelte and TypeScript checks in every workspace
pnpm build             # plugin, extension, and playground builds
pnpm build:extension   # unpacked Chrome artifact only
```

Tagged releases run `.github/workflows/release.yml`: they repeat the full validation, upload a versioned Chrome extension ZIP and npm tarball, then publish `svelte-lens-vite` through npm trusted publishing. See [docs/RELEASING.md](docs/RELEASING.md) for the version/tag contract.

## Current boundaries

- Chrome 116+ and the top frame only.
- Development builds are required for the component/source tree.
- Extension-only mode cannot inspect arbitrary component-local state; use the Vite enhancer.
- The enhancer intentionally captures top-level bindings, not closures hidden inside functions, external stores, or server state.
- Effect graph capture targets Svelte 5.39 or newer development output. It uses feature-guarded private dev-runtime shapes; an unsupported or changed shape degrades to unavailable dependency detail instead of throwing into the app.
- Effect dependencies are synchronous only, matching Svelte's own tracking: reads after an `await`, timer, or other asynchronous boundary are not attributed to the run.
- The dependency list is the actual dynamic set from the most recently captured run, not a union across history. Conditional branches therefore report added and removed dependency IDs.
- Enhancer instrumentation currently applies to `.svelte` components only. Rune code in `.svelte.ts` and `.svelte.js` modules is outside the transform.
- Run, rerun, cleanup, and error counters continue while recording is paused, but per-run receipts are not retained; `runCount - capturedRunCount` exposes paused or synchronously overlapped runs without complete evidence. On resume Lens samples the current graph as a new baseline, so later `before` values start there, but it cannot reconstruct which dependency changes caused the skipped runs.
- Cleanup reads are timed and counted but do not become dependencies of the next effect run. `$effect.root` itself is not a tracked user-effect receipt; explicit `$effect`/`$effect.pre` callbacks created inside it are recorded independently when Svelte exposes their parent reaction.
- Dependency graphs retain at most 60 nodes per run, with direct-count and truncation metadata preserved. Lens tracks at most 200 effects per component and 1,000 per page; the panel reports omitted counts rather than presenting a partial list as complete. Oversized wire payloads retain effect identity, source, outcome, counts, errors, and explicit omission flags while dropping bulky previews/stacks.
- Map-safe post-compile instrumentation still covers components handled by custom Svelte preprocessors, but props/state/derived binding inspection degrades when the raw preprocessed syntax cannot be analyzed.
- Direct proxy `$state` objects and arrays are restored in place so existing Svelte subscribers remain live. Compiler-optimized direct primitives and `$state.raw` values, plus direct `Date`, `Map`, `Set`, custom-class, and null-prototype values, are exposed as read-only when Svelte has emitted no signal or an identity-preserving replacement cannot be guaranteed.
- Rewind applies an exact retained component checkpoint. Derived values, props, external stores, DOM-only changes, refs, and already-unmounted instances are not restored; setter application is best-effort transactional and reports rollback failures.
- Pausing, hiding, unloading, or disconnecting the panel automatically attempts to return the inspected app to its live state.
- Values cross Chrome messaging only after bounded, JSON-safe serialization. Unsupported values are described or truncated rather than retained as live objects.
- The component tree is inferred from Svelte's dev stack. The enhancer improves repeated-instance and root identity, but DOM-less components can still have limited page highlighting.
- Open shadow roots are inspected; closed shadow roots and child frames are outside the current session.

## Repository layout

```text
apps/extension/       MV3 extension, page hook, bridge, and Svelte panel
packages/vite-plugin  Published as svelte-lens-vite
examples/playground   Svelte 5 manual and integration fixture
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and stability boundary.

## License

MIT
