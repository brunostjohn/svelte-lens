# Svelte Lens

Svelte 5 debugging with receipts — packaged as a Chrome DevTools extension.

Svelte Lens reads the development metadata Svelte 5 attaches to DOM nodes to build a component tree, map page elements back to `.svelte` source, highlight component fragments, and record DOM update receipts. An optional Vite plugin adds live props, top-level rune values, precise `$inspect` updates, and local-state rewind.

Inspired by [React Lens](https://github.com/Fausto95/react-lens), with a Svelte-native capture layer and a Svelte 5 panel.

## What works

- Svelte component and block tree from `__svelte_meta`
- Page element picker and component highlighting
- Source file, line, and invocation metadata
- DOM mutation/update receipts associated with recent interactions
- Late DevTools connection and bounded replay across MV3 worker restarts
- Optional live `$props`, `$state`, and `$derived` inspection
- Inline JSON editing for writable, JSON-safe state bindings
- Optional rewind/go-live for writable, top-level local state
- Automatic return to live state when capture pauses or DevTools closes
- Clear degraded state for production or non-Svelte pages

The base extension does not patch Svelte's private runtime. Svelte currently exposes development DOM/source ancestry, but no stable global Svelte 5 lifecycle/state hook. Enhanced state features therefore use an explicit Vite transform instead of silently depending on a brittle runtime monkey patch.

Capture sleeps by default. The page hook keeps only lightweight enhanced-component identity while the panel is closed; mutation tracing, checkpoints, state previews, and automatic snapshots start when the Svelte Lens panel is visible and stop again when it is hidden or disconnected.

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

Open the printed local URL, then use the Svelte Lens panel. The fixture includes nested components, conditional mount/unmount, primitive state, deep proxy state, derived values, props, keyed each blocks, and parent/child interactions. `/lens-smoke.html` is a direct browser integration fixture for the Vite transform plus page runtime; `/panel-preview.html` renders the panel with representative data.

## Enable live state and rewind

Add the plugin before or alongside the regular Svelte/SvelteKit Vite plugin. Its two transforms use `enforce: 'pre'` and `enforce: 'post'`, so array position is not significant.

```ts
// vite.config.ts
import { svelteLens } from '@svelte-lens/vite-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelteLens(), svelte()]
});
```

For SvelteKit:

```ts
import { svelteLens } from '@svelte-lens/vite-plugin';
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
- a component-scoped `$inspect(...).with(...)` update callback;
- `onDestroy` cleanup and the compiled component `$.pop(...)` boundary.

## Commands

```bash
pnpm test              # protocol, replay buffer, and transform tests
pnpm check             # Svelte and TypeScript checks in every workspace
pnpm build             # plugin, extension, and playground builds
pnpm build:extension   # unpacked Chrome artifact only
```

## Current boundaries

- Chrome 116+ and the top frame only.
- Development builds are required for the component/source tree.
- Extension-only mode cannot inspect arbitrary component-local state; use the Vite enhancer.
- The enhancer intentionally captures top-level bindings, not closures hidden inside functions, external stores, or server state.
- Rewind applies an exact retained component checkpoint. Derived values, props, external stores, DOM-only changes, refs, and already-unmounted instances are not restored; setter application is best-effort transactional and reports rollback failures.
- Pausing, hiding, unloading, or disconnecting the panel automatically attempts to return the inspected app to its live state.
- Values cross Chrome messaging only after bounded, JSON-safe serialization. Unsupported values are described or truncated rather than retained as live objects.
- The component tree is inferred from Svelte's dev stack. The enhancer improves repeated-instance and root identity, but DOM-less components can still have limited page highlighting.
- Open shadow roots are inspected; closed shadow roots and child frames are outside the current session.

## Repository layout

```text
apps/extension/       MV3 extension, page hook, bridge, and Svelte panel
packages/vite-plugin Optional Svelte/Vite instrumentation
examples/playground  Svelte 5 manual and integration fixture
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and stability boundary.

## License

MIT
