# Architecture

```text
Svelte 5 development page
  └─ MAIN-world page-hook.js
       ├─ reads element.__svelte_meta
       ├─ optional window.__SVELTE_LENS__ enhancer API
       ├─ guarded Svelte dev-runtime effect graph adapter
       ├─ weak rune-object registry with lazy field reads
       ├─ picker/highlighter and bounded checkpoints
       └─ window.postMessage
            ↓
     ISOLATED content script
       ├─ validates every envelope
       ├─ assigns session sequence numbers
       └─ retains a bounded replay ring
            ↓ chrome.runtime.Port
     stateless MV3 service worker
            ↓ tab-paired relay
     Svelte 5 DevTools panel
       ├─ component/block tree
       ├─ update receipts
       ├─ live props/state/derived inspector
       ├─ effect runs, triggers, dependencies, and cleanup receipts
       └─ rewind/go-live commands
```

## Why there are two capture modes

In current Svelte 5 development output, elements receive:

```ts
element.__svelte_meta = {
  loc: { file, line, column },
  parent: { type, file, line, column, componentTag?, parent? }
};
```

That is enough for source mapping, call-stack-derived component/block trees, DOM ownership, picking, and mutation attribution. `window.__svelte.v` also provides version detection.

It is not a component lifecycle/state protocol. The Vite enhancer establishes that missing seam explicitly. Its pre pass parses each component into a binding plan but returns the original `.svelte` bytes unchanged. After Svelte compiles the component, the post pass inserts compiled-aware descriptor closures and marks the `$.pop(...)` boundary so the MAIN-world hook can associate synchronous DOM metadata with the correct component instance without shifting Svelte source locations.

For named classes in `.svelte.js` and `.svelte.ts`, a separate compiled-module pass identifies the private signals Svelte generated for class-field and constructor runes. It emits shared adapters that accept an instance rather than closing over it. The page hook therefore retains instances only through `WeakRef`, snapshots only source-mapped field metadata, and reads values under a shared serialization budget after an explicit `inspect-rune-object` command. It never crawls a prototype or invokes an accessor to discover state.

The page hook is the only layer allowed to know these shapes. The transport and panel consume normalized protocol records.

## Effect instrumentation

The read-only source pass discovers props, state, and derived bindings. The post-compile transform finds the real component function, emits accessors matching Svelte's compiled representation, adds `$.inspect` plus public `onDestroy` lifecycle observers, and wraps only `user_effect` or `user_pre_effect` callbacks inside that component function. Module-script helpers are deliberately excluded because they cannot reference a component-local instance ID. Each wrapper receives a stable site descriptor containing component identity, effect kind, and the original location recovered through Vite's combined source map. The component `$.pop` is found through the compiled AST rather than text matching, and initialization runs inside a guarded lexical block so a thrown mount aborts the partial record without poisoning the parent stack. The transform does not replace or patch Svelte's scheduler.

If a custom preprocessor owns syntax the read-only pass cannot parse, it still caches a binding-empty component plan. The post pass can therefore preserve component identity, source-mapped effect wrapping, lifecycle, and abort behavior after preprocessing while props/state/derived inspection visibly degrades.

During a run, the page hook feature-detects Svelte's active dev reaction and reads its dependency array, write versions, labels, derived children, and parent reaction through a narrow adapter. All diagnostic reads run inside Svelte's `untrack`, so inspecting a signal cannot accidentally make Lens a dependency. Derived dependencies are expanded with direct/indirect and parent IDs, allowing a dirty source to explain a rerun through a derived value.

The committed dependency list always replaces the previous list. It therefore represents the dynamic graph from the last captured synchronous run rather than a union over the effect's lifetime. Baseline previews and write versions explain invalidations; IDs present only before or after a conditional branch become removed or added dependencies. A trigger's `current` value is captured before the callback, while a self-write is reported separately as `afterCallback`. Reads after an asynchronous boundary are absent for the same reason Svelte does not track them. Cleanup functions are wrapped only when application code returns one; cleanup duration, outcome, and count are retained without promoting cleanup reads into the next run's graph.

