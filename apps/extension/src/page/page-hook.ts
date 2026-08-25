import {
  isContentToPageMessage,
  pageMessage,
  type JsonValue,
  type LensRect,
  type PageCommand,
  type PageEvent,
  type RuneObjectSummary,
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
const MAX_TRACE_DETAIL_JSON_NODES = 8_000;
const MAX_TRACE_DETAIL_JSON_CHARS = 100_000;
const MAX_TRACE_HISTORY_JSON_CHARS = 8_000_000;
const MAX_TRACE_BATCH_JSON_CHARS = 1_500_000;
const MAX_CHECKPOINTS = 12;
const MAX_RETAINED_CHECKPOINTS = 256;
const MAX_LIVE_BASELINES = 64;
const MAX_RETAINED_CHECKPOINT_NODES = 100_000;
const MAX_RETAINED_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_NODES = 2_000;
const MAX_CHECKPOINT_ENTRIES = 2_000;
const MAX_CHECKPOINT_BYTES = 512 * 1024;
const MAX_CHECKPOINT_BINARY_BYTES = 256 * 1024;
const MAX_CHECKPOINT_ARRAY_LENGTH = 100_000;
const MAX_CHECKPOINT_CAPTURES_PER_FRAME = 32;
const MAX_EFFECTS = 1_000;
const MAX_EFFECTS_PER_COMPONENT = 200;
const MAX_EFFECT_DEPENDENCIES = 60;
const MAX_EFFECT_DEPENDENCY_DEPTH = 8;
const MAX_EFFECT_RUNS = 20;
const MAX_EFFECT_RUNTIMES = 8;
const MAX_RUNE_OBJECTS = 1_000;
const MAX_RUNE_FIELDS = 64;
const MAX_RUNE_OBJECT_SUMMARIES = 250;
const MAX_RUNE_SUMMARY_FIELDS = 2_000;
const MAX_RUNE_SUMMARY_CHARS = 250_000;
const MAX_RUNE_INSPECT_NODES = 2_000;
const MAX_RUNE_INSPECT_CHARS = 250_000;
const MAX_RUNE_NAME_CHARS = 512;
const MAX_RUNE_FILE_CHARS = 4_096;
const MAX_RUNE_FIELD_NAME_CHARS = 512;
const MAX_RECTS = 32;
const MAX_HIGHLIGHT_ELEMENTS = 256;
const MAX_OBSERVED_ROOTS = 512;
const MAX_MUTATION_CLAIM_ELEMENTS = 256;
const MAX_PREVIEW_DEPTH = 5;
const MAX_PREVIEW_ITEMS = 80;
const MAX_PREVIEW_STRING = 4_096;
const MAX_CLONE_DEPTH = 64;
const MAX_STACK_DEPTH = 100;
const MAX_SNAPSHOT_JSON_NODES = 50_000;
const MAX_SNAPSHOT_JSON_CHARS = 1_000_000;
const MAX_SNAPSHOT_NODE_JSON_NODES = 4_000;
const MAX_SNAPSHOT_NODE_JSON_CHARS = 80_000;
const SNAPSHOT_QUIET_MS = 120;
const SNAPSHOT_MAX_WAIT_MS = 500;
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
  canSet?(): boolean;
  set?: (value: unknown) => void;
}

interface ReadAdapter {
  get(): unknown;
}

function isWritableStateAdapter(
  adapter: StateAdapter
): adapter is StateAdapter & { set(value: unknown): void } {
  if (typeof adapter.set !== 'function') return false;
  if (adapter.canSet === undefined) return true;
  try {
    return adapter.canSet() === true;
  } catch {
    return false;
  }
}

interface ComponentDescriptor {
  name: string;
  file: string;
  props(): Record<string, unknown>;
  state: Record<string, StateAdapter>;
  derived: Record<string, ReadAdapter>;
}

interface RuneFieldAdapter {
  kind: 'state' | 'derived';
  source: SourceLocation;
  get(target: object): unknown;
}

interface RuneObjectDescriptor {
  name: string;
  file: string;
  source: SourceLocation;
  fields: Record<string, RuneFieldAdapter>;
  totalFields: number;
  truncated: boolean;
}

interface NormalizedRuneField {
  name: string;
  kind: 'state' | 'derived';
  source: SourceLocation;
  get(target: object): unknown;
}

interface NormalizedRuneDescriptor {
  name: string;
  file: string;
  source: SourceLocation;
  fields: NormalizedRuneField[];
  totalFields: number;
  truncated: boolean;
}

interface RuneObjectRecord {
  id: string;
  ownerComponentId: string | null;
  target: WeakRef<object>;
  descriptor: NormalizedRuneDescriptor;
}

interface EffectDescriptor {
  siteId: string;
  componentId: string | null;
  kind: 'effect' | 'pre';
  source: SourceLocation;
}

interface EffectRuntimeAdapter {
  activeEffect: unknown;
  untrack: <Value>(read: () => Value) => Value;
}

type EffectRuntimeResolver = () => EffectRuntimeAdapter | null;

interface DependencyBaseline {
  id: string;
  value: JsonValue;
  writeVersion: number;
}

interface CapturedDependency {
  signal: object;
  id: string;
  label: string;
  kind: 'state' | 'derived' | 'store' | 'unknown';
  value: JsonValue;
  writeVersion: number;
  dirty: boolean;
  depth: number;
  direct: boolean;
  parentId: string | null;
  createdAt?: string;
  updatedAt?: string[];
}

interface DependencyCapture {
  dependencies: CapturedDependency[];
  directCount: number;
  truncated: boolean;
}

interface DependencyCaptureOptions {
  includeCreatedStacks: boolean;
  includeUpdatedStacks: boolean;
}

interface BoundedObjectArray {
  values: object[];
  length: number;
  truncated: boolean;
}

interface EffectRecord {
  id: string;
  descriptor: EffectDescriptor;
  componentId: string | null;
  parentEffectId: string | null;
  registeredAt: number;
  status: 'active' | 'error' | 'disposed';
  runCount: number;
  capturedRunCount: number;
  timedRunCount: number;
  cleanupCount: number;
  cleanupRegistered: boolean | null;
  errorCount: number;
  totalSyncDurationMs: number;
  maxSyncDurationMs: number;
  lastSyncDurationMs: number | null;
  lastRunAt: number | null;
  lastRunId: string | null;
  adapterStatus: 'exact' | 'unavailable';
  captureGap: boolean;
  effectObject: object | null;
  runtimeAdapter: EffectRuntimeAdapter | null;
  baselines: Map<object, DependencyBaseline>;
  dependencies: JsonValue[];
  triggers: JsonValue[];
  addedDependencyIds: string[];
  removedDependencyIds: string[];
  recentRuns: JsonValue[];
  lastError: JsonValue | null;
  lastOutcome: 'ok' | 'error' | null;
  directDependencyCount: number;
  dependencyTruncated: boolean;
  pendingFinalize: ((overlapped: boolean) => void) | null;
  pendingTriggerCapture: DependencyCapture | null;
}

interface SvelteLensHook {
  beginComponent(descriptor: ComponentDescriptor): string | null;
  endComponent(id: string | null): void;
  updateComponent(id: string | null, phase?: 'init' | 'update'): void;
  unregisterComponent(id: string | null): void;
  abortComponent(id: string | null, error?: unknown): void;
  canReplaceStateInPlace(value: unknown): boolean;
  replaceStateInPlace(target: unknown, replacement: unknown): void;
  installRuntime(resolve: EffectRuntimeResolver): void;
  registerEffect(descriptor: EffectDescriptor, callback: unknown): unknown;
  registerRuneObject(target: object, descriptor: RuneObjectDescriptor): string | null;
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
  retainedNodes: number;
  retainedBytes: number;
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
  effects: Set<string>;
}

interface CloneResult {
  ok: boolean;
  value: unknown;
  reason?: string;
}

interface CloneBudget {
  nodes: number;
  entries: number;
  bytes: number;
  seen: Map<object, unknown>;
}

