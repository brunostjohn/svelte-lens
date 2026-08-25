# Architecture

```text
Svelte 5 development page
  └─ MAIN-world page-hook.js
       ├─ reads element.__svelte_meta
       ├─ optional window.__SVELTE_LENS__ enhancer API
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

It is not a component lifecycle/state protocol. The Vite enhancer establishes that missing seam explicitly. It inserts descriptor closures in source while local variables remain in lexical scope, and marks the compiled `$.pop(...)` boundary so the MAIN-world hook can associate synchronous DOM metadata with the correct component instance.

The page hook is the only layer allowed to know either shape. The transport and panel consume normalized protocol records.

## Sessions and replay

Each document creates a random `sessionId`. The isolated bridge assigns an increasing `seq` to page events and retains the most recent 256 frames. A panel reconnects with its last `{ sessionId, seq }`, ingests missing frames, and acknowledges the durable cursor. The MV3 worker owns no authoritative data and can be terminated at any time.

When the ring cannot satisfy a cursor, the panel receives an explicit `gap`; it never displays an apparently gapless trace with silently missing frames.

## Capture lifecycle

The MAIN-world hook is installed at `document_start`, but heavy capture is off by default. The panel explicitly enables recording while visible. When hidden, paused, disconnected, or destroyed, the runtime stops observers and interaction listeners; if the app is rewound, it first makes a best-effort return to the saved live baseline. Explicit snapshots remain available as one-shot requests.

While idle, the optional compiler enhancer can still register component descriptors during their synchronous render boundary. This preserves mounted-instance identity without continuously reading state, scanning the document, or retaining checkpoints.

## Security and performance

- The page hook is a fixed, local IIFE registered in the MAIN world at `document_start`.
- No remote code, `eval`, page-provided script URLs, or privileged page-originated fetches.
- Page messages are treated as spoofable input and schema-validated before Chrome messaging.
- Values are serialized with depth, item, string, and message bounds.
- Live application objects and writable closures remain in the inspected page.
- Mutation scans and highlighter geometry are animation-frame/microtask coalesced.
- Regular snapshots never read layout geometry; only picker/highlight operations call `getClientRects()`.
- Component descriptors are released on `onDestroy`; stale DOM references are weak or pruned.

## Stability boundary

`__svelte_meta` and the compiled internal call spelling are development internals, not public Svelte APIs. Both are feature-detected and isolated. Unsupported shapes degrade to a visible state instead of throwing into the host application. Transform tests compile representative Svelte 5 components so changes in compiler output fail close to the adapter.