Explicit nested user effects receive independent records. When Svelte exposes a parent reaction and that reaction is already registered, the record links it through `parentEffectId`. The scheduling boundary created by `$effect.root` is not itself a `user_effect` record, so the root wrapper is not shown as a run; explicit `$effect` and `$effect.pre` callbacks created beneath it still can be shown.

## Sessions and replay

Each document creates a random `sessionId`. The isolated bridge assigns an increasing `seq` to page events and retains at most 256 frames under an 8 MiB ceiling. A panel reconnects with its last `{ sessionId, seq }`, ingests missing frames, and acknowledges the durable cursor. The MV3 worker owns no authoritative data and can be terminated at any time.

When the ring cannot satisfy a cursor, the panel receives an explicit `gap`; it never displays an apparently gapless trace with silently missing frames.

## Capture lifecycle

The MAIN-world hook is installed at `document_start`, but heavy capture is off by default. The panel explicitly enables recording while visible. When hidden, paused, disconnected, or destroyed, the runtime stops observers and interaction listeners; if the app is rewound, it first makes a best-effort return to the saved live baseline. Explicit snapshots remain available as one-shot requests.

While idle, the optional compiler enhancer can still register component descriptors and effect sites during their synchronous render boundary. Effect, cleanup, and error counters continue to advance, but dependencies and trace receipts are not captured. This preserves mounted-instance identity and honest totals without continuously reading state, scanning the document, or retaining checkpoints. Total versus captured-run counts expose omitted or synchronously overlapped runs. When recording resumes, the hook samples the then-current graph as a fresh baseline; later `before` previews are relative to that point and do not pretend to explain changes or runs that occurred while capture was off. A receipt uses `capture-gap` when an exact baseline cannot be established safely, including overlapping synchronous finalization.

Detailed effect recording deliberately does not enable Svelte's development tracing flag because Svelte exposes no inverse operation and the flag adds stack capture to every state write until reload. Lens derives why-rerun evidence from bounded dependency identity, write versions, and value previews; user-authored `$inspect.trace` remains untouched.

## Security and performance

- The page hook is a fixed, local IIFE registered in the MAIN world at `document_start`.
- No remote code, `eval`, page-provided script URLs, or privileged page-originated fetches.
- Page messages are treated as spoofable input and schema-validated before Chrome messaging.
- Values are serialized with depth, item, string, and message bounds.
- Live application objects and writable closures remain in the inspected page.
- Mutation scans and highlighter geometry are animation-frame/microtask coalesced.
- Regular snapshots never read layout geometry; only picker/highlight operations call `getClientRects()`.
- Component descriptors are released through public `onDestroy`; failed initialization uses an explicit abort path, and stale DOM references are weak or pruned.
- Effect dependency values use the same bounded preview serializer; live signal and reaction objects never cross the page boundary.
- Rune-object snapshots contain metadata only. Explicit inspection reads at most 64 compiler-known fields under one 2,000-node/250,000-character budget; the registry is capped at 1,000 weakly held instances.
- Checkpoints are evicted oldest-first after 12 per component, 256 per page, 16 MiB total, or 100,000 retained nodes. Each checkpoint has independent 512 KiB / 2,000-entry / 2,000-node limits, so leaving DevTools open cannot grow history without bound.
- Dependency traversal reads only a bounded prefix and retains at most 60 graph nodes. Runtime capacity is 200 effects per component and 1,000 per page. Snapshot and trace compaction preserve totals, source identity, errors, and omission flags so bounds cannot appear as complete evidence.
- Direct proxy objects and arrays are restored by mutating the existing proxy identity. Compiler-optimized direct primitives and `$state.raw` values, and non-plain direct values, are marked read-only rather than reporting a successful replacement that cannot notify existing subscribers.

## Stability boundary

`__svelte_meta`, the compiled internal call spelling, and the dev reaction fields used for effect graphs are development internals, not public Svelte APIs. All are feature-detected, shape-guarded, and isolated. Exact effect graph capture is enabled for Svelte 5.39 or newer development output; an unsupported version or changed private shape degrades to unavailable dependency detail instead of throwing into the host application. Transform tests compile representative Svelte 5 components so changes in compiler output fail close to the adapter.

The Vite enhancer transforms `.svelte` components plus named rune-bearing classes in `.svelte.ts` and `.svelte.js`. All passes share the same fail-closed dev-server gate; production and preview builds remain untouched.