interface PreviewBudget {
  nodes: number;
  chars: number;
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

type ReplaceableState = Record<string, unknown> | unknown[];

function canReplaceStateInPlace(value: unknown): value is ReplaceableState {
  if (!isObjectValue(value)) return false;
  if (Array.isArray(value)) return true;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function replaceStateInPlace(target: unknown, replacement: unknown): void {
  if (!canReplaceStateInPlace(target) || !canReplaceStateInPlace(replacement)) {
    throw new TypeError('Direct proxy state can only restore plain objects or arrays');
  }
  if (Array.isArray(target) !== Array.isArray(replacement)) {
    throw new TypeError('Direct proxy state cannot change between object and array shapes');
  }

  const replacementKeys = Object.keys(replacement);
  for (const key of replacementKeys) {
    if (DANGEROUS_PATH_KEYS.has(key)) {
      throw new TypeError(`State key "${key}" is not safe to replace`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(replacement, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`State key "${key}" is not a data property`);
    }
  }

  const nextKeys = new Set(replacementKeys);
  for (const key of Object.keys(target)) {
    if (DANGEROUS_PATH_KEYS.has(key) || nextKeys.has(key)) continue;
    if (!Reflect.deleteProperty(target, key)) {
      throw new TypeError(`State key "${key}" could not be removed`);
    }
  }
  for (const key of replacementKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(replacement, key);
    if (!descriptor || !('value' in descriptor) || !Reflect.set(target, key, descriptor.value)) {
      throw new TypeError(`State key "${key}" could not be replaced`);
    }
  }
  if (Array.isArray(target) && Array.isArray(replacement)) target.length = replacement.length;
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
  const traceJsonSizes = new WeakMap<TraceRecord, number>();
  const liveBaselines = new Map<string, StoredState>();
  const retainedCheckpoints: Array<{ componentId: string; checkpoint: Checkpoint }> = [];
  const effectRecords = new Map<string, EffectRecord>();
  const omittedEffectsByComponent = new Map<string, number>();
  const effectByReaction = new WeakMap<object, EffectRecord>();
  const signalIds = new WeakMap<object, string>();
  const runeObjectsByTarget = new WeakMap<object, RuneObjectRecord>();
  const runeObjects = new Map<string, RuneObjectRecord>();
  const normalizedRuneDescriptors = new WeakMap<object, NormalizedRuneDescriptor>();
  const runtimeResolvers: EffectRuntimeResolver[] = [];
  const runtimeUntracks = new WeakSet<Function>();
  const runeFinalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<string>((id) => runeObjects.delete(id))
    : null;

  let componentCounter = 0;
  let elementCounter = 0;
  let entryCounter = 0;
  let traceCounter = 0;
  let traceHistoryJsonChars = 0;
  let checkpointCounter = 0;
  let checkpointCaptureCount = 0;
  let checkpointBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  let retainedCheckpointNodes = 0;
  let retainedCheckpointBytes = 0;
  let liveBaselineNodes = 0;
  let liveBaselineBytes = 0;
  let effectCounter = 0;
  let signalCounter = 0;
  let runeObjectCounter = 0;
  let runeCapacityMisses = 0;
  let timelineCursor = 0;
  let snapshotRevision = 0;
  let connected = false;
  let recording = false;
  let pickerActive = false;
  let timelineMode: 'live' | 'travel' | 'restoring' = 'live';
  let selectedHighlight: string | null = null;
  let revealHighlight: string | null = null;
  let recentCause: { id: string; at: number } | null = null;
  let traceFlushQueued = false;
  let reconcileFrame: number | null = null;
  let reconcileDirty = true;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotQueuedAt = 0;
  let helloQueued = false;
  let lastHelloSignature = '';
  let overlay: Overlay | null = null;
  let overlayRepaintFrame: number | null = null;
  let pickerFrame: number | null = null;
  let highlightFrame: number | null = null;
  let pendingHighlight: { componentId: string | null; reveal: boolean } | null = null;
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
    unregisterComponent,
    abortComponent,
    canReplaceStateInPlace,
    replaceStateInPlace,
    installRuntime,
    registerEffect,
    registerRuneObject
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
      if (highlightFrame !== null) pageWindow.cancelAnimationFrame(highlightFrame);
      if (reconcileFrame !== null) pageWindow.cancelAnimationFrame(reconcileFrame);
      if (checkpointBudgetTimer !== null) clearTimeout(checkpointBudgetTimer);
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

  function installRuntime(resolve: EffectRuntimeResolver): void {
    if (typeof resolve !== 'function' || runtimeResolvers.length >= MAX_EFFECT_RUNTIMES) return;
    try {
      const candidate = resolve();
      if (!isEffectRuntimeAdapter(candidate) || runtimeUntracks.has(candidate.untrack)) return;
      runtimeUntracks.add(candidate.untrack);
      runtimeResolvers.push(resolve);
      scheduleHello();
    } catch {
      // A mismatched private runtime adapter must never affect the inspected app.
    }
  }

  function registerRuneObject(target: object, candidate: RuneObjectDescriptor): string | null {
    try {
      if (!isObjectValue(target) || !isObjectValue(candidate)) return null;
      const existing = runeObjectsByTarget.get(target);
      const descriptor = normalizeRuneDescriptor(candidate);
      if (!descriptor) return null;
      if (existing) {
        if (existing.descriptor !== descriptor) {
          existing.descriptor = mergeRuneDescriptors(existing.descriptor, descriptor);
          existing.ownerComponentId ??= findActiveParent();
        }
        return existing.id;
      }
      if (runeObjects.size >= MAX_RUNE_OBJECTS) {
        // Do not turn a large route mount into O(instances × registry-size)
        // WeakRef scans. Finalization removes most entries; a bounded periodic
        // recheck makes space when finalizers are delayed or unavailable.
        runeCapacityMisses++;
        if (runeCapacityMisses % 256 !== 0) return null;
        pruneRuneObjects();
        if (runeObjects.size >= MAX_RUNE_OBJECTS) return null;
      }
      runeCapacityMisses = 0;

      const id = `rune:${sessionId.slice(0, 8)}:${++runeObjectCounter}`;
      const record: RuneObjectRecord = {
        id,
        ownerComponentId: findActiveParent(),
        target: new WeakRef(target),
        descriptor
      };
      runeObjectsByTarget.set(target, record);
      runeObjects.set(id, record);
      runeFinalizer?.register(target, id);
      scheduleHello();
      return id;
    } catch {
      // Instrumentation must never make constructing an application object fail.
      return null;
    }
  }

  function normalizeRuneDescriptor(candidate: object): NormalizedRuneDescriptor | null {
    const cached = normalizedRuneDescriptors.get(candidate);
    if (cached) return cached;
    const name = readDataProperty(candidate, 'name');
    const file = readDataProperty(candidate, 'file');
    const source = normalizeRuneSource(readDataProperty(candidate, 'source'));
    const fieldRecord = readDataProperty(candidate, 'fields');
    if (
      typeof name !== 'string' || name.length === 0 || name.length > MAX_RUNE_NAME_CHARS ||
      typeof file !== 'string' || file.length === 0 || file.length > MAX_RUNE_FILE_CHARS ||
      !source || !isObjectValue(fieldRecord)
    ) return null;

    let keys: string[];
    try {
      keys = Object.keys(fieldRecord).slice(0, MAX_RUNE_FIELDS);
    } catch {
      return null;
    }
    const fields: NormalizedRuneField[] = [];
    for (const key of keys) {
      if (key.length === 0 || key.length > MAX_RUNE_FIELD_NAME_CHARS) continue;
      const adapter = readDataProperty(fieldRecord, key);
      if (!isObjectValue(adapter)) continue;
      const kind = readDataProperty(adapter, 'kind');
      const fieldSource = normalizeRuneSource(readDataProperty(adapter, 'source'));
      const get = readDataProperty(adapter, 'get');
      if ((kind !== 'state' && kind !== 'derived') || !fieldSource || typeof get !== 'function') continue;
      fields.push({ name: key, kind, source: fieldSource, get: get as (target: object) => unknown });
    }
    if (fields.length === 0) return null;
    const declaredTotal = readDataProperty(candidate, 'totalFields');
    const totalFields = typeof declaredTotal === 'number' && Number.isSafeInteger(declaredTotal) && declaredTotal >= 0
      ? declaredTotal
      : fields.length;
    const descriptor: NormalizedRuneDescriptor = {
      name,
      file,
      source,
      fields,
      totalFields: Math.max(totalFields, fields.length),
      truncated: readDataProperty(candidate, 'truncated') === true || totalFields > fields.length
    };
    normalizedRuneDescriptors.set(candidate, descriptor);
    return descriptor;
  }

  function mergeRuneDescriptors(
    base: NormalizedRuneDescriptor,
    extension: NormalizedRuneDescriptor
  ): NormalizedRuneDescriptor {
    const baseNames = new Set(base.fields.map((field) => field.name));
    const extensionNames = new Set(extension.fields.map((field) => field.name));
    const collisions = new Set([...baseNames].filter((name) => extensionNames.has(name)));
    const fields = [
      ...base.fields.map((field) => ({
        ...field,
        name: collisions.has(field.name) ? `${base.name}.${field.name}` : field.name
      })),
      ...extension.fields.map((field) => ({
        ...field,
        name: collisions.has(field.name) ? `${extension.name}.${field.name}` : field.name
      }))
    ].slice(0, MAX_RUNE_FIELDS);
    return {
      name: extension.name,
      file: extension.file,
      source: copySource(extension.source),
      fields,
      totalFields: base.totalFields + extension.totalFields,
      truncated: base.truncated || extension.truncated ||
        base.totalFields + extension.totalFields > fields.length
    };
  }

  function normalizeRuneSource(value: unknown): SourceLocation | null {
    if (!isObjectValue(value)) return null;
    const file = readDataProperty(value, 'file');
    const line = readDataProperty(value, 'line');
    const column = readDataProperty(value, 'column');
    return (
      typeof file === 'string' && file.length > 0 && file.length <= MAX_RUNE_FILE_CHARS &&
      typeof line === 'number' && Number.isSafeInteger(line) && line >= 0 &&
      typeof column === 'number' && Number.isSafeInteger(column) && column >= 0
    ) ? { file, line, column } : null;
  }

  function pruneRuneObjects(): void {
    for (const [id, record] of runeObjects) {
      if (record.target.deref() === undefined) runeObjects.delete(id);
    }
  }

  function registerEffect(candidate: EffectDescriptor, callback: unknown): unknown {
    try {
      if (typeof callback !== 'function' || !isEffectDescriptor(candidate)) return callback;
      if (!ensureEffectCapacity(candidate.componentId)) {
        noteOmittedEffect(candidate.componentId);
        return callback;
      }

      const record: EffectRecord = {
      id: `fx:${sessionId.slice(0, 8)}:${++effectCounter}`,
      descriptor: copyEffectDescriptor(candidate),
      componentId: candidate.componentId,
      parentEffectId: null,
      registeredAt: Date.now(),
      status: 'active',
      runCount: 0,
      capturedRunCount: 0,
      timedRunCount: 0,
      cleanupCount: 0,
      cleanupRegistered: null,
      errorCount: 0,
      totalSyncDurationMs: 0,
      maxSyncDurationMs: 0,
      lastSyncDurationMs: null,
      lastRunAt: null,
      lastRunId: null,
      adapterStatus: 'unavailable',
      captureGap: false,
      effectObject: null,
      runtimeAdapter: null,
      baselines: new Map(),
      dependencies: [],
      triggers: [],
      addedDependencyIds: [],
      removedDependencyIds: [],
      recentRuns: [],
      lastError: null,
      lastOutcome: null,
      directDependencyCount: 0,
      dependencyTruncated: false,
      pendingFinalize: null,
      pendingTriggerCapture: null
      };
      effectRecords.set(record.id, record);
      attachEffectToComponent(record);

      const original = callback as (...args: unknown[]) => unknown;
      return function svelteLensEffect(this: unknown, ...args: unknown[]): unknown {
        return runEffect(record, original, this, args);
      };
    } catch {
      return callback;
    }
  }

  function ensureEffectCapacity(componentId: string | null): boolean {
    const component = componentId ? components.get(componentId) : null;
    if (effectRecords.size < MAX_EFFECTS && (!component || component.effects.size < MAX_EFFECTS_PER_COMPONENT)) {
      return true;
    }
    for (const [id, record] of effectRecords) {
      refreshEffectStatus(record);
      if (record.status !== 'disposed') continue;
      removeEffectRecord(id);
      if (effectRecords.size < MAX_EFFECTS && (!component || component.effects.size < MAX_EFFECTS_PER_COMPONENT)) {
        return true;
      }
    }
    return false;
  }

  function noteOmittedEffect(componentId: string | null): void {
    if (!componentId) return;
    const count = (omittedEffectsByComponent.get(componentId) ?? 0) + 1;
    omittedEffectsByComponent.set(componentId, count);
    if (count === 1) {
      const component = components.get(componentId);
      pushTrace('effect-capacity', componentId, {
        reason: component && component.effects.size >= MAX_EFFECTS_PER_COMPONENT
          ? 'component-effect-limit'
          : 'global-effect-limit',
        omittedCount: count
      });
    }
    if (recording) scheduleSnapshot();
  }

  function attachEffectToComponent(record: EffectRecord): void {
    if (!record.componentId) return;
    const component = components.get(record.componentId);
    if (component && component.effects.size < MAX_EFFECTS_PER_COMPONENT) component.effects.add(record.id);
  }

  function removeEffectRecord(id: string): void {
    const record = effectRecords.get(id);
    if (!record) return;
    // Error boundaries can tear down a component synchronously after an effect
    // callback throws. Settle the terminal receipt while the record and owning
    // component still exist so that run cannot disappear with the teardown.
    record.pendingFinalize?.(false);
    record.status = 'disposed';
    record.baselines.clear();
    if (record.componentId) components.get(record.componentId)?.effects.delete(id);
    effectRecords.delete(id);
  }

  function runEffect(
    record: EffectRecord,
    original: (...args: unknown[]) => unknown,
    thisArg: unknown,
    args: unknown[]
  ): unknown {
    // Svelte can synchronously flush the same effect again before our queued
    // post-commit read runs. Settle the older receipt as overlapped now so it
    // cannot read the newer run's mutable reaction state and invent a baseline.
    record.pendingFinalize?.(true);
    record.runCount++;
    const runAt = Date.now();
    record.lastRunAt = runAt;
    const runIndex = record.runCount;
    const phase = runIndex === 1 ? 'initial' : 'rerun';
    const captureEnabled = recording;
    // Resolving Svelte's private active reaction is useful only while the panel
    // is recording. Keep the always-installed wrapper nearly transparent when
    // DevTools is closed or recording is paused.
    const runtime = captureEnabled ? findActiveEffectRuntime() : null;
    const effect = runtime?.effect ?? null;
    if (effect) bindEffectReaction(record, effect);
    if (runtime) record.runtimeAdapter = runtime.adapter;
    record.adapterStatus = runtime ? 'exact' : 'unavailable';
    record.status = 'active';
    record.lastError = null;

    const effectWriteVersion = effect ? readFiniteProperty(effect, 'wv') : null;
    const cleanupTriggerCapture = record.pendingTriggerCapture;
    record.pendingTriggerCapture = null;
    const entryDependencies = cleanupTriggerCapture ?? (
      captureEnabled && runtime && effect && effectWriteVersion !== null
        ? captureWithRuntime(runtime.adapter, effect, effectWriteVersion, {
            includeCreatedStacks: false,
            includeUpdatedStacks: true
          })
        : emptyDependencyCapture()
    );
    const startedAt = captureEnabled ? performance.now() : 0;
    let result: unknown;
    let thrown: unknown = undefined;
    let didThrow = false;

    try {
      result = Reflect.apply(original, thisArg, args);
    } catch (error) {
      didThrow = true;
      thrown = error;
      record.errorCount++;
      record.status = 'error';
      record.lastError = effectErrorDetail(error);
      throw error;
    } finally {
      record.lastOutcome = didThrow ? 'error' : 'ok';
      record.cleanupRegistered = typeof result === 'function';
      if (!captureEnabled) {
        record.captureGap = true;
        record.dependencies = [];
        record.directDependencyCount = 0;
        record.dependencyTruncated = true;
        record.triggers = [];
        record.addedDependencyIds = [];
        record.removedDependencyIds = [];
        record.lastSyncDurationMs = null;
        record.lastRunId = null;
      } else {
        const duration = Math.max(0, performance.now() - startedAt);
        record.lastSyncDurationMs = duration;
        record.timedRunCount++;
        record.totalSyncDurationMs += duration;
        record.maxSyncDurationMs = Math.max(record.maxSyncDurationMs, duration);
        const afterDependencies = runtime && effect && effectWriteVersion !== null
          ? captureWithRuntime(runtime.adapter, effect, effectWriteVersion, {
              includeCreatedStacks: false,
              includeUpdatedStacks: false
            })
          : emptyDependencyCapture();
        const error = didThrow ? effectErrorDetail(thrown) : null;
        let settled = false;
        const finalize = (overlapped: boolean): void => {
          if (settled) return;
          settled = true;
          if (record.pendingFinalize === finalize) record.pendingFinalize = null;
          try {
            finalizeEffectRun(
              record,
              runtime,
              effect,
              runIndex,
              phase,
              duration,
              entryDependencies,
              afterDependencies,
              error,
              typeof result === 'function',
              runAt,
              overlapped
            );
          } catch {
            record.adapterStatus = 'unavailable';
          }
        };
        record.pendingFinalize = finalize;
        queueMicrotask(() => finalize(false));
      }
    }

    return typeof result === 'function'
      ? wrapEffectCleanup(record, result as (...args: unknown[]) => unknown, runIndex)
      : result;
  }

  function wrapEffectCleanup(
    record: EffectRecord,
    cleanup: (...args: unknown[]) => unknown,
    originatingRun: number
  ): (...args: unknown[]) => unknown {
    return function svelteLensEffectCleanup(this: unknown, ...args: unknown[]): unknown {
      record.cleanupCount++;
      const captureEnabled = recording;
      // Svelte executes teardown after selecting an effect but before running
      // its callback. Snapshot dirty dependencies before user cleanup writes so
      // those writes cannot be misreported as causes of the already-selected run.
      record.pendingFinalize?.(true);
      const runtime = captureEnabled ? findActiveEffectRuntime() : null;
      const effectWriteVersion = runtime ? readFiniteProperty(runtime.effect, 'wv') : null;
      const triggerRecord = runtime ? effectByReaction.get(runtime.effect) ?? record : record;
      if (triggerRecord !== record) triggerRecord.pendingFinalize?.(true);
      const triggerCapture = runtime && effectWriteVersion !== null
        ? captureWithRuntime(runtime.adapter, runtime.effect, effectWriteVersion, {
            includeCreatedStacks: false,
            includeUpdatedStacks: true
          })
        : null;
      if (triggerCapture && triggerRecord.pendingTriggerCapture === null) {
        triggerRecord.pendingTriggerCapture = triggerCapture;
        queueMicrotask(() => {
          if (triggerRecord.pendingTriggerCapture === triggerCapture) {
            triggerRecord.pendingTriggerCapture = null;
          }
        });
      }
      const startedAt = captureEnabled ? performance.now() : 0;
      let outcome: 'ok' | 'error' = 'ok';
      let errorDetail: JsonValue | null = null;
      try {
        return Reflect.apply(cleanup, this, args);
      } catch (error) {
        outcome = 'error';
        record.errorCount++;
        record.status = 'error';
        errorDetail = effectErrorDetail(error);
        record.lastError = errorDetail;
        throw error;
      } finally {
        if (captureEnabled) {
          const detail: Record<string, JsonValue> = {
            effectId: record.id,
            siteId: record.descriptor.siteId,
            kind: record.descriptor.kind,
            source: { ...record.descriptor.source },
            originatingRun,
            cleanupCount: record.cleanupCount,
            syncDurationMs: Math.max(0, performance.now() - startedAt),
            outcome
          };
          if (errorDetail !== null) detail.error = errorDetail;
          pushTrace('effect-cleanup', record.componentId ?? undefined, detail);
          scheduleSnapshot();
        }
      }
    };
  }

  function findActiveEffectRuntime(): { adapter: EffectRuntimeAdapter; effect: object } | null {
    if (!supportsEffectRuntimeVersion()) return null;
    for (const resolve of runtimeResolvers) {
      try {
        const adapter = resolve();
        if (!isEffectRuntimeAdapter(adapter) || !isEffectObject(adapter.activeEffect)) continue;
        return { adapter, effect: adapter.activeEffect };
      } catch {
        // Try another installed Svelte runtime if this one is inactive or changed shape.
      }
    }
    return null;
  }

  function supportsEffectRuntimeVersion(): boolean {
    const version = readSvelteVersion();
    if (version === null) return true;
    return version.split(',').some((candidate) => {
      const normalized = candidate.trim();
      // Svelte's public dev marker currently exposes the major version only.
      // Accepting `5` is therefore the real-world path; a full version, when a
      // host supplies one, still gets the private-shape compatibility floor.
      if (normalized === '5') return true;
      const match = /^5\.(\d+)(?:\.|$)/.exec(normalized);
      return Boolean(match && Number(match[1]) >= 39);
    });
  }

  function bindEffectReaction(record: EffectRecord, effect: object): void {
    if (record.effectObject === null) {
      record.effectObject = effect;
      effectByReaction.set(effect, record);
      let parent = readObjectProperty(effect, 'parent');
      const seen = new Set<object>();
      while (parent && seen.size < MAX_STACK_DEPTH && !seen.has(parent)) {
        seen.add(parent);
        const owner = effectByReaction.get(parent);
        if (owner && owner !== record) {
          record.parentEffectId = owner.id;
          break;
        }
        parent = readObjectProperty(parent, 'parent');
      }
    }
  }

  function emptyDependencyCapture(): DependencyCapture {
    return { dependencies: [], directCount: 0, truncated: false };
  }

  function createEffectPreviewBudget(): PreviewBudget {
    return { nodes: 600, chars: 24_000, seen: new Map(), nextRef: 1 };
  }

  function createEffectStackBudget(): PreviewBudget {
    return { nodes: 200, chars: 48_000, seen: new Map(), nextRef: 1 };
  }

  function captureDependencies(
    effect: object,
    effectWriteVersion: number,
    previewBudget: PreviewBudget,
    stackBudget: PreviewBudget,
    options: DependencyCaptureOptions
  ): DependencyCapture {
    const directRead = readBoundedArrayProperty(effect, 'deps', MAX_EFFECT_DEPENDENCIES);
    if (!directRead) return emptyDependencyCapture();
    const direct = directRead.values;
    const captured: CapturedDependency[] = [];
    const seen = new Set<object>();
    const directSignals = new Set(direct);
    const derivedQueue: Array<{ signal: object; depth: number; parentId: string }> = [];
    let queueIndex = 0;
    let truncated = directRead.truncated;

    const capture = (
      signal: object,
      depth: number,
      isDirect: boolean,
      parentId: string | null
    ): void => {
      if (seen.has(signal) || captured.length >= MAX_EFFECT_DEPENDENCIES) return;
      seen.add(signal);
      const id = getSignalId(signal);
      const flags = readFiniteProperty(signal, 'f') ?? 0;
      const writeVersion = readFiniteProperty(signal, 'wv') ?? 0;
      const labelValue = readDataProperty(signal, 'label');
      const label = typeof labelValue === 'string' && labelValue.length > 0
        ? truncate(labelValue, 512)
        : `signal ${id.split(':').at(-1) ?? id}`;
      const childrenRead = (flags & 2) !== 0
        ? readBoundedArrayProperty(signal, 'deps', MAX_EFFECT_DEPENDENCIES)
        : null;
      const children = childrenRead?.values ?? null;
      if (childrenRead?.truncated) truncated = true;
      const kind = (flags & 2) !== 0
        ? 'derived'
        : label.startsWith('$')
          ? 'store'
          : 'state';
      previewBudget.seen.clear();
      previewBudget.nextRef = 1;
      const dependency: CapturedDependency = {
        signal,
        id,
        label,
        kind,
        value: effectPreview(readDataProperty(signal, 'v'), previewBudget),
        writeVersion,
        dirty: effectWriteVersion !== 0 && writeVersion > effectWriteVersion,
        depth,
        direct: isDirect,
        parentId
      };
      if (options.includeCreatedStacks && captured.length < 10) {
        const createdAt = readErrorStack(readDataProperty(signal, 'created'), stackBudget);
        if (createdAt) dependency.createdAt = createdAt;
      }
      if (options.includeUpdatedStacks) {
        const updatedAt = readUpdatedStacks(readDataProperty(signal, 'updated'), stackBudget);
        if (updatedAt.length > 0) dependency.updatedAt = updatedAt;
      }
      captured.push(dependency);

      if (children && depth < MAX_EFFECT_DEPENDENCY_DEPTH) {
        const childLimit = Math.min(children.length, MAX_EFFECT_DEPENDENCIES);
        if (children.length > childLimit) truncated = true;
        for (let index = 0; index < childLimit; index++) {
          const child = children[index];
          // Direct reads win over derived expansion, even when the same signal
          // appears earlier through a derived's dependency graph.
          if (isObjectValue(child) && !directSignals.has(child)) {
            derivedQueue.push({ signal: child, depth: depth + 1, parentId: id });
          }
        }
      } else if (children && children.length > 0) {
        truncated = true;
      }
    };

    // Preserve the runtime's direct dependency order and reserve the whole
    // budget for direct reads before recursively expanding derived sources.
    for (const signal of direct) {
      if (captured.length >= MAX_EFFECT_DEPENDENCIES) break;
      capture(signal, 0, true, null);
    }

    while (queueIndex < derivedQueue.length && captured.length < MAX_EFFECT_DEPENDENCIES) {
      const item = derivedQueue[queueIndex++];
      if (item) capture(item.signal, item.depth, false, item.parentId);
    }
    if (queueIndex < derivedQueue.length) truncated = true;
    return { dependencies: captured, directCount: directRead.length, truncated };
  }

  function captureWithRuntime(
    adapter: EffectRuntimeAdapter,
    effect: object,
    effectWriteVersion: number,
    options: DependencyCaptureOptions = {
      includeCreatedStacks: true,
      includeUpdatedStacks: true
    }
  ): DependencyCapture {
    try {
      return adapter.untrack(() => captureDependencies(
        effect,
        effectWriteVersion,
        createEffectPreviewBudget(),
        createEffectStackBudget(),
        options
      ));
    } catch {
      return { dependencies: [], directCount: 0, truncated: true };
    }
  }

  function resumeEffectCapture(record: EffectRecord): void {
    refreshEffectStatus(record);
    if (record.status === 'disposed' || !record.effectObject || !record.runtimeAdapter) return;
    const effectWriteVersion = readFiniteProperty(record.effectObject, 'wv');
    if (effectWriteVersion === null) return;
    const capture = captureWithRuntime(record.runtimeAdapter, record.effectObject, effectWriteVersion);
    const baselines = new Map<object, DependencyBaseline>();
    for (const dependency of capture.dependencies) {
      baselines.set(dependency.signal, {
        id: dependency.id,
        value: dependency.value,
        writeVersion: dependency.writeVersion
      });
    }
    record.baselines = baselines;
    record.dependencies = capture.dependencies.map(dependencyDetail);
    record.directDependencyCount = capture.directCount;
    record.dependencyTruncated = capture.truncated;
    record.adapterStatus = 'exact';
    record.captureGap = false;
    // The graph above is a fresh resume baseline, not evidence for the latest
    // callback execution. Do not combine it with an older run's cause/timing.
    record.triggers = [];
    record.addedDependencyIds = [];
    record.removedDependencyIds = [];
    record.lastSyncDurationMs = null;
    record.lastRunId = null;
  }

  function finalizeEffectRun(
    record: EffectRecord,
    runtime: { adapter: EffectRuntimeAdapter; effect: object } | null,
    effect: object | null,
    runIndex: number,
    phase: 'initial' | 'rerun',
    duration: number,
    entryDependencies: DependencyCapture,
    afterDependencies: DependencyCapture,
    error: JsonValue | null,
    cleanupRegistered: boolean,
    runAt: number,
    overlapped: boolean
  ): void {
    if (effectRecords.get(record.id) !== record || !recording) return;
    const hadCaptureGap = record.captureGap || overlapped;
    const previousBaselines = record.baselines;
    const committedWriteVersion = effect ? readFiniteProperty(effect, 'wv') : null;
    const committedCapture = !overlapped && runtime && effect && committedWriteVersion !== null
      ? captureWithRuntime(runtime.adapter, effect, committedWriteVersion)
      : { dependencies: [], directCount: 0, truncated: overlapped };
    const committed = committedCapture.dependencies;
    const afterById = new Map(
      afterDependencies.dependencies.map((dependency) => [dependency.id, dependency])
    );
    const triggers: JsonValue[] = [];
    if (phase === 'rerun') {
      for (const entry of entryDependencies.dependencies) {
        if (!entry.dirty) continue;
        const latest = afterById.get(entry.id) ?? entry;
        const baseline = previousBaselines.get(entry.signal);
        const trigger: Record<string, JsonValue> = {
          id: entry.id,
          label: entry.label,
          kind: entry.kind,
          invalidated: true,
          direct: entry.direct,
          current: entry.value,
          writeVersion: entry.writeVersion,
          previewChanged: hadCaptureGap || !baseline
            ? null
            : jsonPreviewKey(baseline.value) !== jsonPreviewKey(entry.value)
        };
        if (
          latest.writeVersion !== entry.writeVersion ||
          jsonPreviewKey(latest.value) !== jsonPreviewKey(entry.value)
        ) {
          trigger.afterCallback = latest.value;
          trigger.afterCallbackWriteVersion = latest.writeVersion;
        }
        if (entry.parentId) trigger.viaDerivedId = entry.parentId;
        if (!hadCaptureGap && baseline) trigger.before = baseline.value;
        if (entry.updatedAt && entry.updatedAt.length > 0) trigger.updatedAt = entry.updatedAt;
        triggers.push(trigger);
      }
    }

    const previousIds = new Set(Array.from(previousBaselines.values(), (baseline) => baseline.id));
    const committedIds = new Set(committed.map((dependency) => dependency.id));
    const addedDependencyIds = hadCaptureGap
      ? []
      : Array.from(committedIds).filter((id) => !previousIds.has(id));
    const removedDependencyIds = hadCaptureGap
      ? []
      : Array.from(previousIds).filter((id) => !committedIds.has(id));
    const nextBaselines = new Map<object, DependencyBaseline>();
    for (const dependency of committed) {
      nextBaselines.set(dependency.signal, {
        id: dependency.id,
        value: dependency.value,
        writeVersion: dependency.writeVersion
      });
    }
    if (!overlapped) {
      record.baselines = nextBaselines;
      record.dependencies = committed.map(dependencyDetail);
      record.directDependencyCount = committedCapture.directCount;
      record.dependencyTruncated = committedCapture.truncated;
    }
    record.triggers = triggers;
    record.addedDependencyIds = addedDependencyIds;
    record.removedDependencyIds = removedDependencyIds;
    record.captureGap = overlapped;
    if (!overlapped) record.capturedRunCount++;
    refreshEffectStatus(record);

    const reason = hadCaptureGap
      ? 'capture-gap'
      : phase === 'initial'
        ? 'initial'
        : triggers.length > 0
          ? 'dependencies'
          : runtime
            ? 'runtime-scheduled'
            : 'runtime-unavailable';
    const detail: Record<string, JsonValue> = {
      effectId: record.id,
      siteId: record.descriptor.siteId,
      kind: record.descriptor.kind,
      source: { ...record.descriptor.source },
      parentEffectId: record.parentEffectId,
      runCount: runIndex,
      rerunCount: Math.max(0, runIndex - 1),
      capturedRunCount: record.capturedRunCount,
      timedRunCount: record.timedRunCount,
      phase,
      reason,
      syncDurationMs: duration,
      outcome: error === null ? 'ok' : 'error',
      cleanupRegistered,
      cleanupCount: record.cleanupCount,
      errorCount: record.errorCount,
      adapter: runtime ? 'svelte-5-dev-internals' : 'unavailable',
      captureGap: hadCaptureGap,
      triggers,
      dependencies: overlapped ? [] : record.dependencies,
      directDependencyCount: overlapped ? 0 : record.directDependencyCount,
      dependencyTruncated: overlapped || record.dependencyTruncated,
      addedDependencyIds,
      removedDependencyIds
    };
    if (error !== null) detail.error = error;
    const trace = pushTrace('effect-run', record.componentId ?? undefined, detail);
    record.lastRunId = trace?.id ?? null;
    record.recentRuns.push({
      runCount: runIndex,
      phase,
      at: runAt,
      syncDurationMs: duration,
      outcome: error === null ? 'ok' : 'error',
      reason,
      triggerIds: triggers.flatMap((trigger) => {
        const value = isObject(trigger) ? trigger.id : null;
        return typeof value === 'string' ? [value] : [];
      })
    });
    if (record.recentRuns.length > MAX_EFFECT_RUNS) {
      record.recentRuns.splice(0, record.recentRuns.length - MAX_EFFECT_RUNS);
    }
    scheduleSnapshot();
    scheduleHello();
  }

  function dependencyDetail(dependency: CapturedDependency): JsonValue {
    const detail: Record<string, JsonValue> = {
      id: dependency.id,
      label: dependency.label,
      kind: dependency.kind,
      value: dependency.value,
      writeVersion: dependency.writeVersion,
      dirty: dependency.dirty,
      depth: dependency.depth,
      direct: dependency.direct,
      parentId: dependency.parentId
    };
    if (dependency.createdAt) detail.createdAt = dependency.createdAt;
    if (dependency.updatedAt && dependency.updatedAt.length > 0) detail.updatedAt = dependency.updatedAt;
    return detail;
  }

  function effectSnapshotDetail(record: EffectRecord): JsonValue {
    refreshEffectStatus(record);
    return {
      id: record.id,
      siteId: record.descriptor.siteId,
      componentId: record.componentId,
      parentEffectId: record.parentEffectId,
      kind: record.descriptor.kind,
      source: { ...record.descriptor.source },
      status: record.status,
      adapter: record.adapterStatus,
      runCount: record.runCount,
      rerunCount: Math.max(0, record.runCount - 1),
      phase: record.runCount <= 1 ? 'initial' : 'rerun',
      outcome: record.lastOutcome,
      capturedRunCount: record.capturedRunCount,
      timedRunCount: record.timedRunCount,
      cleanupCount: record.cleanupCount,
      cleanupRegistered: record.cleanupRegistered,
      errorCount: record.errorCount,
      lastSyncDurationMs: record.lastSyncDurationMs,
      maxSyncDurationMs: record.maxSyncDurationMs,
      totalSyncDurationMs: record.totalSyncDurationMs,
      averageSyncDurationMs: record.timedRunCount > 0
        ? record.totalSyncDurationMs / record.timedRunCount
        : null,
      lastRunAt: record.lastRunAt,
      lastRunId: record.lastRunId,
      dependencyCount: record.dependencies.length,
      directDependencyCount: record.directDependencyCount,
      dependencyTruncated: record.dependencyTruncated,
      dependencies: record.dependencies,
      triggers: record.triggers,
      addedDependencyIds: record.addedDependencyIds,
      removedDependencyIds: record.removedDependencyIds,
      captureGap: record.captureGap,
      recentRuns: record.recentRuns,
      lastError: record.lastError
    };
  }

  function refreshEffectStatus(record: EffectRecord): void {
    const effect = record.effectObject;
    if (!effect) return;
    const flags = readFiniteProperty(effect, 'f');
    const fn = readDataProperty(effect, 'fn');
    if ((flags !== null && (flags & (1 << 14)) !== 0) || fn === null) {
      record.status = 'disposed';
    }
  }

  function getSignalId(signal: object): string {
    const existing = signalIds.get(signal);
    if (existing) return existing;
    const id = `sig:${++signalCounter}`;
    signalIds.set(signal, id);
    return id;
  }

  function readUpdatedStacks(value: unknown, budget: PreviewBudget): string[] {
    if (!(value instanceof Map)) return [];
    const stacks: string[] = [];
    try {
      for (const item of value.values()) {
        const error = isObjectValue(item) ? readDataProperty(item, 'error') : null;
        const stack = readErrorStack(error, budget);
        if (stack) stacks.push(stack);
        if (stacks.length >= 3) break;
      }
    } catch {
      return stacks;
    }
    return stacks;
  }

  function readErrorStack(value: unknown, budget: PreviewBudget): string | null {
    if (!(value instanceof Error)) return null;
    return typeof value.stack === 'string'
      ? previewText(value.stack, budget, 2_048)
      : previewText(value.message, budget, 2_048);
  }

  function effectErrorDetail(error: unknown): JsonValue {
    try {
      if (error instanceof Error) {
        const detail: Record<string, JsonValue> = {
          name: truncate(error.name || 'Error', 256),
          message: truncate(error.message || error.name, MAX_PREVIEW_STRING)
        };
        if (typeof error.stack === 'string') detail.stack = truncate(error.stack, 8_192);
        return detail;
      }
    } catch {
      return { name: 'Error', message: 'Error details unavailable' };
    }
    return { name: 'Error', message: truncate(errorMessage(error), MAX_PREVIEW_STRING) };
  }

  function jsonPreviewKey(value: JsonValue): string {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unavailable]';
    }
  }

  function beginComponent(candidate: ComponentDescriptor): string | null {
    try {
      if (!isDescriptor(candidate) || components.size >= MAX_COMPONENTS) return null;
      if (recording) {
        ensureObserver(true);
        const activeParentId = findActiveParent();
        drainPendingMutations(activeParentId ? components.get(activeParentId) : undefined);
      }
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
        lastPreview: new Map(),
        effects: new Set()
      };
      components.set(id, record);
      activeComponents.push(id);
      if (recording) {
        scheduleReconcile();
        scheduleSnapshot();
      }
      scheduleHello();
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
    const effectIds = Array.from(record.effects);
    // Preserve causal timeline order when an error boundary synchronously
    // unmounts: the throwing effect receipt must precede the unmount receipt.
    for (const effectId of effectIds) effectRecords.get(effectId)?.pendingFinalize?.(false);
    pushTrace('unmount', id, {
      lifetimeMs: Math.max(0, performance.now() - record.mountedAt),
      updateCount: record.updateCount,
      effectCount: effectIds.length
    });
    for (const effectId of effectIds) removeEffectRecord(effectId);
    releaseComponentCheckpoints(record);
    components.delete(id);
    omittedEffectsByComponent.delete(id);
    if (timelineMode === 'live') releaseLiveBaseline(id);
    if (record.invocationEntry && entryOwners.get(record.invocationEntry) === id) {
      entryParentHints.set(record.invocationEntry, record.parentId);
      entryOwners.delete(record.invocationEntry);
    }
    const stackIndex = activeComponents.lastIndexOf(id);
    if (stackIndex !== -1) activeComponents.splice(stackIndex, 1);
    for (const element of record.elements) {
      if (elementOwners.get(element) === id) elementOwners.delete(element);
    }
    if (pendingHighlight?.componentId === id) cancelScheduledHighlight();
    if (selectedHighlight === id) clearHighlight();
    if (recording) {
      scheduleReconcile();
      scheduleSnapshot();
    }
    scheduleHello();
  }

  function abortComponent(id: string | null, error?: unknown): void {
    if (!id) return;
    const record = components.get(id);
    if (!record) return;
    const effectIds = Array.from(record.effects);
    for (const effectId of effectIds) effectRecords.get(effectId)?.pendingFinalize?.(false);
    pushTrace('component-error', id, {
      phase: 'initialization',
      component: {
        name: record.descriptor.name,
        file: record.descriptor.file
      },
      error: effectErrorDetail(error)
    });
    for (const effectId of effectIds) removeEffectRecord(effectId);
    releaseComponentCheckpoints(record);
    components.delete(id);
    omittedEffectsByComponent.delete(id);
    releaseLiveBaseline(id);
    if (record.invocationEntry && entryOwners.get(record.invocationEntry) === id) {
      entryParentHints.set(record.invocationEntry, record.parentId);
      entryOwners.delete(record.invocationEntry);
    }
    const stackIndex = activeComponents.lastIndexOf(id);
    if (stackIndex !== -1) activeComponents.splice(stackIndex, 1);
    for (const element of record.elements) {
      if (elementOwners.get(element) === id) elementOwners.delete(element);
    }
    if (pendingHighlight?.componentId === id) cancelScheduledHighlight();
    if (selectedHighlight === id) clearHighlight();
    if (recording) {
      scheduleReconcile();
      scheduleSnapshot();
    } else if (activeComponents.length === 0) {
      stopObserver();
    }
    scheduleHello();
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
        send({ type: 'trace', payload: { events: trailingTraceBatch(traceHistory) } });
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
          for (const effect of effectRecords.values()) resumeEffectCapture(effect);
          let capturedBaselines = 0;
          for (const record of components.values()) {
            const checkpoint = hasWritableState(record) && capturedBaselines < MAX_RETAINED_CHECKPOINTS
              ? captureCheckpoint(record, 'init')
              : null;
            if (checkpoint) capturedBaselines++;
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
        scheduleHighlight(command.componentId, command.reveal ?? false);
        return;
      case 'inspect-rune-object':
        inspectRuneObject(command);
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
        timeTravel,
        effects: runtimeResolvers.length > 0 || effectRecords.size > 0,
        runeObjects: true
      }
    } as const;
    const signature = JSON.stringify(payload);
    if (!force && signature === lastHelloSignature) return;
    lastHelloSignature = signature;
    send({ type: 'hello', payload });
  }

