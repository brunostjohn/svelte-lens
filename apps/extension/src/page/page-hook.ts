import {
  isContentToPageMessage,
  pageMessage,
  type JsonValue,
  type LensRect,
  type PageCommand,
  type PageEvent,
  type SnapshotNode,
  type SourceLocation,
  type TimeTravelFailure,
  type TraceRecord
} from '../shared/protocol';

const PAGE_HOOK_KEY = Symbol.for('svelte-lens.page-hook.v1');
const MAX_COMPONENTS = 5_000;
const MAX_ELEMENTS = 12_000;
const MAX_TRACE_HISTORY = 1_000;
const MAX_TRACE_BATCH = 256;
const MAX_CHECKPOINTS = 40;
const MAX_RECTS = 64;
const MAX_PREVIEW_DEPTH = 5;
const MAX_PREVIEW_ITEMS = 80;
const MAX_PREVIEW_STRING = 4_096;
const MAX_CLONE_DEPTH = 64;
const MAX_CLONE_NODES = 5_000;
const MAX_STACK_DEPTH = 100;
const MAX_SNAPSHOT_JSON_NODES = 50_000;
const MAX_SNAPSHOT_JSON_CHARS = 1_000_000;
const MAX_SNAPSHOT_NODE_JSON_NODES = 4_000;
const MAX_SNAPSHOT_NODE_JSON_CHARS = 80_000;
const DANGEROUS_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface DevStackEntry {
  file: string;
  type: 'component' | 'if' | 'each' | 'await' | 'key' | 'render';
  line: number;
  column: number;
  parent: DevStackEntry | null;
  componentTag?: string;
}

interface SvelteElementMeta {
  parent: DevStackEntry | null;
  loc: SourceLocation;
}

interface StateAdapter {
  get(): unknown;
  set?: (value: unknown) => void;
}

interface ReadAdapter {
  get(): unknown;
}

interface ComponentDescriptor {
  name: string;
  file: string;
  props(): Record<string, unknown>;
  state: Record<string, StateAdapter>;
  derived: Record<string, ReadAdapter>;
}

interface SvelteLensHook {
  beginComponent(descriptor: ComponentDescriptor): string | null;
  endComponent(id: string | null): void;
  updateComponent(id: string | null, phase?: 'init' | 'update'): void;
  unregisterComponent(id: string | null): void;
}

interface StoredValue {
  value: unknown;
  restorable: boolean;
  reason?: string;
}

interface StoredState {
  values: Map<string, StoredValue>;
  restorable: boolean;
  reason?: string;
}

interface Checkpoint extends StoredState {
  id: string;
  at: number;
  cursor: number;
  phase: 'init' | 'update' | 'set-value' | 'live';
  changes: string[];
}

interface ComponentRecord {
  id: string;
  descriptor: ComponentDescriptor;
  parentId: string | null;
  mountOrdinal: number;
  mountedAt: number;
  ended: boolean;
  mountTraced: boolean;
  updateCount: number;
  invocationEntry: DevStackEntry | null;
  elements: Set<Element>;
  bounds: Set<Element>;
  checkpoints: Checkpoint[];
  lastPreview: Map<string, string>;
}

interface CloneResult {
  ok: boolean;
  value: unknown;
  reason?: string;
}

interface CloneBudget {
  nodes: number;
  seen: Map<object, unknown>;
}

interface PreviewBudget {
  nodes: number;
  seen: Map<object, number>;
  nextRef: number;
}

interface EntryGroup {
  entry: DevStackEntry;
  elements: Element[];
  firstDomIndex: number;
}

interface Overlay {
  host: HTMLDivElement;
  boxes: HTMLDivElement[];
  label: HTMLDivElement;
}

interface RuntimeSentinel {
  hook: SvelteLensHook;
  reconnect(): void;
  destroy(): void;
}

declare global {
  // The compiler adapter intentionally calls this optional global directly.
  // eslint-disable-next-line no-var
  var __SVELTE_LENS__: SvelteLensHook | undefined;

  interface Window {
    __svelte?: {
      v?: Set<string>;
      h?: unknown;
      uid?: number;
    };
  }

  interface Element {
    __svelte_meta?: SvelteElementMeta | null;
  }
}

bootstrap();

function bootstrap(): void {
  const host = globalThis as typeof globalThis & { [PAGE_HOOK_KEY]?: RuntimeSentinel };
  const existing = host[PAGE_HOOK_KEY];
  if (existing) {
    existing.reconnect();
    return;
  }

  const sessionId = createSessionId();
  const pageWindow = window;
  const NodeCtor = window.Node;
  const ElementCtor = window.Element;
  const ShadowRootCtor = window.ShadowRoot;
  const KeyboardEventCtor = window.KeyboardEvent;
  const components = new Map<string, ComponentRecord>();
  const activeComponents: string[] = [];
  const trackedElements = new Set<Element>();
  const elementIds = new WeakMap<Element, string>();
  const elementOwners = new WeakMap<Element, string>();
  const entryIds = new WeakMap<DevStackEntry, string>();
  const entryOwners = new WeakMap<DevStackEntry, string>();
  const entryParentHints = new WeakMap<DevStackEntry, string | null>();
  const fallbackElements = new Map<string, Set<Element>>();
  const observedRoots = new Set<Document | ShadowRoot>([document]);
  const traceHistory: TraceRecord[] = [];
  const traceBatch: TraceRecord[] = [];
  const liveBaselines = new Map<string, StoredState>();

  let componentCounter = 0;
  let elementCounter = 0;
  let entryCounter = 0;
  let traceCounter = 0;
  let checkpointCounter = 0;
  let timelineCursor = 0;
  let snapshotRevision = 0;
  let connected = false;
  let recording = false;
  let pickerActive = false;
  let timelineMode: 'live' | 'travel' | 'restoring' = 'live';
  let selectedHighlight: string | null = null;
  let recentCause: { id: string; at: number } | null = null;
  let traceFlushQueued = false;
  let reconcileQueued = false;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHelloSignature = '';
  let overlay: Overlay | null = null;
  let overlayRepaintFrame: number | null = null;
  let pickerFrame: number | null = null;
  let pendingPickerElement: Element | null = null;
  let lastPickerId: string | null = null;
  let lastPickerRectsKey: string | null = null;
  let previousCursor: { value: string; priority: string } | null = null;
  let needsFullScan = true;
  let observerRecording = false;
  let observerStarted = false;
  let interactionListenersAttached = false;
  let pickerListenersAttached = false;

  const hook: SvelteLensHook = {
    beginComponent,
    endComponent,
    updateComponent,
    unregisterComponent
  };

  const sentinel: RuntimeSentinel = {
    hook,
    reconnect() {
      emitHello(true);
      if (recording) emitSnapshot();
    },
    destroy() {
      if (timelineMode !== 'live') restoreLiveState();
      observer.disconnect();
      pageWindow.removeEventListener('message', onMessage);
      pageWindow.removeEventListener('pointermove', onPickerPointerMove, true);
      pageWindow.removeEventListener('click', onPickerClick, true);
      pageWindow.removeEventListener('keydown', onPickerKeyDown, true);
      pageWindow.removeEventListener('click', onInteraction, true);
      pageWindow.removeEventListener('input', onInteraction, true);
      pageWindow.removeEventListener('change', onInteraction, true);
      pageWindow.removeEventListener('keydown', onInteraction, true);
      pageWindow.removeEventListener('scroll', onViewportChange, true);
      pageWindow.removeEventListener('resize', onViewportChange);
      if (overlayRepaintFrame !== null) pageWindow.cancelAnimationFrame(overlayRepaintFrame);
      if (pickerFrame !== null) pageWindow.cancelAnimationFrame(pickerFrame);
      if (snapshotTimer) clearTimeout(snapshotTimer);
      restoreCursor();
      overlay?.host.remove();
      if (host[PAGE_HOOK_KEY] === sentinel) delete host[PAGE_HOOK_KEY];
      if (globalThis.__SVELTE_LENS__ === hook) delete globalThis.__SVELTE_LENS__;
    }
  };

  host[PAGE_HOOK_KEY] = sentinel;
  Object.defineProperty(globalThis, '__SVELTE_LENS__', {
    configurable: true,
    enumerable: false,
    value: hook,
    writable: true
  });

  window.addEventListener('message', onMessage);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);

  const observer = new MutationObserver(onMutations);

  // The content script also sends `connect`; this is useful when it was already listening.
  emitHello(true);

  function beginComponent(candidate: ComponentDescriptor): string | null {
    try {
      if (!isDescriptor(candidate) || components.size >= MAX_COMPONENTS) return null;
      ensureObserver(recording);
      const activeParentId = findActiveParent();
      drainPendingMutations(activeParentId ? components.get(activeParentId) : undefined);
      const id = `cmp:${sessionId.slice(0, 8)}:${++componentCounter}`;
      const parentId = findActiveParent();
      const record: ComponentRecord = {
        id,
        descriptor: candidate,
        parentId,
        mountOrdinal: componentCounter,
        mountedAt: performance.now(),
        ended: false,
        mountTraced: false,
        updateCount: 0,
        invocationEntry: null,
        elements: new Set(),
        bounds: new Set(),
        checkpoints: [],
        lastPreview: new Map()
      };
      components.set(id, record);
      activeComponents.push(id);
      if (recording) {
        scheduleReconcile();
        scheduleSnapshot();
      }
      emitHello();
      return id;
    } catch {
      return null;
    }
  }

  function endComponent(id: string | null): void {
    if (!id) return;
    const record = components.get(id);
    if (!record) return;
    record.ended = true;
    if (!drainPendingMutations(record)) {
      // Hydration adds metadata to existing nodes and therefore has no child-list mutation.
      needsFullScan = true;
    }
    const stackIndex = activeComponents.lastIndexOf(id);
    if (stackIndex !== -1) activeComponents.splice(stackIndex, 1);
    if (!record.mountTraced) {
      record.mountTraced = true;
      const checkpoint = recording && hasWritableState(record)
        ? (record.checkpoints.at(-1) ?? captureCheckpoint(record, 'init'))
        : null;
      pushTrace('mount', id, checkpointTraceDetail('init', checkpoint));
    }
    if (recording) {
      scheduleReconcile();
      scheduleSnapshot();
    } else if (activeComponents.length === 0) {
      stopObserver();
    }
  }

  function updateComponent(id: string | null, phase: 'init' | 'update' = 'update'): void {
    if (!id) return;
    const record = components.get(id);
    if (!record) return;
    if (!recording) return;
    if (phase === 'update') record.updateCount++;

    const checkpoint = timelineMode === 'live' && hasWritableState(record)
      ? captureCheckpoint(record, phase)
      : null;
    const detail = checkpointTraceDetail(phase, checkpoint);
    if (phase === 'init' && !record.mountTraced) {
      record.mountTraced = true;
      pushTrace('mount', id, detail);
    } else {
      pushTrace('update', id, detail);
    }
    if (recording) {
      scheduleReconcile();
      scheduleSnapshot();
    }
  }

  function checkpointTraceDetail(phase: string, checkpoint: Checkpoint | null): JsonValue {
    const detail: Record<string, JsonValue> = {
      phase,
      restorable: checkpoint?.restorable ?? false
    };
    if (checkpoint) {
      detail.checkpointId = checkpoint.id;
      detail.cursor = checkpoint.cursor;
      detail.changes = checkpoint.changes;
    }
    return detail;
  }

  function unregisterComponent(id: string | null): void {
    if (!id) return;
    const record = components.get(id);
    if (!record) return;
    pushTrace('unmount', id, {
      lifetimeMs: Math.max(0, performance.now() - record.mountedAt),
      updateCount: record.updateCount
    });
    components.delete(id);
    if (timelineMode === 'live') liveBaselines.delete(id);
    if (record.invocationEntry && entryOwners.get(record.invocationEntry) === id) {
      entryParentHints.set(record.invocationEntry, record.parentId);
      entryOwners.delete(record.invocationEntry);
    }
    const stackIndex = activeComponents.lastIndexOf(id);
    if (stackIndex !== -1) activeComponents.splice(stackIndex, 1);
    for (const element of record.elements) {
      if (elementOwners.get(element) === id) elementOwners.delete(element);
    }
    if (selectedHighlight === id) clearHighlight();
    if (recording) {
      scheduleReconcile();
      scheduleSnapshot();
    }
    emitHello();
  }

  function findActiveParent(): string | null {
    for (let index = activeComponents.length - 1; index >= 0; index--) {
      const id = activeComponents[index];
      if (id && components.has(id)) return id;
    }
    return null;
  }

  function drainPendingMutations(owner?: ComponentRecord): boolean {
    if (!observerStarted) return false;
    const pending = observer.takeRecords();
    if (pending.length === 0) return false;
    if (owner) claimElementsFromMutations(owner, pending);
    onMutations(pending);
    return true;
  }

  function onMessage(event: MessageEvent<unknown>): void {
    if (event.source !== window || !isContentToPageMessage(event.data)) return;
    if (event.data.sessionId !== null && event.data.sessionId !== sessionId) return;
    const command = event.data.command;
    if (command.kind === 'connect') {
      const wasConnected = connected;
      connected = true;
      emitHello(true);
      if (recording) emitSnapshot();
      if (!wasConnected && traceHistory.length > 0) {
        send({ type: 'trace', payload: { events: traceHistory.slice(-MAX_TRACE_BATCH) } });
        traceBatch.length = 0;
      }
      return;
    }
    handleCommand(command);
  }

  function handleCommand(command: PageCommand): void {
    switch (command.kind) {
      case 'connect':
        return;
      case 'snapshot':
        emitSnapshot(command.requestId);
        return;
      case 'record':
        if (!command.enabled && timelineMode !== 'live') {
          const restored = restoreLiveState();
          pushTrace('time-travel', undefined, {
            action: 'auto-live',
            applied: restored.applied,
            failures: normalizeFailures(restored.failures).map((failure) => ({
              componentId: failure.componentId,
              reason: failure.reason
            }))
          });
        }
        if (recording === command.enabled) return;
        recording = command.enabled;
        setInteractionListeners(recording);
        if (recording) {
          ensureObserver(true);
          needsFullScan = true;
          for (const record of components.values()) {
            const checkpoint = hasWritableState(record) ? captureCheckpoint(record, 'init') : null;
            pushTrace('mount', record.id, checkpointTraceDetail('baseline', checkpoint));
          }
          scheduleReconcile();
          scheduleSnapshot();
        } else {
          traceBatch.length = 0;
          stopObserver();
        }
        return;
      case 'picker':
        if (command.action === 'start') startPicker();
        else stopPicker(true);
        return;
      case 'highlight':
        highlightComponent(command.componentId, command.reveal ?? false);
        return;
      case 'set-value':
        setValue(command);
        return;
      case 'time-travel':
        timeTravel(command);
        return;
    }
  }

  function send(event: PageEvent): void {
    if (!connected && event.type !== 'hello') return;
    try {
      window.postMessage(pageMessage(sessionId, event), '*');
    } catch {
      // A page can disappear between a callback and the postMessage call.
    }
  }

  function emitHello(force = false): void {
    const metadata = hasSvelteMetadata();
    const enhanced = components.size > 0;
    const state = Array.from(components.values()).some(
      (record) => Object.keys(record.descriptor.state).length > 0
    );
    const timeTravel = Array.from(components.values()).some(hasWritableState);
    const svelteVersion = readSvelteVersion();
    const mode = metadata || enhanced
      ? 'dev'
      : svelteVersion && document.readyState === 'complete'
        ? 'production'
        : 'unknown';
    const payload = {
      svelteVersion,
      mode,
      capabilities: {
        inspect: metadata || enhanced,
        picker: metadata || enhanced,
        trace: metadata || enhanced,
        state,
        timeTravel
      }
    } as const;
    const signature = JSON.stringify(payload);
    if (!force && signature === lastHelloSignature) return;
    lastHelloSignature = signature;
    send({ type: 'hello', payload });
  }

  function readSvelteVersion(): string | null {
    try {
      const versions = window.__svelte?.v;
      if (!versions || versions.size === 0) return null;
      return Array.from(versions).sort().join(',');
    } catch {
      return null;
    }
  }

  function hasSvelteMetadata(): boolean {
    for (const element of trackedElements) {
      if (readMeta(element)) return true;
    }
    try {
      const first = document.querySelector('*');
      return Boolean(first && readMeta(first));
    } catch {
      return false;
    }
  }

  function emitSnapshot(requestId?: string): void {
    if (requestId !== undefined) needsFullScan = true;
    reconcileDom();
    const nodes = buildSnapshotNodes();
    const payload = {
      revision: ++snapshotRevision,
      capturedAt: Date.now(),
      nodes
    } as {
      requestId?: string;
      revision: number;
      capturedAt: number;
      nodes: SnapshotNode[];
    };
    if (requestId !== undefined) payload.requestId = requestId;
    send({ type: 'snapshot', payload });
  }

  function scheduleSnapshot(): void {
    if (!recording || !connected || snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      emitSnapshot();
    }, 50);
  }

  function scheduleReconcile(): void {
    if (reconcileQueued) return;
    reconcileQueued = true;
    queueMicrotask(() => {
      reconcileQueued = false;
      reconcileDom();
      emitHello();
    });
  }

  function reconcileDom(): void {
    discoverAnnotatedElements();
    const ordered = Array.from(trackedElements).filter((element) => element.isConnected && readMeta(element));
    const domIndex = new Map<Element, number>();
    ordered.forEach((element, index) => domIndex.set(element, index));

    const groups = new Map<DevStackEntry, EntryGroup>();
    for (const element of ordered) {
      const meta = readMeta(element);
      if (!meta) continue;
      for (const entry of innerStackChain(meta.parent)) {
        let group = groups.get(entry);
        if (!group) {
          group = { entry, elements: [], firstDomIndex: domIndex.get(element) ?? 0 };
          groups.set(entry, group);
        }
        group.elements.push(element);
      }
    }

    inferDelayedComponentParents(ordered, groups);
    matchInvocationEntries(groups);
    for (const record of components.values()) {
      record.elements.clear();
      record.bounds.clear();
    }
    for (const element of ordered) {
      const owner = resolveEnhancedOwnerFromMeta(element);
      if (owner && components.has(owner)) {
        elementOwners.set(element, owner);
        components.get(owner)?.elements.add(element);
        addElementBounds(owner, element);
      } else {
        elementOwners.delete(element);
      }
    }

    for (const record of components.values()) {
      if (!record.invocationEntry) continue;
      const inferredParent = nearestOwnedParent(record.invocationEntry.parent, record.id);
      if (inferredParent) record.parentId = inferredParent;
    }

    if (selectedHighlight) renderHighlight(selectedHighlight);
  }

  function discoverAnnotatedElements(): void {
    pruneTrackedElements();
    if (!needsFullScan) return;
    needsFullScan = false;
    try {
      scanRoot(document);
    } catch {
      // Cross-origin embedded documents are not traversed; this runtime owns only this frame.
    }
  }

  function scanRoot(root: Document | ShadowRoot): void {
    observedRoots.add(root);
    const all = root.querySelectorAll('*');
    for (let index = 0; index < all.length && trackedElements.size < MAX_ELEMENTS; index++) {
      const element = all[index];
      if (!element) continue;
      if (isOverlayNode(element)) continue;
      if (readMeta(element)) trackedElements.add(element);
      const shadow = element.shadowRoot;
      if (shadow && !observedRoots.has(shadow)) {
        observeRoot(shadow);
        scanRoot(shadow);
      }
    }
  }

  function pruneTrackedElements(): void {
    for (const element of trackedElements) {
      if (!element.isConnected) trackedElements.delete(element);
    }
  }

  function inferDelayedComponentParents(
    ordered: Element[],
    groups: Map<DevStackEntry, EntryGroup>
  ): void {
    const claimedByRecord = new Map<string, Element[]>();
    for (const element of ordered) {
      const owner = elementOwners.get(element);
      if (!owner || !components.has(owner)) continue;
      const claimed = claimedByRecord.get(owner);
      if (claimed) claimed.push(element);
      else claimedByRecord.set(owner, [element]);
    }

    for (const record of components.values()) {
      if (record.parentId !== null || record.invocationEntry) continue;
      const claimed = claimedByRecord.get(record.id);
      if (!claimed || claimed.length === 0) continue;

      const possibleGroups = Array.from(groups.values()).filter((group) =>
        group.entry.type === 'component' &&
        !entryOwners.has(group.entry) &&
        group.elements.some((element) => elementOwners.get(element) === record.id) &&
        entryMatchesRecord(group, record)
      );
      const taggedGroups = possibleGroups.filter((group) =>
        simpleName(group.entry.componentTag ?? '') === simpleName(record.descriptor.name)
      );
      const invocationGroups = taggedGroups.length > 0 ? taggedGroups : possibleGroups;
      if (invocationGroups.length === 0) continue;

      let inferredParent: string | null = null;
      let conflictingParents = false;
      for (const element of claimed) {
        const ancestor = nearestEnhancedDomAncestor(element, record.id);
        if (!ancestor) continue;
        if (inferredParent && inferredParent !== ancestor) {
          conflictingParents = true;
          break;
        }
        inferredParent = ancestor;
      }
      if (inferredParent && !conflictingParents) {
        const parent = components.get(inferredParent);
        const corroborated = parent && invocationGroups.some((group) =>
          normalizeFile(group.entry.file) === normalizeFile(parent.descriptor.file)
        );
        if (corroborated && !wouldCreateComponentCycle(record.id, inferredParent)) {
          record.parentId = inferredParent;
          continue;
        }
      }
      if (conflictingParents) continue;

      const stackParents = new Set<string>();
      for (const group of invocationGroups) {
        const parentId = nearestOwnedParent(group.entry.parent, record.id);
        if (parentId && !wouldCreateComponentCycle(record.id, parentId)) stackParents.add(parentId);
      }
      if (stackParents.size === 1) {
        record.parentId = stackParents.values().next().value ?? null;
        continue;
      }
      if (stackParents.size > 1) continue;

      const callerParents = new Set<string>();
      let ambiguousCaller = false;
      for (const group of invocationGroups) {
        const callerFile = normalizeFile(group.entry.file);
        const matches = Array.from(components.values()).filter((candidate) =>
          candidate.id !== record.id &&
          candidate.mountOrdinal < record.mountOrdinal &&
          normalizeFile(candidate.descriptor.file) === callerFile &&
          !wouldCreateComponentCycle(record.id, candidate.id)
        );
        if (matches.length === 1 && matches[0]) callerParents.add(matches[0].id);
        else if (matches.length > 1) ambiguousCaller = true;
      }
      if (!ambiguousCaller && callerParents.size === 1) {
        record.parentId = callerParents.values().next().value ?? null;
      }
    }
  }

  function nearestEnhancedDomAncestor(element: Element, selfId: string): string | null {
    let current = parentElementAcrossShadow(element);
    const seen = new Set<Element>();
    while (current && seen.size < MAX_STACK_DEPTH && !seen.has(current)) {
      seen.add(current);
      const owner = elementOwners.get(current);
      if (owner && owner !== selfId && components.has(owner)) return owner;
      current = parentElementAcrossShadow(current);
    }
    return null;
  }

  function parentElementAcrossShadow(element: Element): Element | null {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRootCtor ? root.host : null;
  }

  function wouldCreateComponentCycle(recordId: string, parentId: string): boolean {
    const seen = new Set<string>();
    let currentId: string | null = parentId;
    while (currentId && seen.size < MAX_STACK_DEPTH && !seen.has(currentId)) {
      if (currentId === recordId) return true;
      seen.add(currentId);
      currentId = components.get(currentId)?.parentId ?? null;
    }
    return false;
  }

  function matchInvocationEntries(groups: Map<DevStackEntry, EntryGroup>): void {
    const candidates = Array.from(groups.values())
      .filter((group) => group.entry.type === 'component' && !entryOwners.has(group.entry))
      .sort((a, b) => a.firstDomIndex - b.firstDomIndex);

    const unmatched = Array.from(components.values())
      .filter((record) => !record.invocationEntry)
      .sort((a, b) => {
        const rootOrder = Number(a.parentId === null) - Number(b.parentId === null);
        return rootOrder || a.mountOrdinal - b.mountOrdinal;
      });

    // HMR recreates a component outside the original begin/end parent stack while
    // retaining Svelte's DevStackEntry object. Reclaim hinted entries first and
    // prefer the newest plausible replacement so a same-file root cannot steal a
    // recursive child's invocation entry.
    for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex--) {
      const group = candidates[candidateIndex];
      if (!group) continue;
      const parentHint = entryParentHints.get(group.entry);
      if (!parentHint || !components.has(parentHint)) continue;
      const matches = unmatched
        .filter((record) =>
          record.id !== parentHint &&
          (record.parentId === parentHint || record.parentId === null) &&
          entryMatchesRecord(group, record)
        )
        .sort((a, b) => {
          const parentOrder = Number(a.parentId !== parentHint) - Number(b.parentId !== parentHint);
          return parentOrder || b.mountOrdinal - a.mountOrdinal;
        });
      const replacement = matches[0];
      if (!replacement) continue;
      replacement.invocationEntry = group.entry;
      replacement.parentId = parentHint;
      entryOwners.set(group.entry, replacement.id);
      candidates.splice(candidateIndex, 1);
      const unmatchedIndex = unmatched.indexOf(replacement);
      if (unmatchedIndex !== -1) unmatched.splice(unmatchedIndex, 1);
    }

    for (const record of unmatched) {
      // Normal mount roots have no component invocation entry. Nested instances
      // are parented synchronously; HMR roots are handled by the hint pass above.
      if (record.parentId === null) continue;
      let matchIndex = -1;
      for (let index = 0; index < candidates.length; index++) {
        const group = candidates[index];
        if (!group || !entryMatchesRecord(group, record)) continue;
        matchIndex = index;
        break;
      }
      if (matchIndex === -1) continue;
      const [matched] = candidates.splice(matchIndex, 1);
      if (!matched) continue;
      record.invocationEntry = matched.entry;
      entryOwners.set(matched.entry, record.id);
      const parentHint = entryParentHints.get(matched.entry);
      if (!record.parentId && parentHint && components.has(parentHint)) record.parentId = parentHint;
    }
  }

  function entryMatchesRecord(group: EntryGroup, record: ComponentRecord): boolean {
    const normalizedFile = normalizeFile(record.descriptor.file);
    const containsOwnFile = group.elements.some((element) => {
      const file = readMeta(element)?.loc.file;
      return file ? normalizeFile(file) === normalizedFile : false;
    });
    const tagMatches = simpleName(group.entry.componentTag ?? '') === simpleName(record.descriptor.name);
    if (!containsOwnFile && !tagMatches) return false;

    // The call-site tag may be an import alias; file identity and invocation order are authoritative.

    if (!record.parentId) return true;
    const parent = components.get(record.parentId);
    if (!parent?.invocationEntry) return true;
    return entryChainContains(group.entry.parent, parent.invocationEntry);
  }

  function resolveEnhancedOwnerFromMeta(element: Element): string | null {
    for (const entry of innerStackChain(readMeta(element)?.parent ?? null)) {
      const owner = entryOwners.get(entry);
      if (owner && components.has(owner)) return owner;
    }

    const file = readMeta(element)?.loc.file;
    if (!file) return null;
    const claimed = elementOwners.get(element);
    if (claimed) {
      const record = components.get(claimed);
      if (record && normalizeFile(record.descriptor.file) === normalizeFile(file)) return claimed;
    }
    const roots = Array.from(components.values()).filter(
      (record) => !record.parentId && normalizeFile(record.descriptor.file) === normalizeFile(file)
    );
    return roots[0]?.id ?? null;
  }

  function addElementBounds(ownerId: string, element: Element): void {
    const seen = new Set<string>();
    let currentId: string | null = ownerId;
    while (currentId && seen.size < MAX_STACK_DEPTH && !seen.has(currentId)) {
      seen.add(currentId);
      const record = components.get(currentId);
      if (!record) break;
      record.bounds.add(element);
      currentId = record.parentId;
    }
  }

  function nearestOwnedParent(entry: DevStackEntry | null, childId: string): string | null {
    for (const current of innerStackChain(entry)) {
      const owner = entryOwners.get(current);
      if (owner && owner !== childId && components.has(owner)) return owner;
    }
    return null;
  }

  function entryChainContains(entry: DevStackEntry | null, expected: DevStackEntry): boolean {
    for (const current of innerStackChain(entry)) {
      if (current === expected) return true;
    }
    return false;
  }

  function buildSnapshotNodes(): SnapshotNode[] {
    fallbackElements.clear();
    const nodes: SnapshotNode[] = [];
    const nodeIds = new Set<string>();
    const records = Array.from(components.values()).sort((a, b) => a.mountOrdinal - b.mountOrdinal);

    for (const record of records) {
      const props = readRecord(record.descriptor.props);
      const state = readAdapters(record.descriptor.state);
      const derived = readAdapters(record.descriptor.derived);
      const latest = record.checkpoints.at(-1);
      const source = componentSource(record);
      const detail: Record<string, JsonValue> = {
        enhanced: true,
        domCount: connectedElements(record.elements).length,
        updateCount: record.updateCount,
        props,
        state,
        writableState: writableStateDetail(record),
        derived,
        invocation: record.invocationEntry
          ? {
              file: record.invocationEntry.file,
              line: record.invocationEntry.line,
              column: record.invocationEntry.column,
              componentTag: record.invocationEntry.componentTag ?? record.descriptor.name
            }
          : {
              file: record.descriptor.file,
              ordinal: record.mountOrdinal
            },
        checkpoints: record.checkpoints.slice(-20).map((checkpoint) => ({
          id: checkpoint.id,
          at: checkpoint.at,
          cursor: checkpoint.cursor,
          phase: checkpoint.phase,
          changes: checkpoint.changes,
          restorable: checkpoint.restorable
        })),
        timeline: {
          mode: timelineMode,
          latestCheckpointId: latest?.id ?? null,
          latestCursor: latest?.cursor ?? null
        }
      };
      nodes.push(withOptionalSource({
        id: record.id,
        parentId: record.parentId,
        kind: 'component',
        name: record.descriptor.name,
        detail
      }, source));
      nodeIds.add(record.id);
    }

    const elements = Array.from(trackedElements).filter(
      (element) => element.isConnected && Boolean(readMeta(element))
    );
    for (const element of elements) {
      if (nodes.length >= 19_500) break;
      const meta = readMeta(element);
      if (!meta) continue;
      const directOwner = elementOwners.get(element);
      let parentId = directOwner ? rootEnhancedAncestor(directOwner) : null;
      const chain = stackChain(meta.parent);
      for (const entry of chain) {
        const enhancedOwner = entryOwners.get(entry);
        if (enhancedOwner && components.has(enhancedOwner)) {
          parentId = enhancedOwner;
          addFallbackElement(enhancedOwner, element);
          continue;
        }

        const entryId = getEntryId(entry);
        const kind = entry.type === 'component' ? 'component' : 'block';
        if (!nodeIds.has(entryId)) {
          const detail: Record<string, JsonValue> = {
            enhanced: false,
            stackType: entry.type
          };
          if (entry.type === 'component') {
            detail.invocation = {
              file: entry.file,
              line: entry.line,
              column: entry.column,
              componentTag: entry.componentTag ?? 'Component'
            };
          } else if (entry.componentTag) {
            detail.componentTag = entry.componentTag;
          }
          nodes.push({
            id: entryId,
            parentId,
            kind,
            name: entryName(entry),
            source: entry.type === 'component' ? copySource(meta.loc) : sourceFromEntry(entry),
            detail
          });
          nodeIds.add(entryId);
        }
        addFallbackElement(entryId, element);
        parentId = entryId;
      }

      const enhancedOwner = directOwner;
      if (enhancedOwner && components.has(enhancedOwner)) {
        parentId = enhancedOwner;
        addFallbackElement(enhancedOwner, element);
      }

      if (!parentId) {
        const rootId = fallbackRootId(meta.loc.file);
        if (!nodeIds.has(rootId)) {
          nodes.push({
            id: rootId,
            parentId: null,
            kind: 'component',
            name: fileComponentName(meta.loc.file),
            source: { file: meta.loc.file, line: 1, column: 0 },
            detail: { enhanced: false, inferred: 'source-file' }
          });
          nodeIds.add(rootId);
        }
        addFallbackElement(rootId, element);
        parentId = rootId;
      }

      const elementId = getElementId(element);
      if (!nodeIds.has(elementId) && nodes.length < 19_500) {
        nodes.push({
          id: elementId,
          parentId,
          kind: 'element',
          name: element.tagName.toLowerCase(),
          source: copySource(meta.loc),
          detail: elementDetail(element)
        });
        nodeIds.add(elementId);
      }
    }
    return fitSnapshotBudget(nodes);
  }

  function componentSource(record: ComponentRecord): SourceLocation {
    for (const element of record.bounds.size > 0 ? record.bounds : record.elements) {
      const loc = readMeta(element)?.loc;
      if (loc && normalizeFile(loc.file) === normalizeFile(record.descriptor.file)) {
        return copySource(loc);
      }
    }
    return { file: record.descriptor.file, line: 1, column: 0 };
  }

  function withOptionalSource(node: SnapshotNode, source: SourceLocation | null): SnapshotNode {
    if (source) node.source = source;
    return node;
  }

  function readRecord(read: () => Record<string, unknown>): JsonValue {
    try {
      return preview(read());
    } catch (error) {
      return errorPreview(error);
    }
  }

  function readAdapters(adapters: Record<string, ReadAdapter>): JsonValue {
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const [name, adapter] of safeEntries(adapters)) {
      try {
        result[name] = preview(adapter.get());
      } catch (error) {
        result[name] = errorPreview(error);
      }
    }
    return result;
  }

  function writableStateDetail(record: ComponentRecord): JsonValue {
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const [name, adapter] of safeEntries(record.descriptor.state)) {
      result[name] = typeof adapter.set === 'function';
    }
    return result;
  }

  function elementDetail(element: Element): JsonValue {
    const detail: Record<string, JsonValue> = {};
    if (element.id) detail.id = element.id;
    const className = element.getAttribute('class');
    if (className) detail.class = truncate(className, 512);
    const role = element.getAttribute('role');
    if (role) detail.role = truncate(role, 128);
    return detail;
  }

  function stackChain(entry: DevStackEntry | null): DevStackEntry[] {
    return innerStackChain(entry).reverse();
  }

  function innerStackChain(entry: DevStackEntry | null): DevStackEntry[] {
    const chain: DevStackEntry[] = [];
    const seen = new Set<DevStackEntry>();
    let current: unknown = entry;
    while (isDevStackEntry(current) && chain.length < MAX_STACK_DEPTH && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      try {
        current = current.parent;
      } catch {
        break;
      }
    }
    return chain;
  }

  function getEntryId(entry: DevStackEntry): string {
    const existing = entryIds.get(entry);
    if (existing) return existing;
    const id = `meta:${++entryCounter}:${hashString(
      `${entry.file}:${entry.line}:${entry.column}:${entry.type}:${entry.componentTag ?? ''}`
    )}`;
    entryIds.set(entry, id);
    return id;
  }

  function getElementId(element: Element): string {
    const existing = elementIds.get(element);
    if (existing) return existing;
    const id = `el:${++elementCounter}`;
    elementIds.set(element, id);
    return id;
  }

  function addFallbackElement(id: string, element: Element): void {
    let bucket = fallbackElements.get(id);
    if (!bucket) {
      bucket = new Set();
      fallbackElements.set(id, bucket);
    }
    bucket.add(element);
  }

  function fallbackRootId(file: string): string {
    return `source:${hashString(normalizeFile(file))}`;
  }

  function entryName(entry: DevStackEntry): string {
    if (entry.type === 'component') return entry.componentTag || 'Component';
    return `{#${entry.type}}`;
  }

  function sourceFromEntry(entry: DevStackEntry): SourceLocation {
    return { file: entry.file, line: entry.line, column: entry.column };
  }

  function pushTrace(kind: string, componentId?: string, detail?: JsonValue): TraceRecord | null {
    if (!recording) return null;
    const at = Date.now();
    const trace: TraceRecord = {
      id: `trace:${sessionId.slice(0, 8)}:${++traceCounter}`,
      at,
      kind
    };
    if (componentId) trace.componentId = componentId;
    if (recentCause && at - recentCause.at < 1_000 && kind !== 'interaction') {
      trace.causeId = recentCause.id;
    }
    if (detail !== undefined) trace.detail = detail;
    traceHistory.push(trace);
    if (traceHistory.length > MAX_TRACE_HISTORY) {
      traceHistory.splice(0, traceHistory.length - MAX_TRACE_HISTORY);
    }
    traceBatch.push(trace);
    if (traceBatch.length > MAX_TRACE_BATCH) traceBatch.shift();
    queueTraceFlush();
    return trace;
  }

  function queueTraceFlush(): void {
    if (traceFlushQueued) return;
    traceFlushQueued = true;
    queueMicrotask(() => {
      traceFlushQueued = false;
      if (!connected || traceBatch.length === 0) return;
      const events = traceBatch.splice(0, MAX_TRACE_BATCH);
      send({ type: 'trace', payload: { events } });
      if (traceBatch.length > 0) queueTraceFlush();
    });
  }

  function onInteraction(event: Event): void {
    if (!recording || pickerActive || isOverlayEvent(event)) return;
    const element = eventElement(event);
    const componentId = element ? resolveInspectableId(element) : null;
    const detail: Record<string, JsonValue> = { interaction: event.type };
    if (element) detail.target = element.tagName.toLowerCase();
    if (event instanceof KeyboardEventCtor) detail.key = truncate(event.key, 64);
    const trace = pushTrace('interaction', componentId ?? undefined, detail);
    if (trace) recentCause = { id: trace.id, at: trace.at };
  }

  function onMutations(records: MutationRecord[]): void {
    if (!recording) return;
    let added = 0;
    let removed = 0;
    let attributes = 0;
    let text = 0;
    const owners = new Set<string>();

    for (const mutation of records) {
      if (isOverlayNode(mutation.target)) continue;
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (isOverlayNode(node)) continue;
          added += countElements(node);
          discoverFromNode(node);
        }
        for (const node of mutation.removedNodes) {
          if (!isOverlayNode(node)) removed += countElements(node);
        }
      } else if (mutation.type === 'attributes') {
        attributes++;
      } else {
        text++;
      }
      const target = mutation.target instanceof ElementCtor
        ? mutation.target
        : mutation.target.parentElement;
      const owner = target ? resolveInspectableId(target) : null;
      if (owner) owners.add(owner);
    }

    if (added || removed || attributes || text) {
      const componentId = owners.size === 1 ? owners.values().next().value as string : undefined;
      pushTrace('dom', componentId, { added, removed, attributes, text });
      scheduleReconcile();
      scheduleSnapshot();
    }
  }

  function claimElementsFromMutations(
    record: ComponentRecord,
    records: MutationRecord[]
  ): void {
    const file = normalizeFile(record.descriptor.file);
    for (const mutation of records) {
      if (mutation.type !== 'childList') continue;
      for (const node of mutation.addedNodes) {
        if (isOverlayNode(node)) continue;
        for (const element of elementTree(node)) {
          const loc = readMeta(element)?.loc;
          if (!loc || normalizeFile(loc.file) !== file) continue;
          trackedElements.add(element);
          elementOwners.set(element, record.id);
        }
      }
    }
  }

  function elementTree(node: Node): Element[] {
    if (!(node instanceof ElementCtor) || isOverlayNode(node)) return [];
    return [node, ...Array.from(node.querySelectorAll('*'))];
  }

  function discoverFromNode(node: Node): void {
    for (const element of elementTree(node)) {
      if (isOverlayNode(element)) continue;
      if (trackedElements.size < MAX_ELEMENTS && readMeta(element)) trackedElements.add(element);
      const shadow = element.shadowRoot;
      if (shadow && !observedRoots.has(shadow)) {
        observeRoot(shadow);
        scanRoot(shadow);
      }
    }
  }

  function configureObserver(full: boolean): void {
    observer.takeRecords();
    observer.disconnect();
    observerStarted = true;
    observerRecording = full;
    for (const root of observedRoots) observeRoot(root);
  }

  function ensureObserver(full: boolean): void {
    if (!observerStarted || observerRecording !== full) configureObserver(full);
  }

  function stopObserver(): void {
    if (!observerStarted) return;
    observer.takeRecords();
    observer.disconnect();
    observerStarted = false;
    observerRecording = false;
  }

  function observeRoot(root: Document | ShadowRoot): void {
    if (root instanceof ShadowRootCtor && isOverlayNode(root.host)) return;
    observedRoots.add(root);
    if (!observerStarted) return;
    try {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: observerRecording,
        characterData: observerRecording
      });
    } catch {
      observedRoots.delete(root);
    }
  }

  function countElements(node: Node): number {
    if (!(node instanceof ElementCtor)) return 0;
    return 1 + node.querySelectorAll('*').length;
  }

  function startPicker(): void {
    if (pickerActive) return;
    needsFullScan = true;
    reconcileDom();
    pickerActive = true;
    setPickerListeners(true);
    lastPickerId = null;
    lastPickerRectsKey = null;
    const root = document.documentElement;
    if (root) {
      previousCursor = {
        value: root.style.getPropertyValue('cursor'),
        priority: root.style.getPropertyPriority('cursor')
      };
      root.style.setProperty('cursor', 'crosshair', 'important');
    }
  }

  function stopPicker(cancelled: boolean): void {
    pickerActive = false;
    setPickerListeners(false);
    pendingPickerElement = null;
    lastPickerId = null;
    lastPickerRectsKey = null;
    if (pickerFrame !== null) {
      pageWindow.cancelAnimationFrame(pickerFrame);
      pickerFrame = null;
    }
    restoreCursor();
    if (!selectedHighlight) hideOverlay();
    if (cancelled) send({ type: 'picker', payload: { phase: 'cancelled' } });
  }

  function onPickerPointerMove(event: PointerEvent): void {
    if (!pickerActive) return;
    const element = eventElement(event);
    if (!element || isOverlayNode(element)) return;
    pendingPickerElement = element;
    if (pickerFrame !== null) return;
    pickerFrame = pageWindow.requestAnimationFrame(flushPickerPointerMove);
  }

  function flushPickerPointerMove(): void {
    pickerFrame = null;
    if (!pickerActive) return;
    const element = pendingPickerElement;
    pendingPickerElement = null;
    if (!element || !element.isConnected) return;
    const annotated = nearestAnnotatedElement(element);
    if (!annotated) {
      lastPickerId = null;
      lastPickerRectsKey = null;
      hideOverlay();
      return;
    }
    const componentId = resolveInspectableId(annotated);
    const pickerId = componentId ?? getElementId(annotated);
    const elements = componentId ? elementsForId(componentId) : [annotated];
    const meta = readMeta(annotated);
    const label = labelForId(componentId, annotated);
    const rects = rectsForElements(elements);
    const rectsKey = rects.map((rect) => `${rect.top},${rect.left},${rect.width},${rect.height}`).join(';');
    if (pickerId === lastPickerId && rectsKey === lastPickerRectsKey) return;
    lastPickerId = pickerId;
    lastPickerRectsKey = rectsKey;
    showOverlay(elements, label, rects);
    const payload: Extract<PageEvent, { type: 'picker' }>['payload'] = {
      phase: 'hover',
      label,
      rects
    };
    if (componentId) payload.componentId = componentId;
    if (meta) payload.source = copySource(meta.loc);
    send({ type: 'picker', payload });
  }

  function onPickerClick(event: MouseEvent): void {
    if (!pickerActive) return;
    const element = eventElement(event);
    if (!element || isOverlayNode(element)) return;
    const annotated = nearestAnnotatedElement(element);
    if (!annotated) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const componentId = resolveInspectableId(annotated);
    if (componentId) selectedHighlight = componentId;
    const elements = componentId ? elementsForId(componentId) : [annotated];
    const meta = readMeta(annotated);
    const label = labelForId(componentId, annotated);
    const rects = showOverlay(elements, label);
    const payload: Extract<PageEvent, { type: 'picker' }>['payload'] = {
      phase: 'selected',
      label,
      rects
    };
    if (componentId) payload.componentId = componentId;
    if (meta) payload.source = copySource(meta.loc);
    send({ type: 'picker', payload });
    pickerActive = false;
    setPickerListeners(false);
    restoreCursor();
  }

  function onPickerKeyDown(event: KeyboardEvent): void {
    if (!pickerActive || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopPicker(true);
  }

  function highlightComponent(componentId: string | null, reveal: boolean): void {
    if (!componentId) {
      clearHighlight();
      return;
    }
    needsFullScan = true;
    reconcileDom();
    const elements = elementsForId(componentId);
    if (elements.length === 0) {
      clearHighlight();
      return;
    }
    selectedHighlight = componentId;
    if (reveal) elements[0]?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    showOverlay(elements, labelForId(componentId, elements[0] ?? null));
  }

  function renderHighlight(componentId: string): void {
    const elements = elementsForId(componentId);
    if (elements.length === 0) {
      clearHighlight();
      return;
    }
    showOverlay(elements, labelForId(componentId, elements[0] ?? null));
  }

  function onViewportChange(): void {
    if (!selectedHighlight || overlayRepaintFrame !== null) return;
    overlayRepaintFrame = pageWindow.requestAnimationFrame(() => {
      overlayRepaintFrame = null;
      if (selectedHighlight) renderHighlight(selectedHighlight);
    });
  }

  function clearHighlight(): void {
    selectedHighlight = null;
    hideOverlay();
  }

  function restoreCursor(): void {
    const root = document.documentElement;
    if (!root || !previousCursor) return;
    if (previousCursor.value) {
      root.style.setProperty('cursor', previousCursor.value, previousCursor.priority);
    } else {
      root.style.removeProperty('cursor');
    }
    previousCursor = null;
  }

  function setInteractionListeners(enabled: boolean): void {
    if (interactionListenersAttached === enabled) return;
    interactionListenersAttached = enabled;
    if (enabled) {
      pageWindow.addEventListener('click', onInteraction, true);
      pageWindow.addEventListener('input', onInteraction, true);
      pageWindow.addEventListener('change', onInteraction, true);
      pageWindow.addEventListener('keydown', onInteraction, true);
    } else {
      pageWindow.removeEventListener('click', onInteraction, true);
      pageWindow.removeEventListener('input', onInteraction, true);
      pageWindow.removeEventListener('change', onInteraction, true);
      pageWindow.removeEventListener('keydown', onInteraction, true);
    }
  }

  function setPickerListeners(enabled: boolean): void {
    if (pickerListenersAttached === enabled) return;
    pickerListenersAttached = enabled;
    if (enabled) {
      pageWindow.addEventListener('pointermove', onPickerPointerMove, true);
      pageWindow.addEventListener('click', onPickerClick, true);
      pageWindow.addEventListener('keydown', onPickerKeyDown, true);
    } else {
      pageWindow.removeEventListener('pointermove', onPickerPointerMove, true);
      pageWindow.removeEventListener('click', onPickerClick, true);
      pageWindow.removeEventListener('keydown', onPickerKeyDown, true);
    }
  }

  function elementsForId(id: string): Element[] {
    const record = components.get(id);
    if (record) {
      const elements = new Set<Element>(record.bounds);
      for (const element of record.elements) elements.add(element);
      const inferred = fallbackElements.get(id);
      if (inferred) for (const element of inferred) elements.add(element);
      return connectedElements(elements);
    }
    let elements = fallbackElements.get(id);
    if (!elements) {
      buildSnapshotNodes();
      elements = fallbackElements.get(id);
    }
    return elements ? connectedElements(elements) : [];
  }

  function rootEnhancedAncestor(ownerId: string): string | null {
    const seen = new Set<string>();
    let currentId: string | null = ownerId;
    let rootId: string | null = null;
    while (currentId && seen.size < MAX_STACK_DEPTH && !seen.has(currentId)) {
      seen.add(currentId);
      const record = components.get(currentId);
      if (!record) break;
      rootId = currentId;
      currentId = record.parentId;
    }
    const root = rootId ? components.get(rootId) : null;
    return root && !root.invocationEntry ? root.id : null;
  }

  function resolveInspectableId(element: Element): string | null {
    const enhanced = elementOwners.get(element) ?? resolveEnhancedOwnerFromMeta(element);
    if (enhanced && components.has(enhanced)) return enhanced;
    const meta = readMeta(element);
    if (!meta) return null;
    for (const entry of innerStackChain(meta.parent)) {
      if (entry.type === 'component') return getEntryId(entry);
    }
    return fallbackRootId(meta.loc.file);
  }

  function labelForId(id: string | null, element: Element | null): string {
    if (id) {
      const record = components.get(id);
      if (record) return record.descriptor.name;
      for (const tracked of trackedElements) {
        const meta = readMeta(tracked);
        for (const entry of innerStackChain(meta?.parent ?? null)) {
          if (getEntryId(entry) === id) return entryName(entry);
        }
      }
    }
    return element?.tagName.toLowerCase() ?? 'Svelte component';
  }

  function nearestAnnotatedElement(start: Element): Element | null {
    let current: Element | null = start;
    while (current) {
      if (readMeta(current)) return current;
      const root = current.getRootNode();
      current = current.parentElement ?? (root instanceof ShadowRootCtor ? root.host : null);
    }
    return null;
  }

  function showOverlay(
    elements: Element[],
    label: string,
    measuredRects?: LensRect[]
  ): LensRect[] {
    const instance = ensureOverlay();
    const rects = measuredRects ?? rectsForElements(elements);
    while (instance.boxes.length < rects.length) {
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'fixed',
        border: '2px solid #ff3e00',
        background: 'rgba(255, 62, 0, 0.10)',
        boxSizing: 'border-box',
        pointerEvents: 'none'
      });
      instance.host.shadowRoot?.append(box);
      instance.boxes.push(box);
    }
    instance.boxes.forEach((box, index) => {
      const rect = rects[index];
      if (!rect) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.style.top = `${rect.top}px`;
      box.style.left = `${rect.left}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    });
    const anchor = rects[0];
    if (anchor) {
      instance.label.textContent = label;
      instance.label.style.display = 'block';
      instance.label.style.left = `${Math.max(4, Math.min(window.innerWidth - 260, anchor.left))}px`;
      instance.label.style.top = `${Math.max(4, anchor.top - 27)}px`;
    } else {
      instance.label.style.display = 'none';
    }
    return rects;
  }

  function ensureOverlay(): Overlay {
    if (overlay?.host.isConnected) return overlay;
    const host = document.createElement('div');
    host.dataset.svelteLensOverlay = '';
    Object.assign(host.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      zIndex: '2147483647'
    });
    const root = host.attachShadow({ mode: 'open' });
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed',
      display: 'none',
      maxWidth: '256px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      padding: '4px 7px',
      borderRadius: '4px',
      background: '#ff3e00',
      color: '#fff',
      font: '600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      boxShadow: '0 2px 8px rgba(0,0,0,.25)',
      pointerEvents: 'none'
    });
    root.append(label);
    (document.documentElement ?? document).appendChild(host);
    overlay = { host, boxes: [], label };
    return overlay;
  }

  function hideOverlay(): void {
    if (!overlay) return;
    for (const box of overlay.boxes) box.style.display = 'none';
    overlay.label.style.display = 'none';
  }

  function rectsForElements(elements: Iterable<Element>): LensRect[] {
    const rects: LensRect[] = [];
    for (const element of elements) {
      if (!element.isConnected || isOverlayNode(element)) continue;
      try {
        for (const rect of element.getClientRects()) {
          if (rects.length >= MAX_RECTS) return rects;
          if (
            !Number.isFinite(rect.top) ||
            !Number.isFinite(rect.left) ||
            !Number.isFinite(rect.width) ||
            !Number.isFinite(rect.height)
          ) {
            continue;
          }
          if (rect.width <= 0 && rect.height <= 0) continue;
          rects.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        }
      } catch {
        // A page-owned custom element can throw from layout access; skip it.
      }
    }
    return rects;
  }

  function setValue(command: Extract<PageCommand, { kind: 'set-value' }>): void {
    const record = components.get(command.componentId);
    if (!record) {
      commandError(command.requestId, 'Component is no longer mounted');
      return;
    }
    const path = [...command.path];
    if (path[0] === 'state') path.shift();
    const name = path.shift();
    if (typeof name !== 'string') {
      commandError(command.requestId, 'State path must begin with a state binding name');
      return;
    }
    const adapter = record.descriptor.state[name];
    if (!adapter?.set) {
      commandError(command.requestId, `State binding "${name}" is read-only or unavailable`);
      return;
    }
    try {
      let nextValue: unknown = command.value;
      if (path.length > 0) {
        const cloned = cloneForStorage(adapter.get());
        if (!cloned.ok) throw new Error(cloned.reason ?? 'State value cannot be cloned safely');
        nextValue = setAtPath(cloned.value, path, command.value);
      }
      adapter.set(nextValue);
      const checkpoint = timelineMode === 'live'
        ? captureCheckpoint(record, 'set-value')
        : null;
      pushTrace('state-set', record.id, {
        path: command.path,
        checkpointId: checkpoint?.id ?? null,
        cursor: checkpoint?.cursor ?? null,
        restorable: checkpoint?.restorable ?? false
      });
      const data: Record<string, JsonValue> = { value: preview(adapter.get()) };
      if (checkpoint) data.checkpointId = checkpoint.id;
      commandOk(command.requestId, data);
      scheduleSnapshot();
    } catch (error) {
      commandError(command.requestId, errorMessage(error));
    }
  }

  function timeTravel(command: Extract<PageCommand, { kind: 'time-travel' }>): void {
    if (command.action === 'live') {
      restoreLive(command.requestId);
      return;
    }

    const failures: TimeTravelFailure[] = [];
    let selections = selectCheckpoints(command, failures);
    if (timelineMode === 'live') {
      liveBaselines.clear();
      for (const record of components.values()) {
        if (!hasWritableState(record)) continue;
        const baseline = captureStoredState(record);
        if (baseline.restorable) liveBaselines.set(record.id, baseline);
      }
    }
    const unavailable = new Set<string>();
    for (const [record] of selections) {
      if (liveBaselines.has(record.id)) continue;
      const baseline = captureStoredState(record);
      if (baseline.restorable) {
        liveBaselines.set(record.id, baseline);
      } else {
        unavailable.add(record.id);
        failures.push({
          componentId: record.id,
          reason: `Cannot enter time travel without a live baseline: ${baseline.reason ?? 'state is not restorable'}`
        });
      }
    }
    selections = selections.filter(([record]) => !unavailable.has(record.id));
    timelineMode = 'travel';

    let applied = 0;
    for (const [record, checkpoint] of selections) {
      const failure = applyStoredState(record, checkpoint);
      if (failure) failures.push({ componentId: record.id, reason: failure });
      else applied++;
    }

    if (selections.length === 0 && failures.length === 0) {
      failures.push({
        componentId: 'timeline',
        reason: 'No restorable checkpoint exists at the requested position'
      });
    }
    const rollbackIncomplete = failures.some((failure) => failure.reason.includes('rollback also failed'));
    const enteredTravel = applied > 0 || rollbackIncomplete;
    if (!enteredTravel) {
      timelineMode = 'live';
      liveBaselines.clear();
    }

    const reportedFailures = normalizeFailures(failures);
    pushTrace('time-travel', undefined, {
      action: 'apply',
      cursor: command.cursor ?? null,
      applied,
      live: !enteredTravel,
      failures: reportedFailures.map((failure) => ({
        componentId: failure.componentId,
        reason: failure.reason
      }))
    });
    sendTimeTravelResult(command.requestId, !enteredTravel, applied, reportedFailures);
    scheduleSnapshot();
  }

  function restoreLive(requestId: string): void {
    const { failures, applied } = restoreLiveState();
    const reportedFailures = normalizeFailures(failures);
    pushTrace('time-travel', undefined, {
      action: 'live',
      applied,
      failures: reportedFailures.map((failure) => ({
        componentId: failure.componentId,
        reason: failure.reason
      }))
    });
    sendTimeTravelResult(requestId, true, applied, reportedFailures);
    if (recording) {
      for (const record of components.values()) {
        if (hasWritableState(record)) captureCheckpoint(record, 'live');
      }
      scheduleSnapshot();
    }
  }

  function restoreLiveState(): { failures: TimeTravelFailure[]; applied: number } {
    const failures: TimeTravelFailure[] = [];
    let applied = 0;
    timelineMode = 'restoring';
    for (const [componentId, baseline] of liveBaselines) {
      const record = components.get(componentId);
      if (!record) {
        failures.push({ componentId, reason: 'Component was unmounted while time travelling' });
        continue;
      }
      const failure = applyStoredState(record, baseline);
      if (failure) failures.push({ componentId, reason: failure });
      else applied++;
    }
    liveBaselines.clear();
    timelineMode = 'live';
    return { failures, applied };
  }

  function selectCheckpoints(
    command: Extract<PageCommand, { kind: 'time-travel'; action?: never }> | Extract<PageCommand, { kind: 'time-travel' }>,
    failures: TimeTravelFailure[]
  ): Array<[ComponentRecord, Checkpoint]> {
    const selections: Array<[ComponentRecord, Checkpoint]> = [];
    if (command.targets && command.targets.length > 0) {
      for (const target of command.targets) {
        const record = components.get(target.componentId);
        if (!record) {
          failures.push({ componentId: target.componentId, reason: 'Component is no longer mounted' });
          continue;
        }
        const checkpoint = record.checkpoints.find((candidate) => candidate.id === target.checkpointId);
        if (!checkpoint) {
          failures.push({ componentId: record.id, reason: `Checkpoint ${target.checkpointId} is unavailable` });
          continue;
        }
        selections.push([record, checkpoint]);
      }
      return selections;
    }

    for (const record of components.values()) {
      const checkpoint = command.cursor === undefined
        ? record.checkpoints.at(-1)
        : findCheckpointAtCursor(record, command.cursor);
      if (checkpoint?.restorable) selections.push([record, checkpoint]);
    }
    return selections;
  }

  function findCheckpointAtCursor(record: ComponentRecord, cursor: number): Checkpoint | undefined {
    for (let index = record.checkpoints.length - 1; index >= 0; index--) {
      const checkpoint = record.checkpoints[index];
      if (checkpoint && checkpoint.cursor <= cursor) return checkpoint;
    }
    return undefined;
  }

  function sendTimeTravelResult(
    requestId: string,
    live: boolean,
    applied: number,
    failures: TimeTravelFailure[]
  ): void {
    failures = normalizeFailures(failures);
    const payload: Extract<PageEvent, { type: 'time-travel-result' }>['payload'] = {
      requestId,
      ok: failures.length === 0,
      live,
      applied
    };
    if (failures.length > 0) payload.failures = failures;
    send({ type: 'time-travel-result', payload });
  }

  function normalizeFailures(failures: TimeTravelFailure[]): TimeTravelFailure[] {
    return failures.slice(0, 2_000).map((failure) => ({
      componentId: truncate(failure.componentId, 256),
      reason: truncate(failure.reason, 4_096)
    }));
  }

  function commandOk(requestId: string, data?: JsonValue): void {
    const payload: Extract<PageEvent, { type: 'command-result' }>['payload'] = {
      requestId,
      ok: true
    };
    if (data !== undefined) payload.data = data;
    send({ type: 'command-result', payload });
  }

  function commandError(requestId: string, error: string): void {
    send({
      type: 'command-result',
      payload: { requestId, ok: false, error: truncate(error, 16_000) }
    });
  }

  function captureCheckpoint(
    record: ComponentRecord,
    phase: Checkpoint['phase']
  ): Checkpoint {
    const stored = captureStoredState(record);
    const currentPreview = new Map<string, string>();
    const changes: string[] = [];
    for (const [name, adapter] of safeEntries(record.descriptor.state)) {
      let encoded: string;
      try {
        encoded = JSON.stringify(preview(adapter.get()));
      } catch {
        encoded = '"<unavailable>"';
      }
      currentPreview.set(name, encoded);
      if (record.lastPreview.get(name) !== encoded) changes.push(name);
    }
    record.lastPreview = currentPreview;

    const checkpoint: Checkpoint = {
      id: `cp:${sessionId.slice(0, 8)}:${++checkpointCounter}`,
      at: Date.now(),
      cursor: ++timelineCursor,
      phase,
      changes,
      values: stored.values,
      restorable: stored.restorable
    };
    if (stored.reason) checkpoint.reason = stored.reason;
    record.checkpoints.push(checkpoint);
    if (record.checkpoints.length > MAX_CHECKPOINTS) {
      record.checkpoints.splice(0, record.checkpoints.length - MAX_CHECKPOINTS);
    }
    return checkpoint;
  }

  function captureStoredState(record: ComponentRecord): StoredState {
    const values = new Map<string, StoredValue>();
    const reasons: string[] = [];
    let writable = 0;
    for (const [name, adapter] of safeEntries(record.descriptor.state)) {
      if (!adapter.set) continue;
      writable++;
      try {
        const current = adapter.get();
        const cloned = cloneForStorage(current);
        const stored: StoredValue = {
          value: cloned.value,
          restorable: cloned.ok
        };
        if (cloned.reason) stored.reason = cloned.reason;
        values.set(name, stored);
        if (!cloned.ok) reasons.push(`${name}: ${cloned.reason ?? 'unsupported value'}`);
      } catch (error) {
        const reason = errorMessage(error);
        values.set(name, {
          value: undefined,
          restorable: false,
          reason
        });
        reasons.push(`${name}: ${reason}`);
      }
    }
    if (writable === 0) reasons.push('Component has no writable state bindings');
    const result: StoredState = {
      values,
      restorable: writable > 0 && reasons.length === 0
    };
    if (reasons.length > 0) result.reason = reasons.join('; ');
    return result;
  }

  function applyStoredState(record: ComponentRecord, stored: StoredState): string | null {
    if (!stored.restorable) return stored.reason ?? 'Checkpoint is not restorable';
    const writes: Array<{
      set(value: unknown): void;
      next: unknown;
      previous: unknown;
    }> = [];
    for (const [name, value] of stored.values) {
      const adapter = record.descriptor.state[name];
      if (!adapter?.set) return `Writable state binding "${name}" is no longer available`;
      if (!value.restorable) return value.reason ?? `State binding "${name}" is not restorable`;
      const next = cloneForStorage(value.value);
      if (!next.ok) return next.reason ?? `State binding "${name}" cannot be cloned`;
      let current: unknown;
      try {
        current = adapter.get();
      } catch (error) {
        return `Could not read current state "${name}": ${errorMessage(error)}`;
      }
      const previous = cloneForStorage(current);
      if (!previous.ok) {
        return previous.reason ?? `Current state binding "${name}" cannot be cloned for rollback`;
      }
      writes.push({ set: adapter.set, next: next.value, previous: previous.value });
    }

    for (let index = 0; index < writes.length; index++) {
      const write = writes[index];
      if (!write) continue;
      try {
        write.set(write.next);
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (let rollbackIndex = index; rollbackIndex >= 0; rollbackIndex--) {
          const rollback = writes[rollbackIndex];
          if (!rollback) continue;
          try {
            rollback.set(rollback.previous);
          } catch (rollbackError) {
            rollbackErrors.push(errorMessage(rollbackError));
          }
        }
        const suffix = rollbackErrors.length > 0
          ? `; rollback also failed: ${rollbackErrors.join('; ')}`
          : '; prior writes were rolled back';
        return `${errorMessage(error)}${suffix}`;
      }
    }
    return null;
  }

  function hasWritableState(record: ComponentRecord): boolean {
    return safeEntries(record.descriptor.state).some(([, adapter]) => typeof adapter.set === 'function');
  }

  function isOverlayEvent(event: Event): boolean {
    return event.composedPath().some(isOverlayNode);
  }

  function eventElement(event: Event): Element | null {
    for (const target of event.composedPath()) {
      if (target instanceof ElementCtor) return target;
    }
    return event.target instanceof ElementCtor ? event.target : null;
  }

  function isOverlayNode(node: unknown): boolean {
    if (!(node instanceof NodeCtor)) return false;
    if (node === overlay?.host || node === overlay?.host.shadowRoot) return true;
    let current: Node | null = node;
    const seen = new Set<Node>();
    while (current && seen.size < 10 && !seen.has(current)) {
      seen.add(current);
      const element = current instanceof ElementCtor ? current : current.parentElement;
      if (element) {
        if (element.hasAttribute('data-svelte-lens-overlay')) return true;
        if (element.closest('[data-svelte-lens-overlay]')) return true;
      }
      const root = current.getRootNode();
      if (root instanceof ShadowRootCtor) {
        if (root === overlay?.host.shadowRoot) return true;
        current = root.host;
      } else {
        break;
      }
    }
    return false;
  }
}

function isDescriptor(value: unknown): value is ComponentDescriptor {
  if (!isObject(value)) return false;
  return (
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    value.name.length <= 4_096 &&
    typeof value.file === 'string' &&
    value.file.length <= 32_768 &&
    typeof value.props === 'function' &&
    isAdapterRecord(value.state, true) &&
    isAdapterRecord(value.derived, false)
  );
}

function isAdapterRecord(value: unknown, writable: boolean): boolean {
  if (!isObject(value)) return false;
  try {
    for (const adapter of Object.values(value)) {
      if (!isObject(adapter) || typeof adapter.get !== 'function') return false;
      if (writable && adapter.set !== undefined && typeof adapter.set !== 'function') return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readMeta(element: Element): SvelteElementMeta | null {
  try {
    const meta = element.__svelte_meta;
    if (!meta || !isObject(meta) || !isObject(meta.loc)) return null;
    if (
      typeof meta.loc.file !== 'string' ||
      meta.loc.file.length > 32_768 ||
      !Number.isInteger(meta.loc.line) ||
      meta.loc.line < 0 ||
      !Number.isInteger(meta.loc.column) ||
      meta.loc.column < 0
    ) {
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

function isDevStackEntry(value: unknown): value is DevStackEntry {
  if (!isObject(value)) return false;
  try {
    return (
      typeof value.file === 'string' &&
      value.file.length <= 32_768 &&
      (value.type === 'component' ||
        value.type === 'if' ||
        value.type === 'each' ||
        value.type === 'await' ||
        value.type === 'key' ||
        value.type === 'render') &&
      Number.isInteger(value.line) &&
      (value.line as number) >= 0 &&
      Number.isInteger(value.column) &&
      (value.column as number) >= 0 &&
      (value.componentTag === undefined ||
        (typeof value.componentTag === 'string' && value.componentTag.length <= 4_096))
    );
  } catch {
    return false;
  }
}

function copySource(source: SourceLocation): SourceLocation {
  return { file: source.file, line: source.line, column: source.column };
}

function safeEntries<T>(record: Record<string, T>): Array<[string, T]> {
  try {
    return Object.entries(record);
  } catch {
    return [];
  }
}

function fitSnapshotBudget(nodes: SnapshotNode[]): SnapshotNode[] {
  const fitted: SnapshotNode[] = [];
  let usedNodes = 8;
  let usedChars = 64;
  const markerReserve = measureJson({
    id: 'svelte-lens:snapshot-truncated',
    parentId: null,
    kind: 'unknown',
    name: `${nodes.length} snapshot nodes omitted`,
    detail: { omitted: nodes.length, reason: 'serialization-budget' }
  });

  for (let index = 0; index < nodes.length; index++) {
    const original = nodes[index];
    if (!original) continue;
    let candidate = original;
    let metrics = measureJson(candidate);
    if (
      !metrics.valid ||
      metrics.nodes > MAX_SNAPSHOT_NODE_JSON_NODES ||
      metrics.chars > MAX_SNAPSHOT_NODE_JSON_CHARS
    ) {
      candidate = compactSnapshotNode(original);
      metrics = measureJson(candidate);
    }
    if (
      !metrics.valid ||
      usedNodes + metrics.nodes + markerReserve.nodes > MAX_SNAPSHOT_JSON_NODES ||
      usedChars + metrics.chars + markerReserve.chars > MAX_SNAPSHOT_JSON_CHARS
    ) {
      const omitted = nodes.length - index;
      const marker: SnapshotNode = {
        id: 'svelte-lens:snapshot-truncated',
        parentId: null,
        kind: 'unknown',
        name: `${omitted} snapshot nodes omitted`,
        detail: { omitted, reason: 'serialization-budget' }
      };
      fitted.push(marker);
      break;
    }
    fitted.push(candidate);
    usedNodes += metrics.nodes;
    usedChars += metrics.chars;
  }
  return fitted;
}

function compactSnapshotNode(node: SnapshotNode): SnapshotNode {
  if (node.kind !== 'component' || !isObject(node.detail) || node.detail.enhanced !== true) {
    const compact: SnapshotNode = {
      id: node.id,
      parentId: node.parentId ?? null,
      kind: node.kind,
      name: truncate(node.name, 4_096),
      detail: { truncated: true, reason: 'snapshot-node-budget' }
    };
    if (node.source) compact.source = copySource(node.source);
    return compact;
  }

  const detail = node.detail;
  const compactDetail: Record<string, JsonValue> = {
    enhanced: true,
    domCount: finiteJsonNumber(detail.domCount),
    updateCount: finiteJsonNumber(detail.updateCount),
    props: { $type: 'truncated', reason: 'snapshot-node-budget' },
    state: { $type: 'truncated', reason: 'snapshot-node-budget' },
    writableState: compactBooleanRecord(detail.writableState),
    derived: { $type: 'truncated', reason: 'snapshot-node-budget' },
    truncated: true
  };
  if (isObject(detail.invocation)) compactDetail.invocation = compactPlainJson(detail.invocation, 16);
  if (Array.isArray(detail.checkpoints)) {
    compactDetail.checkpoints = detail.checkpoints.slice(-10).map((checkpoint) =>
      isObject(checkpoint) ? compactPlainJson(checkpoint, 32) : null
    );
  }
  if (isObject(detail.timeline)) compactDetail.timeline = compactPlainJson(detail.timeline, 16);
  if (Array.isArray(detail.rects)) compactDetail.rects = detail.rects.slice(0, 16);

  const compact: SnapshotNode = {
    id: node.id,
    parentId: node.parentId ?? null,
    kind: node.kind,
    name: truncate(node.name, 4_096),
    detail: compactDetail
  };
  if (node.source) compact.source = copySource(node.source);
  return compact;
}

function compactBooleanRecord(value: unknown): JsonValue {
  if (!isObject(value)) return {};
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  let count = 0;
  for (const key of Object.keys(value)) {
    if (count++ >= 100) {
      output.$truncated = true;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    output[key] = Boolean(descriptor && 'value' in descriptor && descriptor.value === true);
  }
  return output;
}

function compactPlainJson(value: Record<string, unknown>, maxKeys: number): JsonValue {
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  let count = 0;
  for (const key of Object.keys(value)) {
    if (count++ >= maxKeys) {
      output.$truncated = true;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    const item = descriptor.value;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      output[key] = typeof item === 'string' ? truncate(item, 4_096) : item;
    } else if (Array.isArray(item)) {
      output[key] = item.slice(0, 20).map((entry) =>
        entry === null || typeof entry === 'boolean' || typeof entry === 'string' ||
        (typeof entry === 'number' && Number.isFinite(entry))
          ? entry
          : { $type: 'truncated' }
      );
    } else {
      output[key] = { $type: 'truncated' };
    }
  }
  return output;
}

function finiteJsonNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function measureJson(value: unknown): { valid: boolean; nodes: number; chars: number } {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;
  let valid = true;

  const visit = (item: unknown, depth: number): void => {
    if (!valid || depth > 20) {
      valid = false;
      return;
    }
    nodes++;
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) valid = false;
      return;
    }
    if (typeof item === 'string') {
      chars += item.length;
      return;
    }
    if (typeof item !== 'object' || seen.has(item)) {
      valid = false;
      return;
    }
    seen.add(item);
    for (const key of Object.keys(item)) {
      chars += key.length;
      visit((item as Record<string, unknown>)[key], depth + 1);
    }
  };
  try {
    visit(value, 0);
  } catch {
    valid = false;
  }
  return { valid, nodes, chars };
}

function connectedElements(elements: Iterable<Element>): Element[] {
  const result: Element[] = [];
  for (const element of elements) {
    if (element.isConnected) result.push(element);
  }
  return result;
}

function preview(value: unknown): JsonValue {
  return previewInner(value, 0, {
    nodes: 2_000,
    seen: new Map(),
    nextRef: 1
  });
}

function previewInner(value: unknown, depth: number, budget: PreviewBudget): JsonValue {
  if (budget.nodes-- <= 0) return { $type: 'truncated', reason: 'node-budget' };
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? truncate(value, MAX_PREVIEW_STRING) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { $type: 'number', value: String(value) };
  }
  if (typeof value === 'undefined') return { $type: 'undefined' };
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (typeof value === 'symbol') return { $type: 'symbol', value: value.description ?? '' };
  if (typeof value === 'function') {
    return { $type: 'function', name: value.name || 'anonymous' };
  }
  if (depth >= MAX_PREVIEW_DEPTH) {
    return { $type: 'truncated', reason: 'depth', tag: objectTag(value) };
  }

  const existingRef = budget.seen.get(value);
  if (existingRef !== undefined) return { $type: 'circular', ref: existingRef };
  const ref = budget.nextRef++;
  budget.seen.set(value, ref);

  try {
    if (value instanceof window.Element) {
      return {
        $type: 'element',
        tag: value.tagName.toLowerCase(),
        id: value.id || null
      };
    }
    if (value instanceof Date) {
      return { $type: 'date', value: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
    }
    if (value instanceof RegExp) return { $type: 'regexp', value: String(value) };
    if (value instanceof Error) {
      return {
        $type: 'error',
        name: value.name,
        message: truncate(value.message, MAX_PREVIEW_STRING)
      };
    }
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      const length = Math.min(value.length, MAX_PREVIEW_ITEMS);
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          output.push({ $type: 'empty' });
        } else if ('value' in descriptor) {
          output.push(previewInner(descriptor.value, depth + 1, budget));
        } else {
          output.push(accessorPreview(descriptor));
        }
      }
      if (value.length > MAX_PREVIEW_ITEMS) {
        output.push({ $type: 'truncated', remaining: value.length - MAX_PREVIEW_ITEMS });
      }
      return output;
    }
    if (value instanceof Map) {
      const entries: JsonValue[] = [];
      let index = 0;
      for (const [key, item] of value) {
        if (index++ >= MAX_PREVIEW_ITEMS) break;
        entries.push([
          previewInner(key, depth + 1, budget),
          previewInner(item, depth + 1, budget)
        ]);
      }
      return { $type: 'map', size: value.size, entries };
    }
    if (value instanceof Set) {
      const entries: JsonValue[] = [];
      let index = 0;
      for (const item of value) {
        if (index++ >= MAX_PREVIEW_ITEMS) break;
        entries.push(previewInner(item, depth + 1, budget));
      }
      return { $type: 'set', size: value.size, entries };
    }
    if (ArrayBuffer.isView(value)) {
      const array = Array.from(
        new Uint8Array(value.buffer, value.byteOffset, Math.min(value.byteLength, MAX_PREVIEW_ITEMS))
      );
      return { $type: value.constructor.name, byteLength: value.byteLength, values: array };
    }
    if (value instanceof ArrayBuffer) {
      return { $type: 'ArrayBuffer', byteLength: value.byteLength };
    }

    const output = Object.create(null) as Record<string, JsonValue>;
    let index = 0;
    for (const key of Object.keys(value)) {
      if (index++ >= MAX_PREVIEW_ITEMS) {
        output.$truncated = { $type: 'truncated', reason: 'item-budget' };
        break;
      }
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) {
          output[key] = { $type: 'unavailable' };
        } else if ('value' in descriptor) {
          output[key] = previewInner(descriptor.value, depth + 1, budget);
        } else {
          output[key] = accessorPreview(descriptor);
        }
      } catch (error) {
        output[key] = errorPreview(error);
      }
    }
    return output;
  } catch (error) {
    return errorPreview(error);
  }
}

function cloneForStorage(value: unknown): CloneResult {
  return cloneInner(value, 0, { nodes: MAX_CLONE_NODES, seen: new Map() });
}

function cloneInner(value: unknown, depth: number, budget: CloneBudget): CloneResult {
  if (budget.nodes-- <= 0) return cloneFailure('State exceeds the checkpoint node budget');
  if (depth > MAX_CLONE_DEPTH) return cloneFailure('State exceeds the checkpoint depth budget');
  if (
    value === null ||
    typeof value === 'undefined' ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    return { ok: true, value };
  }

  const existing = budget.seen.get(value);
  if (existing !== undefined) return { ok: true, value: existing };

  try {
    if (value instanceof window.Node) return cloneFailure('DOM nodes are live values and cannot be checkpointed');
    if (value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise) {
      return cloneFailure(`${objectTag(value)} cannot be checkpointed`);
    }
    if (value instanceof Date) {
      if (Object.getPrototypeOf(value) !== Date.prototype) {
        return cloneFailure(`${value.constructor.name || 'Date'} instances cannot be restored safely`);
      }
      return { ok: true, value: new Date(value.getTime()) };
    }
    if (value instanceof RegExp) {
      if (Object.getPrototypeOf(value) !== RegExp.prototype) {
        return cloneFailure(`${value.constructor.name || 'RegExp'} instances cannot be restored safely`);
      }
      return { ok: true, value: new RegExp(value.source, value.flags) };
    }
    if (value instanceof ArrayBuffer) return { ok: true, value: value.slice(0) };
    if (ArrayBuffer.isView(value)) {
      if (Object.getPrototypeOf(value) !== value.constructor.prototype) {
        return cloneFailure(`${value.constructor.name} subclasses cannot be restored safely`);
      }
      if (value instanceof DataView) {
        return {
          ok: true,
          value: new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        };
      }
      const constructor = value.constructor as {
        new (source: ArrayLike<number> | ArrayBufferLike): ArrayBufferView;
      };
      return { ok: true, value: new constructor(value as unknown as ArrayLike<number>) };
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return cloneFailure('Array subclasses cannot be restored safely');
      }
      const output: unknown[] = [];
      budget.seen.set(value, output);
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          output.length++;
          continue;
        }
        if (!('value' in descriptor)) {
          return cloneFailure(`Array index ${index} is an accessor and cannot be checkpointed safely`);
        }
        const cloned = cloneInner(descriptor.value, depth + 1, budget);
        if (!cloned.ok) return cloned;
        output.push(cloned.value);
      }
      return { ok: true, value: output };
    }
    if (value instanceof Map) {
      if (Object.getPrototypeOf(value) !== Map.prototype) {
        return cloneFailure(`${value.constructor.name || 'Map'} instances cannot be restored safely`);
      }
      const output = new Map<unknown, unknown>();
      budget.seen.set(value, output);
      for (const [key, item] of value) {
        const clonedKey = cloneInner(key, depth + 1, budget);
        if (!clonedKey.ok) return clonedKey;
        const clonedValue = cloneInner(item, depth + 1, budget);
        if (!clonedValue.ok) return clonedValue;
        output.set(clonedKey.value, clonedValue.value);
      }
      return { ok: true, value: output };
    }
    if (value instanceof Set) {
      if (Object.getPrototypeOf(value) !== Set.prototype) {
        return cloneFailure(`${value.constructor.name || 'Set'} instances cannot be restored safely`);
      }
      const output = new Set<unknown>();
      budget.seen.set(value, output);
      for (const item of value) {
        const cloned = cloneInner(item, depth + 1, budget);
        if (!cloned.ok) return cloned;
        output.add(cloned.value);
      }
      return { ok: true, value: output };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return cloneFailure(`${objectTag(value)} instances cannot be checkpointed safely`);
    }
    const output = Object.create(prototype) as Record<string, unknown>;
    budget.seen.set(value, output);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return cloneFailure(`State property "${key}" became unavailable`);
      if (!('value' in descriptor)) {
        return cloneFailure(`State property "${key}" is an accessor and cannot be checkpointed safely`);
      }
      const cloned = cloneInner(descriptor.value, depth + 1, budget);
      if (!cloned.ok) return cloned;
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: cloned.value,
        writable: true
      });
    }
    return { ok: true, value: output };
  } catch (error) {
    return cloneFailure(errorMessage(error));
  }
}

function cloneFailure(reason: string): CloneResult {
  return { ok: false, value: undefined, reason };
}

function setAtPath(root: unknown, path: Array<string | number>, value: JsonValue): unknown {
  if (path.length === 0) return value;
  let current = root;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index];
    assertSafePathSegment(segment);
    if (!isIndexable(current)) throw new Error(`Cannot traverse state path at ${String(segment)}`);
    current = current[segment];
  }
  const final = path[path.length - 1];
  assertSafePathSegment(final);
  if (!isIndexable(current)) throw new Error(`Cannot write state path at ${String(final)}`);
  current[final] = value;
  return root;
}

function assertSafePathSegment(segment: string | number | undefined): asserts segment is string | number {
  if (segment === undefined) throw new Error('State path is incomplete');
  if (typeof segment === 'string' && DANGEROUS_PATH_KEYS.has(segment)) {
    throw new Error(`Unsafe state path segment: ${segment}`);
  }
}

function isIndexable(value: unknown): value is Record<string | number, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorPreview(error: unknown): JsonValue {
  return { $type: 'error', message: truncate(errorMessage(error), MAX_PREVIEW_STRING) };
}

function accessorPreview(descriptor: PropertyDescriptor): JsonValue {
  return {
    $type: 'accessor',
    get: typeof descriptor.get === 'function',
    set: typeof descriptor.set === 'function'
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

function objectTag(value: object): string {
  try {
    return Object.prototype.toString.call(value).slice(8, -1);
  } catch {
    return 'Object';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return '';
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeFile(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.?\//, '');
}

function simpleName(name: string): string {
  const parts = name.split('.');
  return (parts.at(-1) ?? name).replace(/[^A-Za-z0-9_$]/g, '');
}

function fileComponentName(file: string): string {
  const normalized = normalizeFile(file);
  const basename = normalized.split('/').at(-1) ?? normalized;
  return basename.replace(/\.svelte(?:\?.*)?$/, '') || 'Component';
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function createSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