  function scheduleHello(): void {
    if (helloQueued) return;
    helloQueued = true;
    queueMicrotask(() => {
      helloQueued = false;
      if (host[PAGE_HOOK_KEY] === sentinel) emitHello();
    });
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
    if (requestId !== undefined) {
      cancelScheduledSnapshot();
      needsFullScan = true;
      reconcileDirty = true;
    }
    if (reconcileDirty) {
      cancelScheduledReconcile();
      reconcileDom();
      reconcileDirty = false;
    }
    const nodes = buildSnapshotNodes();
    const runeObjectSummaries = buildRuneObjectSummaries();
    const payload = {
      revision: ++snapshotRevision,
      capturedAt: Date.now(),
      nodes,
      runeObjects: runeObjectSummaries
    } as {
      requestId?: string;
      revision: number;
      capturedAt: number;
      nodes: SnapshotNode[];
      runeObjects: RuneObjectSummary[];
    };
    if (requestId !== undefined) payload.requestId = requestId;
    send({ type: 'snapshot', payload });
  }

  function scheduleSnapshot(): void {
    if (!recording || !connected) return;
    const now = performance.now();
    if (snapshotQueuedAt === 0) snapshotQueuedAt = now;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    const elapsed = Math.max(0, now - snapshotQueuedAt);
    const delay = Math.max(0, Math.min(SNAPSHOT_QUIET_MS, SNAPSHOT_MAX_WAIT_MS - elapsed));
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      snapshotQueuedAt = 0;
      emitSnapshot();
    }, delay);
  }

  function scheduleReconcile(): void {
    reconcileDirty = true;
    if (reconcileFrame !== null) return;
    reconcileFrame = pageWindow.requestAnimationFrame(() => {
      reconcileFrame = null;
      if (!reconcileDirty) return;
      reconcileDom();
      reconcileDirty = false;
      emitHello();
    });
  }

  function cancelScheduledReconcile(): void {
    if (reconcileFrame === null) return;
    pageWindow.cancelAnimationFrame(reconcileFrame);
    reconcileFrame = null;
  }

  function cancelScheduledSnapshot(): void {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = null;
    snapshotQueuedAt = 0;
  }

  function reconcileDom(): void {
    pruneObservedRoots();
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
    if (!rememberObservedRoot(root)) return;
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

  function pruneObservedRoots(): void {
    let removed = false;
    for (const root of observedRoots) {
      if (root instanceof ShadowRootCtor && !root.host.isConnected) {
        observedRoots.delete(root);
        removed = true;
      }
    }
    if (!removed || !observerStarted) return;
    observer.disconnect();
    for (const root of observedRoots) observeRoot(root);
  }

  function rememberObservedRoot(root: Document | ShadowRoot): boolean {
    if (observedRoots.has(root)) return true;
    if (observedRoots.size >= MAX_OBSERVED_ROOTS) return false;
    observedRoots.add(root);
    return true;
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

  function buildRuneObjectSummaries(): RuneObjectSummary[] {
    const summaries: RuneObjectSummary[] = [];
    let remainingFields = MAX_RUNE_SUMMARY_FIELDS;
    let remainingChars = MAX_RUNE_SUMMARY_CHARS;
    for (const [id, record] of runeObjects) {
      if (record.target.deref() === undefined) {
        runeObjects.delete(id);
        continue;
      }
      const descriptor = record.descriptor;
      const baseChars = descriptor.name.length + descriptor.file.length + descriptor.source.file.length + 64;
      if (baseChars > remainingChars) break;
      remainingChars -= baseChars;
      const includedFields: NormalizedRuneField[] = [];
      for (const field of descriptor.fields) {
        if (includedFields.length >= remainingFields) break;
        const fieldChars = field.name.length + field.source.file.length + 32;
        if (fieldChars > remainingChars) break;
        includedFields.push(field);
        remainingChars -= fieldChars;
      }
      const summary: RuneObjectSummary = {
        id,
        name: descriptor.name,
        file: descriptor.file,
        source: copySource(descriptor.source),
        fields: includedFields.map((field) => ({
          name: field.name,
          kind: field.kind,
          source: copySource(field.source)
        })),
        totalFields: descriptor.totalFields,
        truncated: descriptor.truncated || includedFields.length < descriptor.fields.length
      };
      if (record.ownerComponentId && components.has(record.ownerComponentId)) {
        summary.ownerComponentId = record.ownerComponentId;
      }
      summaries.push(summary);
      remainingFields -= includedFields.length;
      if (
        summaries.length >= MAX_RUNE_OBJECT_SUMMARIES ||
        remainingFields <= 0 ||
        remainingChars <= 0
      ) break;
    }
    return summaries;
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
        effects: Array.from(record.effects)
          .map((effectId) => effectRecords.get(effectId))
          .filter((effect): effect is EffectRecord => Boolean(effect))
          .map(effectSnapshotDetail),
        effectTotal: record.effects.size + (omittedEffectsByComponent.get(record.id) ?? 0),
        effectsOmitted: omittedEffectsByComponent.get(record.id) ?? 0,
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
      result[name] = isWritableStateAdapter(adapter);
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
    if (detail !== undefined) trace.detail = fitTraceDetail(detail, kind);
    const traceJsonSize = serializedJsonLength(trace);
    traceJsonSizes.set(trace, traceJsonSize);
    traceHistory.push(trace);
    traceHistoryJsonChars += traceJsonSize;
    while (
      traceHistory.length > MAX_TRACE_HISTORY ||
      traceHistoryJsonChars > MAX_TRACE_HISTORY_JSON_CHARS
    ) {
      const removed = traceHistory.shift();
      if (!removed) break;
      traceHistoryJsonChars -= traceJsonSizes.get(removed) ?? 0;
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
      const events: TraceRecord[] = [];
      let chars = 0;
      while (traceBatch.length > 0 && events.length < MAX_TRACE_BATCH) {
        const next = traceBatch[0];
        if (!next) break;
        const nextChars = traceJsonSizes.get(next) ?? serializedJsonLength(next);
        if (events.length > 0 && chars + nextChars > MAX_TRACE_BATCH_JSON_CHARS) break;
        traceBatch.shift();
        events.push(next);
        chars += nextChars;
      }
      send({ type: 'trace', payload: { events } });
      if (traceBatch.length > 0) queueTraceFlush();
    });
  }

  function trailingTraceBatch(history: TraceRecord[]): TraceRecord[] {
    const events: TraceRecord[] = [];
    let chars = 0;
    for (let index = history.length - 1; index >= 0 && events.length < MAX_TRACE_BATCH; index--) {
      const trace = history[index];
      if (!trace) continue;
      const nextChars = traceJsonSizes.get(trace) ?? serializedJsonLength(trace);
      if (events.length > 0 && chars + nextChars > MAX_TRACE_BATCH_JSON_CHARS) break;
      events.push(trace);
      chars += nextChars;
    }
    return events.reverse();
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
          if (node instanceof ElementCtor) added++;
        }
        for (const node of mutation.removedNodes) {
          if (!isOverlayNode(node) && node instanceof ElementCtor) removed++;
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
      // Attribute and text changes do not alter the component tree. Rebuilding
      // ownership for those hot-path mutations made route transitions and
      // animated pages repeatedly scan the whole document.
      if (added || removed) {
        // Never traverse added subtrees inside the MutationObserver callback.
        // Route swaps can insert tens of thousands of nodes at once; the single
        // scheduled reconciliation owns that document-wide work.
        needsFullScan = true;
        scheduleReconcile();
      }
      scheduleSnapshot();
    }
  }

  function claimElementsFromMutations(
    record: ComponentRecord,
    records: MutationRecord[]
  ): void {
    const file = normalizeFile(record.descriptor.file);
    let remaining = MAX_MUTATION_CLAIM_ELEMENTS;
    for (const mutation of records) {
      if (mutation.type !== 'childList') continue;
      for (const node of mutation.addedNodes) {
        if (isOverlayNode(node)) continue;
        remaining -= visitElementTree(node, remaining, (element) => {
          const loc = readMeta(element)?.loc;
          if (!loc || normalizeFile(loc.file) !== file) return;
          trackedElements.add(element);
          elementOwners.set(element, record.id);
        });
        if (remaining <= 0) return;
      }
    }
  }

  function visitElementTree(
    node: Node,
    limit: number,
    visit: (element: Element) => void
  ): number {
    if (!(node instanceof ElementCtor) || isOverlayNode(node) || limit <= 0) return 0;
    const pending: Element[] = [node];
    let visited = 0;
    while (pending.length > 0 && visited < limit) {
      const element = pending.pop();
      if (!element || isOverlayNode(element)) continue;
      visit(element);
      visited++;
      for (
        let child = element.lastElementChild;
        child && pending.length + visited < limit;
        child = child.previousElementSibling
      ) {
        pending.push(child);
      }
    }
    return visited;
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
    cancelScheduledReconcile();
    cancelScheduledSnapshot();
    if (checkpointBudgetTimer !== null) clearTimeout(checkpointBudgetTimer);
    checkpointBudgetTimer = null;
    checkpointCaptureCount = 0;
    if (observerStarted) {
      observer.takeRecords();
      observer.disconnect();
      observerStarted = false;
      observerRecording = false;
    }
    // Shadow roots are rediscovered by the next bounded full scan. Keeping
    // detached roots here would retain entire route/HMR subtrees indefinitely.
    observedRoots.clear();
    observedRoots.add(document);
    needsFullScan = true;
    reconcileDirty = true;
  }

  function observeRoot(root: Document | ShadowRoot): void {
    if (root instanceof ShadowRootCtor && isOverlayNode(root.host)) return;
    if (!rememberObservedRoot(root)) return;
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

  function startPicker(): void {
    if (pickerActive) return;
    cancelScheduledHighlight();
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
    const cached = componentId ? elementsForId(componentId) : [];
    const elements = cached.length > 0 ? cached : [annotated];
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
    const cached = componentId ? elementsForId(componentId) : [];
    const elements = cached.length > 0 ? cached : [annotated];
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

  function scheduleHighlight(componentId: string | null, reveal: boolean): void {
    pendingHighlight = { componentId, reveal };
    if (highlightFrame !== null) return;
    highlightFrame = pageWindow.requestAnimationFrame(() => {
      highlightFrame = null;
      const next = pendingHighlight;
      pendingHighlight = null;
      if (next) highlightComponent(next.componentId, next.reveal);
    });
  }

  function cancelScheduledHighlight(): void {
    pendingHighlight = null;
    if (highlightFrame === null) return;
    pageWindow.cancelAnimationFrame(highlightFrame);
    highlightFrame = null;
  }

  function highlightComponent(componentId: string | null, reveal: boolean): void {
    if (!componentId) {
      clearHighlight();
      return;
    }
    selectedHighlight = componentId;
    revealHighlight = reveal ? componentId : null;
    const elements = elementsForId(componentId);
    if (elements.length === 0) {
      needsFullScan = true;
      scheduleReconcile();
      hideOverlay();
      return;
    }
    if (revealHighlight === componentId) {
      revealHighlight = null;
      elements[0]?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
    showOverlay(elements, labelForId(componentId, elements[0] ?? null));
  }

  function renderHighlight(componentId: string): void {
    const elements = elementsForId(componentId);
    if (elements.length === 0) {
      clearHighlight();
      return;
    }
    if (revealHighlight === componentId) {
      revealHighlight = null;
      elements[0]?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
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
    revealHighlight = null;
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
      const elements = new Set<Element>();
      for (const element of record.bounds) {
        if (element.isConnected) elements.add(element);
        if (elements.size >= MAX_HIGHLIGHT_ELEMENTS) break;
      }
      if (elements.size < MAX_HIGHLIGHT_ELEMENTS) for (const element of record.elements) {
        if (element.isConnected) elements.add(element);
        if (elements.size >= MAX_HIGHLIGHT_ELEMENTS) break;
      }
      const inferred = fallbackElements.get(id);
      if (inferred && elements.size < MAX_HIGHLIGHT_ELEMENTS) for (const element of inferred) {
        if (element.isConnected) elements.add(element);
        if (elements.size >= MAX_HIGHLIGHT_ELEMENTS) break;
      }
      return Array.from(elements);
    }
    const elements = fallbackElements.get(id);
    return elements ? boundedConnectedElements(elements, MAX_HIGHLIGHT_ELEMENTS) : [];
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
      if (element) {
        for (const entry of innerStackChain(readMeta(element)?.parent ?? null)) {
          if (getEntryId(entry) === id) return entryName(entry);
        }
      } else {
        for (const tracked of trackedElements) {
          const meta = readMeta(tracked);
          for (const entry of innerStackChain(meta?.parent ?? null)) {
            if (getEntryId(entry) === id) return entryName(entry);
          }
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
    const seen = new Set<string>();
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
          const key = `${rect.top}:${rect.left}:${rect.width}:${rect.height}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rects.push({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
        }
      } catch {
        // A page-owned custom element can throw from layout access; skip it.
      }
    }
    return rects;
  }

  function inspectRuneObject(
    command: Extract<PageCommand, { kind: 'inspect-rune-object' }>
  ): void {
    const record = runeObjects.get(command.objectId);
    const target = record?.target.deref();
    if (!record || !target) {
      if (record) runeObjects.delete(record.id);
      commandError(command.requestId, 'Rune object is no longer available');
      return;
    }

    const budget: PreviewBudget = {
      nodes: MAX_RUNE_INSPECT_NODES,
      chars: MAX_RUNE_INSPECT_CHARS,
      seen: new Map(),
      nextRef: 1
    };
    const fields = Object.create(null) as Record<string, JsonValue>;
    for (const field of record.descriptor.fields) {
      let value: JsonValue;
      try {
        value = previewInner(field.get(target), 0, budget);
      } catch (error) {
        value = errorPreview(error);
      }
      fields[field.name] = {
        kind: field.kind,
        source: sourceJson(field.source),
        value
      };
    }
    commandOk(command.requestId, {
      id: record.id,
      name: record.descriptor.name,
      file: record.descriptor.file,
      source: sourceJson(record.descriptor.source),
      ownerComponentId: record.ownerComponentId && components.has(record.ownerComponentId)
        ? record.ownerComponentId
        : null,
      fields,
      totalFields: record.descriptor.totalFields,
      truncated: record.descriptor.truncated
    });
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
    if (!adapter || !isWritableStateAdapter(adapter)) {
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
      clearLiveBaselines();
      let retained = 0;
      let attempted = 0;
      for (const record of components.values()) {
        if (!hasWritableState(record)) continue;
        if (attempted++ >= MAX_LIVE_BASELINES || retained >= MAX_LIVE_BASELINES) break;
        const baseline = captureStoredState(record);
        if (baseline.restorable) {
          if (!retainLiveBaseline(record.id, baseline)) break;
          retained++;
        }
      }
    }
    const unavailable = new Set<string>();
    for (const [record] of selections) {
      if (liveBaselines.has(record.id)) continue;
      const baseline = captureStoredState(record);
      if (baseline.restorable && retainLiveBaseline(record.id, baseline)) {
        // Retained above.
      } else {
        unavailable.add(record.id);
        failures.push({
          componentId: record.id,
          reason: `Cannot enter time travel without a live baseline: ${baseline.reason ?? 'global live-baseline budget exhausted'}`
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
      clearLiveBaselines();
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
      let captured = 0;
      for (const record of components.values()) {
        if (hasWritableState(record) && captured < MAX_RETAINED_CHECKPOINTS) {
          captureCheckpoint(record, 'live');
          captured++;
        }
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
    clearLiveBaselines();
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
  ): Checkpoint | null {
    if (!reserveCheckpointCapture()) return null;
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
      restorable: stored.restorable,
      retainedNodes: stored.retainedNodes,
      retainedBytes: stored.retainedBytes
    };
    if (stored.reason) checkpoint.reason = stored.reason;
    retainCheckpoint(record, checkpoint);
    return checkpoint;
  }

  function reserveCheckpointCapture(): boolean {
    if (checkpointCaptureCount >= MAX_CHECKPOINT_CAPTURES_PER_FRAME) return false;
    checkpointCaptureCount++;
    if (checkpointBudgetTimer === null) {
      checkpointBudgetTimer = setTimeout(() => {
        checkpointBudgetTimer = null;
        checkpointCaptureCount = 0;
      }, 16);
    }
    return true;
  }

  function retainCheckpoint(record: ComponentRecord, checkpoint: Checkpoint): void {
    record.checkpoints.push(checkpoint);
    retainedCheckpoints.push({ componentId: record.id, checkpoint });
    retainedCheckpointNodes += checkpoint.retainedNodes;
    retainedCheckpointBytes += checkpoint.retainedBytes;

    while (record.checkpoints.length > MAX_CHECKPOINTS) {
      const oldest = record.checkpoints[0];
      if (!oldest) break;
      releaseCheckpoint(record, oldest);
    }
    while (
      retainedCheckpoints.length > MAX_RETAINED_CHECKPOINTS ||
      retainedCheckpointNodes > MAX_RETAINED_CHECKPOINT_NODES ||
      retainedCheckpointBytes > MAX_RETAINED_CHECKPOINT_BYTES
    ) {
      const oldest = retainedCheckpoints[0];
      if (!oldest) break;
      const owner = components.get(oldest.componentId);
      if (owner) releaseCheckpoint(owner, oldest.checkpoint);
      else releaseRetainedCheckpointReference(oldest.checkpoint);
    }
  }

  function releaseCheckpoint(record: ComponentRecord, checkpoint: Checkpoint): void {
    const recordIndex = record.checkpoints.indexOf(checkpoint);
    if (recordIndex !== -1) record.checkpoints.splice(recordIndex, 1);
    releaseRetainedCheckpointReference(checkpoint);
  }

  function releaseRetainedCheckpointReference(checkpoint: Checkpoint): void {
    const retainedIndex = retainedCheckpoints.findIndex((entry) => entry.checkpoint === checkpoint);
    if (retainedIndex === -1) return;
    retainedCheckpoints.splice(retainedIndex, 1);
    retainedCheckpointNodes = Math.max(0, retainedCheckpointNodes - checkpoint.retainedNodes);
    retainedCheckpointBytes = Math.max(0, retainedCheckpointBytes - checkpoint.retainedBytes);
  }

  function releaseComponentCheckpoints(record: ComponentRecord): void {
    for (const checkpoint of [...record.checkpoints]) releaseCheckpoint(record, checkpoint);
  }

  function retainLiveBaseline(componentId: string, baseline: StoredState): boolean {
    if (
      liveBaselineNodes + baseline.retainedNodes > MAX_RETAINED_CHECKPOINT_NODES ||
      liveBaselineBytes + baseline.retainedBytes > MAX_RETAINED_CHECKPOINT_BYTES
    ) {
      return false;
    }
    releaseLiveBaseline(componentId);
    liveBaselines.set(componentId, baseline);
    liveBaselineNodes += baseline.retainedNodes;
    liveBaselineBytes += baseline.retainedBytes;
    return true;
  }

  function releaseLiveBaseline(componentId: string): void {
    const baseline = liveBaselines.get(componentId);
    if (!baseline) return;
    liveBaselines.delete(componentId);
    liveBaselineNodes = Math.max(0, liveBaselineNodes - baseline.retainedNodes);
    liveBaselineBytes = Math.max(0, liveBaselineBytes - baseline.retainedBytes);
  }

  function clearLiveBaselines(): void {
    liveBaselines.clear();
    liveBaselineNodes = 0;
    liveBaselineBytes = 0;
  }

  function captureStoredState(record: ComponentRecord): StoredState {
    const values = new Map<string, StoredValue>();
    const reasons: string[] = [];
    const budget = createCloneBudget();
    let writable = 0;
    for (const [name, adapter] of safeEntries(record.descriptor.state)) {
      if (!isWritableStateAdapter(adapter)) continue;
      writable++;
      try {
        const current = adapter.get();
        const cloned = cloneForStorage(current, budget);
        const stored: StoredValue = {
          value: cloned.value,
          restorable: cloned.ok
        };
        if (cloned.reason) stored.reason = cloned.reason;
        values.set(name, stored);
        if (!cloned.ok) {
          reasons.push(`${name}: ${cloned.reason ?? 'unsupported value'}`);
          break;
        }
      } catch (error) {
        const reason = errorMessage(error);
        values.set(name, {
          value: undefined,
          restorable: false,
          reason
        });
        reasons.push(`${name}: ${reason}`);
        break;
      }
    }
    if (writable === 0) reasons.push('Component has no writable state bindings');
    // A partially captured component can never be restored transactionally.
    // Drop partial clones immediately instead of retaining dead weight.
    if (reasons.length > 0) values.clear();
    const result: StoredState = {
      values,
      restorable: writable > 0 && reasons.length === 0,
      retainedNodes: reasons.length === 0 ? MAX_CHECKPOINT_NODES - budget.nodes : 0,
      retainedBytes: reasons.length === 0 ? MAX_CHECKPOINT_BYTES - budget.bytes : 0
    };
    if (reasons.length > 0) result.reason = reasons.join('; ');
    return result;
  }

  function applyStoredState(record: ComponentRecord, stored: StoredState): string | null {
    if (!stored.restorable) return stored.reason ?? 'Checkpoint is not restorable';
    const budget = createCloneBudget(2);
    const writes: Array<{
      set(value: unknown): void;
      next: unknown;
      previous: unknown;
    }> = [];
    for (const [name, value] of stored.values) {
      const adapter = record.descriptor.state[name];
      if (!adapter || !isWritableStateAdapter(adapter)) {
        return `Writable state binding "${name}" is no longer available`;
      }
      if (!value.restorable) return value.reason ?? `State binding "${name}" is not restorable`;
      const next = cloneForStorage(value.value, budget);
      if (!next.ok) return next.reason ?? `State binding "${name}" cannot be cloned`;
      let current: unknown;
      try {
        current = adapter.get();
      } catch (error) {
        return `Could not read current state "${name}": ${errorMessage(error)}`;
      }
      const previous = cloneForStorage(current, budget);
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
    return safeEntries(record.descriptor.state).some(([, adapter]) => isWritableStateAdapter(adapter));
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

function isEffectDescriptor(value: unknown): value is EffectDescriptor {
  try {
    if (!isObject(value) || !isObject(value.source)) return false;
    return (
      typeof value.siteId === 'string' &&
      value.siteId.length > 0 &&
      value.siteId.length <= 256 &&
      (value.componentId === null || (typeof value.componentId === 'string' && value.componentId.length <= 256)) &&
      (value.kind === 'effect' || value.kind === 'pre') &&
      typeof value.source.file === 'string' &&
      value.source.file.length <= 32_768 &&
      Number.isInteger(value.source.line) &&
      (value.source.line as number) >= 0 &&
      Number.isInteger(value.source.column) &&
      (value.source.column as number) >= 0
    );
  } catch {
    return false;
  }
}

function copyEffectDescriptor(value: EffectDescriptor): EffectDescriptor {
  return {
    siteId: value.siteId,
    componentId: value.componentId,
    kind: value.kind,
    source: copySource(value.source)
  };
}

function isEffectRuntimeAdapter(value: unknown): value is EffectRuntimeAdapter {
  return (
    isObject(value) &&
    typeof value.untrack === 'function'
  );
}

function isEffectObject(value: unknown): value is object {
  if (!isObjectValue(value)) return false;
  const deps = readDataProperty(value, 'deps');
  return (
    (deps === null || Array.isArray(deps)) &&
    readFiniteProperty(value, 'wv') !== null &&
    readFiniteProperty(value, 'f') !== null
  );
}

function isObjectValue(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function readDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function readFiniteProperty(value: object, key: string): number | null {
  const item = readDataProperty(value, key);
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
}

function readObjectProperty(value: object, key: string): object | null {
  const item = readDataProperty(value, key);
  return isObjectValue(item) ? item : null;
}

function readBoundedArrayProperty(
  value: object,
  key: string,
  limit: number
): BoundedObjectArray | null {
  const item = readDataProperty(value, key);
  if (item === null) return null;
  if (!Array.isArray(item)) return null;
  const values: object[] = [];
  const readLimit = Math.min(item.length, Math.max(0, limit));
  for (let index = 0; index < readLimit; index++) {
    const entry = item[index];
    if (isObjectValue(entry)) values.push(entry);
  }
  return { values, length: item.length, truncated: item.length > readLimit };
}

function isAdapterRecord(value: unknown, writable: boolean): boolean {
  if (!isObject(value)) return false;
  try {
    for (const adapter of Object.values(value)) {
      if (!isObject(adapter) || typeof adapter.get !== 'function') return false;
      if (writable && adapter.set !== undefined && typeof adapter.set !== 'function') return false;
      if (writable && adapter.canSet !== undefined && typeof adapter.canSet !== 'function') return false;
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

function sourceJson(source: SourceLocation): JsonValue {
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
  if (Array.isArray(detail.effects)) {
    const compactEffects = detail.effects.slice(0, 100).map((effect) => {
      if (!isObject(effect)) return null;
      const compactEffect = compactPlainJson(effect, 32);
      if (isObject(compactEffect)) {
        if (isObject(effect.source)) {
          const source: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
          if (typeof effect.source.file === 'string') source.file = truncate(effect.source.file, 4_096);
          if (typeof effect.source.line === 'number' && Number.isFinite(effect.source.line)) {
            source.line = effect.source.line;
          }
          if (typeof effect.source.column === 'number' && Number.isFinite(effect.source.column)) {
            source.column = effect.source.column;
          }
          compactEffect.source = source;
        }
        if (effect.lastError !== undefined) {
          compactEffect.lastError = compactTraceJson(effect.lastError, 0, {
            nodes: 256,
            chars: 16_000,
            seen: new WeakSet()
          });
        }
        compactEffect.dependencies = [];
        compactEffect.triggers = [];
        compactEffect.dependencyTruncated = true;
        compactEffect.triggerDetailOmitted = true;
        compactEffect.captureGap = true;
        compactEffect.recentRuns = Array.isArray(effect.recentRuns)
          ? effect.recentRuns.slice(-5).map((run) => isObject(run) ? compactPlainJson(run, 16) : null)
          : [];
      }
      return compactEffect;
    });
    compactDetail.effects = compactEffects;
    const reportedTotal = typeof detail.effectTotal === 'number' && Number.isFinite(detail.effectTotal)
      ? Math.max(0, Math.floor(detail.effectTotal))
      : detail.effects.length;
    compactDetail.effectTotal = reportedTotal;
    compactDetail.effectsOmitted = Math.max(0, reportedTotal - compactEffects.length);
  }
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

interface TraceJsonBudget {
  nodes: number;
  chars: number;
  seen: WeakSet<object>;
}

function fitTraceDetail(detail: JsonValue, kind?: string): JsonValue {
  const metrics = measureJson(detail);
  if (
    metrics.valid &&
    metrics.nodes <= MAX_TRACE_DETAIL_JSON_NODES &&
    metrics.chars <= MAX_TRACE_DETAIL_JSON_CHARS
  ) {
    return detail;
  }

  if (kind === 'effect-run' && isObject(detail)) {
    return compactEffectRunTraceDetail(detail, metrics);
  }

  const compact = compactTraceJson(detail, 0, {
    nodes: MAX_TRACE_DETAIL_JSON_NODES,
    chars: MAX_TRACE_DETAIL_JSON_CHARS,
    seen: new WeakSet()
  });
  const compactMetrics = measureJson(compact);
  if (
    compactMetrics.valid &&
    compactMetrics.nodes <= MAX_TRACE_DETAIL_JSON_NODES &&
    compactMetrics.chars <= MAX_TRACE_DETAIL_JSON_CHARS
  ) {
    return compact;
  }
  return {
    $type: 'truncated',
    reason: 'trace-detail-budget',
    originalNodes: metrics.nodes,
    originalChars: metrics.chars
  };
}

function compactEffectRunTraceDetail(
  detail: Record<string, unknown>,
  originalMetrics: { valid: boolean; nodes: number; chars: number }
): JsonValue {
  const compact: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const scalarKeys = [
    'effectId',
    'siteId',
    'kind',
    'parentEffectId',
    'runCount',
    'rerunCount',
    'capturedRunCount',
    'timedRunCount',
    'phase',
    'reason',
    'syncDurationMs',
    'outcome',
    'cleanupRegistered',
    'cleanupCount',
    'errorCount',
    'adapter',
    'captureGap',
    'directDependencyCount'
  ];
  for (const key of scalarKeys) {
    const value = detail[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      compact[key] = typeof value === 'string' ? truncate(value, 4_096) : value;
    }
  }
  if (isObject(detail.source)) {
    const source: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    if (typeof detail.source.file === 'string') source.file = truncate(detail.source.file, 4_096);
    if (typeof detail.source.line === 'number' && Number.isFinite(detail.source.line)) {
      source.line = detail.source.line;
    }
    if (typeof detail.source.column === 'number' && Number.isFinite(detail.source.column)) {
      source.column = detail.source.column;
    }
    compact.source = source;
  }
  if (detail.error !== undefined) {
    compact.error = compactTraceJson(detail.error, 0, {
      nodes: 256,
      chars: 16_000,
      seen: new WeakSet()
    });
  }
  compact.dependencyCount = Array.isArray(detail.dependencies) ? detail.dependencies.length : 0;
  compact.omittedTriggerCount = Array.isArray(detail.triggers) ? detail.triggers.length : 0;
  compact.dependencies = [];
  compact.triggers = [];
  compact.addedDependencyIds = [];
  compact.removedDependencyIds = [];
  compact.dependencyTruncated = true;
  compact.triggerDetailOmitted = true;
  compact.originalNodes = originalMetrics.nodes;
  compact.originalChars = originalMetrics.chars;

  const compactMetrics = measureJson(compact);
  if (
    compactMetrics.valid &&
    compactMetrics.nodes <= MAX_TRACE_DETAIL_JSON_NODES &&
    compactMetrics.chars <= MAX_TRACE_DETAIL_JSON_CHARS
  ) {
    return compact;
  }
  return {
    effectId: typeof detail.effectId === 'string' ? truncate(detail.effectId, 4_096) : 'unknown',
    kind: typeof detail.kind === 'string' ? truncate(detail.kind, 64) : 'effect',
    outcome: detail.outcome === 'error' ? 'error' : 'ok',
    dependencies: [],
    triggers: [],
    addedDependencyIds: [],
    removedDependencyIds: [],
    dependencyTruncated: true,
    triggerDetailOmitted: true,
    captureGap: true,
    reason: 'trace-detail-budget'
  };
}

function compactTraceJson(value: unknown, depth: number, budget: TraceJsonBudget): JsonValue {
  if (budget.nodes-- <= 0 || budget.chars <= 0 || depth > 16) {
    return { $type: 'truncated', reason: 'trace-detail-budget' };
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { $type: 'number', value: String(value) };
  }
  if (typeof value === 'string') {
    const result = truncate(value, Math.min(4_096, Math.max(0, budget.chars)));
    budget.chars -= result.length;
    return result;
  }
  if (typeof value !== 'object') return { $type: 'unavailable' };
  if (budget.seen.has(value)) return { $type: 'circular' };
  budget.seen.add(value);

  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    const limit = Math.min(value.length, 256);
    for (let index = 0; index < limit; index++) {
      if (budget.nodes <= 0 || budget.chars <= 0) break;
      output.push(compactTraceJson(value[index], depth + 1, budget));
    }
    if (output.length < value.length) {
      output.push({ $type: 'truncated', remaining: value.length - output.length });
    }
    return output;
  }

  const output = Object.create(null) as Record<string, JsonValue>;
  const keys = Object.keys(value);
  const limit = Math.min(keys.length, 128);
  for (let index = 0; index < limit; index++) {
    if (budget.nodes <= 0 || budget.chars <= 0) break;
    const key = keys[index];
    if (key === undefined) continue;
    const safeKey = truncate(key, Math.min(512, Math.max(0, budget.chars)));
    if (!safeKey) break;
    budget.chars -= safeKey.length;
    output[safeKey] = compactTraceJson((value as Record<string, unknown>)[key], depth + 1, budget);
  }
  if (Object.keys(output).length < keys.length) {
    output.$truncated = { $type: 'truncated', reason: 'trace-detail-budget' };
  }
  return output;
}

function serializedJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MAX_TRACE_DETAIL_JSON_CHARS;
  }
}

function connectedElements(elements: Iterable<Element>): Element[] {
  const result: Element[] = [];
  for (const element of elements) {
    if (element.isConnected) result.push(element);
  }
  return result;
}

function boundedConnectedElements(elements: Iterable<Element>, limit: number): Element[] {
  const result: Element[] = [];
  for (const element of elements) {
    if (element.isConnected) result.push(element);
    if (result.length >= limit) break;
  }
  return result;
}

function preview(value: unknown): JsonValue {
  return previewInner(value, 0, {
    nodes: 2_000,
    chars: 250_000,
    seen: new Map(),
    nextRef: 1
  });
}

function effectPreview(value: unknown, budget: PreviewBudget): JsonValue {
  return previewInner(value, 0, budget);
}

function previewInner(value: unknown, depth: number, budget: PreviewBudget): JsonValue {
  if (budget.nodes-- <= 0 || budget.chars <= 0) {
    return { $type: 'truncated', reason: budget.nodes <= 0 ? 'node-budget' : 'char-budget' };
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? previewText(value, budget) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { $type: 'number', value: String(value) };
  }
  if (typeof value === 'undefined') return { $type: 'undefined' };
  if (typeof value === 'bigint') return { $type: 'bigint', value: previewText(String(value), budget) };
  if (typeof value === 'symbol') return { $type: 'symbol', value: previewText(value.description ?? '', budget) };
  if (typeof value === 'function') {
    return { $type: 'function', name: previewText(value.name || 'anonymous', budget, 512) };
  }
  if (depth >= MAX_PREVIEW_DEPTH) {
    return { $type: 'truncated', reason: 'depth', tag: previewText(objectTag(value), budget, 256) };
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
        id: value.id ? previewText(value.id, budget, 512) : null
      };
    }
    if (value instanceof Date) {
      return {
        $type: 'date',
        value: previewText(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(), budget, 128)
      };
    }
    if (value instanceof RegExp) return { $type: 'regexp', value: previewText(String(value), budget) };
    if (value instanceof Error) {
      return {
        $type: 'error',
        name: previewText(value.name, budget, 256),
        message: previewText(value.message, budget)
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
      if (key.length > Math.min(512, budget.chars)) {
        output.$truncated = { $type: 'truncated', reason: 'char-budget' };
        break;
      }
      budget.chars -= key.length;
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
        output[key] = { $type: 'error', message: previewText(errorMessage(error), budget) };
      }
    }
    return output;
  } catch (error) {
    return { $type: 'error', message: previewText(errorMessage(error), budget) };
  }
}

function previewText(value: string, budget: PreviewBudget, limit = MAX_PREVIEW_STRING): string {
  const result = truncate(value, Math.min(limit, Math.max(0, budget.chars)));
  budget.chars -= result.length;
  return result;
}

function createCloneBudget(multiplier = 1): CloneBudget {
  return {
    nodes: MAX_CHECKPOINT_NODES * multiplier,
    entries: MAX_CHECKPOINT_ENTRIES * multiplier,
    bytes: MAX_CHECKPOINT_BYTES * multiplier,
    seen: new Map()
  };
}

function cloneForStorage(value: unknown, budget = createCloneBudget()): CloneResult {
  return cloneInner(value, 0, budget);
}

function cloneInner(value: unknown, depth: number, budget: CloneBudget): CloneResult {
  if (depth > MAX_CLONE_DEPTH) return cloneFailure('State exceeds the checkpoint depth budget');
  if (typeof value === 'function') return cloneFailure('Functions cannot be checkpointed safely');
  const primitiveBytes = typeof value === 'string'
    ? value.length * 2
    : typeof value === 'bigint'
      ? Math.min(4_096, String(value).length * 2)
      : 16;
  if (
    value === null ||
    typeof value === 'undefined' ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    const failure = reserveCloneBudget(budget, 1, 0, primitiveBytes);
    if (failure) return cloneFailure(failure);
    return { ok: true, value };
  }

  const existing = budget.seen.get(value);
  if (existing !== undefined) return { ok: true, value: existing };
  const objectFailure = reserveCloneBudget(budget, 1, 0, 48);
  if (objectFailure) return cloneFailure(objectFailure);

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
    if (value instanceof ArrayBuffer) {
      const failure = reserveBinaryCloneBudget(budget, value.byteLength);
      return failure ? cloneFailure(failure) : { ok: true, value: value.slice(0) };
    }
    if (ArrayBuffer.isView(value)) {
      if (Object.getPrototypeOf(value) !== value.constructor.prototype) {
        return cloneFailure(`${value.constructor.name} subclasses cannot be restored safely`);
      }
      const failure = reserveBinaryCloneBudget(budget, value.byteLength);
      if (failure) return cloneFailure(failure);
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
      if (value.length > MAX_CHECKPOINT_ARRAY_LENGTH) {
        return cloneFailure(`Array length exceeds the checkpoint limit of ${MAX_CHECKPOINT_ARRAY_LENGTH}`);
      }
      const keys = Object.keys(value);
      const entryFailure = reserveCloneBudget(
        budget,
        0,
        keys.length,
        keys.reduce((total, key) => total + key.length * 2, 0)
      );
      if (entryFailure) return cloneFailure(entryFailure);
      const output: unknown[] = new Array(value.length);
      budget.seen.set(value, output);
      for (const key of keys) {
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          return cloneFailure(`Array property "${key}" cannot be checkpointed safely`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) return cloneFailure(`Array index ${key} became unavailable`);
        if (!('value' in descriptor)) {
          return cloneFailure(`Array index ${key} is an accessor and cannot be checkpointed safely`);
        }
        const cloned = cloneInner(descriptor.value, depth + 1, budget);
        if (!cloned.ok) return cloned;
        output[index] = cloned.value;
      }
      return { ok: true, value: output };
    }
    if (value instanceof Map) {
      if (Object.getPrototypeOf(value) !== Map.prototype) {
        return cloneFailure(`${value.constructor.name || 'Map'} instances cannot be restored safely`);
      }
      const entryFailure = reserveCloneBudget(budget, 0, value.size, 0);
      if (entryFailure) return cloneFailure(entryFailure);
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
      const entryFailure = reserveCloneBudget(budget, 0, value.size, 0);
      if (entryFailure) return cloneFailure(entryFailure);
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
    const keys = Object.keys(value);
    const entryFailure = reserveCloneBudget(
      budget,
      0,
      keys.length,
      keys.reduce((total, key) => total + key.length * 2, 0)
    );
    if (entryFailure) return cloneFailure(entryFailure);
    for (const key of keys) {
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

function reserveBinaryCloneBudget(budget: CloneBudget, byteLength: number): string | null {
  if (byteLength > MAX_CHECKPOINT_BINARY_BYTES) {
    return `Binary state exceeds the checkpoint limit of ${MAX_CHECKPOINT_BINARY_BYTES} bytes`;
  }
  return reserveCloneBudget(budget, 0, 1, byteLength);
}

function reserveCloneBudget(
  budget: CloneBudget,
  nodes: number,
  entries: number,
  bytes: number
): string | null {
  if (nodes > budget.nodes) return 'State exceeds the checkpoint node budget';
  if (entries > budget.entries) return 'State exceeds the checkpoint entry budget';
  if (bytes > budget.bytes) return 'State exceeds the checkpoint byte budget';
  budget.nodes -= nodes;
  budget.entries -= entries;
  budget.bytes -= bytes;
  return null;
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
