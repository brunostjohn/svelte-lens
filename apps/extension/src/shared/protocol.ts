export const PROTOCOL_VERSION = 1 as const;

export const PAGE_SOURCE = 'svelte-lens/page' as const;
export const CONTENT_SOURCE = 'svelte-lens/content' as const;
export const PAGE_PORT_NAME = 'svelte-lens/page' as const;
export const PANEL_PORT_PREFIX = 'svelte-lens/panel:' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface LensRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type SnapshotNodeKind = 'component' | 'block' | 'element' | 'text' | 'unknown';

/** A framework-neutral, flat tree record emitted by the page adapter. */
export interface SnapshotNode {
  id: string;
  parentId?: string | null;
  kind: SnapshotNodeKind;
  name: string;
  source?: SourceLocation;
  detail?: JsonValue;
}

export type RuneObjectFieldKind = 'state' | 'derived';

export interface RuneObjectFieldSummary {
  name: string;
  kind: RuneObjectFieldKind;
  source: SourceLocation;
}

/** Metadata is eager; rune field values are returned only by inspect-rune-object. */
export interface RuneObjectSummary {
  id: string;
  name: string;
  file: string;
  source: SourceLocation;
  ownerComponentId?: string;
  fields: RuneObjectFieldSummary[];
  totalFields: number;
  truncated: boolean;
}

export interface HelloPayload {
  svelteVersion: string | null;
  mode: 'dev' | 'production' | 'unknown';
  capabilities: {
    inspect: boolean;
    picker: boolean;
    trace: boolean;
    state: boolean;
    timeTravel: boolean;
    effects?: boolean;
    runeObjects?: boolean;
  };
}

export interface SnapshotPayload {
  requestId?: string;
  revision: number;
  capturedAt: number;
  nodes: SnapshotNode[];
  runeObjects?: RuneObjectSummary[];
}

export interface TraceRecord {
  id: string;
  at: number;
  kind: string;
  componentId?: string;
  causeId?: string;
  detail?: JsonValue;
}

export interface TracePayload {
  events: TraceRecord[];
}

export interface PickerPayload {
  phase: 'hover' | 'selected' | 'cancelled';
  componentId?: string;
  label?: string;
  source?: SourceLocation;
  rects?: LensRect[];
}

export interface CommandResultPayload {
  requestId: string;
  ok: boolean;
  error?: string;
  data?: JsonValue;
}

export interface TimeTravelFailure {
  componentId: string;
  reason: string;
}

export interface TimeTravelResultPayload {
  requestId: string;
  ok: boolean;
  live: boolean;
  applied: number;
  failures?: TimeTravelFailure[];
}

/** Events sent from the MAIN-world page adapter toward the DevTools panel. */
export type PageEvent =
  | { type: 'hello'; payload: HelloPayload }
  | { type: 'snapshot'; payload: SnapshotPayload }
  | { type: 'trace'; payload: TracePayload }
  | { type: 'picker'; payload: PickerPayload }
  | { type: 'command-result'; payload: CommandResultPayload }
  | { type: 'time-travel-result'; payload: TimeTravelResultPayload };

export interface TimeTravelTarget {
  componentId: string;
  checkpointId: string;
}

/** Commands sent from the panel toward the MAIN-world page adapter. */
export type PageCommand =
  | { kind: 'connect' }
  | { kind: 'snapshot'; requestId: string }
  | { kind: 'record'; enabled: boolean }
  | { kind: 'picker'; action: 'start' | 'stop' }
  | { kind: 'highlight'; componentId: string | null; reveal?: boolean }
  | { kind: 'inspect-rune-object'; requestId: string; objectId: string }
  | {
      kind: 'set-value';
      requestId: string;
      componentId: string;
      path: Array<string | number>;
      value: JsonValue;
    }
  | {
      kind: 'time-travel';
      requestId: string;
      action: 'apply' | 'live';
      cursor?: number;
      targets?: TimeTravelTarget[];
    };

export type PageToPanel = PageEvent;
export type PanelToPage = PageCommand;

/** `window.postMessage` envelope: MAIN page world -> ISOLATED content world. */
export interface PageToContentMessage {
  source: typeof PAGE_SOURCE;
  v: typeof PROTOCOL_VERSION;
  sessionId: string;
  event: PageEvent;
}

/** `window.postMessage` envelope: ISOLATED content world -> MAIN page world. */
export interface ContentToPageMessage {
  source: typeof CONTENT_SOURCE;
  v: typeof PROTOCOL_VERSION;
  sessionId: string | null;
  command: PageCommand;
}

/** JSON-serialized messages crossing content <-> worker <-> panel ports. */
export type PortMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      kind: 'frame';
      sessionId: string;
      seq: number;
      event: PageEvent;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: 'panel-ready';
      sessionId: string | null;
      fromSeq: number;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: 'ack';
      sessionId: string;
      seq: number;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: 'command';
      sessionId: string | null;
      command: PageCommand;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      kind: 'gap';
      sessionId: string;
      fromSeq: number;
      toSeq: number;
    }
  | { v: typeof PROTOCOL_VERSION; kind: 'page-connected' }
  | { v: typeof PROTOCOL_VERSION; kind: 'ping'; id: number }
  | { v: typeof PROTOCOL_VERSION; kind: 'pong'; id: number };

export type PageFrame = Extract<PortMessage, { kind: 'frame' }>;
export type PanelReadyMessage = Extract<PortMessage, { kind: 'panel-ready' }>;
export type PanelCommandMessage = Extract<PortMessage, { kind: 'command' }>;

export function panelPortName(tabId: number): `${typeof PANEL_PORT_PREFIX}${number}` {
  return `${PANEL_PORT_PREFIX}${tabId}`;
}

export function pageMessage(sessionId: string, event: PageEvent): PageToContentMessage {
  return { source: PAGE_SOURCE, v: PROTOCOL_VERSION, sessionId, event };
}

export function contentMessage(
  sessionId: string | null,
  command: PageCommand
): ContentToPageMessage {
  return { source: CONTENT_SOURCE, v: PROTOCOL_VERSION, sessionId, command };
}

const SNAPSHOT_NODE_KINDS = new Set<SnapshotNodeKind>([
  'component',
  'block',
  'element',
  'text',
  'unknown'
]);

const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 75_000;
const MAX_JSON_STRING_CHARS = 2_000_000;

interface JsonBudget {
  nodes: number;
  chars: number;
  seen: WeakSet<object>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isBoundedString(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** Rejects cyclic, exotic, or unbounded values before they reach Chrome messaging. */
export function isJsonValue(value: unknown): value is JsonValue {
  return consumeJson(
    value,
    0,
    { nodes: MAX_JSON_NODES, chars: MAX_JSON_STRING_CHARS, seen: new WeakSet() }
  );
}

function consumeJson(value: unknown, depth: number, budget: JsonBudget): boolean {
  if (budget.nodes-- <= 0 || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    budget.chars -= value.length;
    return budget.chars >= 0;
  }
  if (typeof value !== 'object') return false;
  if (budget.seen.has(value)) return false;
  budget.seen.add(value);

  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_NODES) return false;
      for (const item of value) {
        if (!consumeJson(item, depth + 1, budget)) return false;
      }
      return true;
    }

    const keys = Object.keys(value);
    if (keys.length > MAX_JSON_NODES) return false;
    for (const key of keys) {
      budget.chars -= key.length;
      if (budget.chars < 0) return false;
      if (!consumeJson((value as Record<string, unknown>)[key], depth + 1, budget)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isSourceLocation(value: unknown): value is SourceLocation {
  return (
    isRecord(value) &&
    isBoundedString(value.file, 32_768) &&
    isNonNegativeInteger(value.line) &&
    isNonNegativeInteger(value.column)
  );
}

function isRect(value: unknown): value is LensRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  );
}

function isSnapshotNode(value: unknown): value is SnapshotNode {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 256) &&
    (value.parentId === undefined || value.parentId === null || isBoundedString(value.parentId, 256)) &&
    typeof value.kind === 'string' &&
    SNAPSHOT_NODE_KINDS.has(value.kind as SnapshotNodeKind) &&
    isBoundedString(value.name, 4_096) &&
    (value.source === undefined || isSourceLocation(value.source)) &&
    (value.detail === undefined || isJsonValue(value.detail))
  );
}

function isRuneObjectField(value: unknown): value is RuneObjectFieldSummary {
  return (
    isRecord(value) &&
    isBoundedString(value.name, 4_096) &&
    (value.kind === 'state' || value.kind === 'derived') &&
    isSourceLocation(value.source)
  );
}

function isRuneObjectSummary(value: unknown): value is RuneObjectSummary {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 256) &&
    isBoundedString(value.name, 4_096) &&
    isBoundedString(value.file, 32_768) &&
    isSourceLocation(value.source) &&
    (value.ownerComponentId === undefined || isBoundedString(value.ownerComponentId, 256)) &&
    Array.isArray(value.fields) &&
    value.fields.length <= 64 &&
    value.fields.every(isRuneObjectField) &&
    isNonNegativeInteger(value.totalFields) &&
    typeof value.truncated === 'boolean'
  );
}

function isHelloPayload(value: unknown): value is HelloPayload {
  if (!isRecord(value) || !isRecord(value.capabilities)) return false;
  const capabilities = value.capabilities;
  return (
    (value.svelteVersion === null || isBoundedString(value.svelteVersion, 128)) &&
    (value.mode === 'dev' || value.mode === 'production' || value.mode === 'unknown') &&
    typeof capabilities.inspect === 'boolean' &&
    typeof capabilities.picker === 'boolean' &&
    typeof capabilities.trace === 'boolean' &&
    typeof capabilities.state === 'boolean' &&
    typeof capabilities.timeTravel === 'boolean' &&
    (capabilities.effects === undefined || typeof capabilities.effects === 'boolean') &&
    (capabilities.runeObjects === undefined || typeof capabilities.runeObjects === 'boolean')
  );
}

function isSnapshotPayload(value: unknown): value is SnapshotPayload {
  return (
    isRecord(value) &&
    (value.requestId === undefined || isBoundedString(value.requestId, 256)) &&
    isNonNegativeInteger(value.revision) &&
    isFiniteNumber(value.capturedAt) &&
    Array.isArray(value.nodes) &&
    value.nodes.length <= 20_000 &&
    value.nodes.every(isSnapshotNode) &&
    (value.runeObjects === undefined ||
      (Array.isArray(value.runeObjects) &&
        value.runeObjects.length <= 1_000 &&
        value.runeObjects.every(isRuneObjectSummary)))
  );
}

function isTraceRecord(value: unknown): value is TraceRecord {
  return (
    isRecord(value) &&
    isBoundedString(value.id, 256) &&
    isFiniteNumber(value.at) &&
    isBoundedString(value.kind, 256) &&
    (value.componentId === undefined || isBoundedString(value.componentId, 256)) &&
    (value.causeId === undefined || isBoundedString(value.causeId, 256)) &&
    (value.detail === undefined || isJsonValue(value.detail))
  );
}

function isPickerPayload(value: unknown): value is PickerPayload {
  return (
    isRecord(value) &&
    (value.phase === 'hover' || value.phase === 'selected' || value.phase === 'cancelled') &&
    (value.componentId === undefined || isBoundedString(value.componentId, 256)) &&
    (value.label === undefined || isBoundedString(value.label, 4_096)) &&
    (value.source === undefined || isSourceLocation(value.source)) &&
    (value.rects === undefined ||
      (Array.isArray(value.rects) && value.rects.length <= 64 && value.rects.every(isRect)))
  );
}

export function isPageEvent(value: unknown): value is PageEvent {
  if (!isRecord(value) || !isBoundedString(value.type, 64) || !('payload' in value)) return false;
  switch (value.type) {
    case 'hello':
      return isHelloPayload(value.payload);
    case 'snapshot':
      return isSnapshotPayload(value.payload);
    case 'trace':
      return (
        isRecord(value.payload) &&
        Array.isArray(value.payload.events) &&
        value.payload.events.length <= 2_000 &&
        value.payload.events.every(isTraceRecord)
      );
    case 'picker':
      return isPickerPayload(value.payload);
    case 'command-result':
      return (
        isRecord(value.payload) &&
        isBoundedString(value.payload.requestId, 256) &&
        typeof value.payload.ok === 'boolean' &&
        (value.payload.error === undefined || isBoundedString(value.payload.error, 16_384)) &&
        (value.payload.data === undefined || isJsonValue(value.payload.data))
      );
    case 'time-travel-result':
      return (
        isRecord(value.payload) &&
        isBoundedString(value.payload.requestId, 256) &&
        typeof value.payload.ok === 'boolean' &&
        typeof value.payload.live === 'boolean' &&
        isNonNegativeInteger(value.payload.applied) &&
        (value.payload.failures === undefined ||
          (Array.isArray(value.payload.failures) &&
            value.payload.failures.length <= 2_000 &&
            value.payload.failures.every(
              (failure) =>
                isRecord(failure) &&
                isBoundedString(failure.componentId, 256) &&
                isBoundedString(failure.reason, 4_096)
            )))
      );
    default:
      return false;
  }
}

export function isPageCommand(value: unknown): value is PageCommand {
  if (!isRecord(value) || !isBoundedString(value.kind, 64)) return false;
  switch (value.kind) {
    case 'connect':
      return true;
    case 'snapshot':
      return isBoundedString(value.requestId, 256);
    case 'record':
      return typeof value.enabled === 'boolean';
    case 'picker':
      return value.action === 'start' || value.action === 'stop';
    case 'highlight':
      return (
        (value.componentId === null || isBoundedString(value.componentId, 256)) &&
        (value.reveal === undefined || typeof value.reveal === 'boolean')
      );
    case 'inspect-rune-object':
      return isBoundedString(value.requestId, 256) && isBoundedString(value.objectId, 256);
    case 'set-value':
      return (
        isBoundedString(value.requestId, 256) &&
        isBoundedString(value.componentId, 256) &&
        Array.isArray(value.path) &&
        value.path.length <= 32 &&
        value.path.every(
          (part) => isBoundedString(part, 4_096) || (isNonNegativeInteger(part) && part <= 1_000_000)
        ) &&
        isJsonValue(value.value)
      );
    case 'time-travel':
      return (
        isBoundedString(value.requestId, 256) &&
        (value.action === 'apply' || value.action === 'live') &&
        (value.cursor === undefined || isFiniteNumber(value.cursor)) &&
        (value.targets === undefined ||
          (Array.isArray(value.targets) &&
            value.targets.length <= 2_000 &&
            value.targets.every(
              (target) =>
                isRecord(target) &&
                isBoundedString(target.componentId, 256) &&
                isBoundedString(target.checkpointId, 256)
            )))
      );
    default:
      return false;
  }
}

export function isPageToContentMessage(value: unknown): value is PageToContentMessage {
  return (
    isRecord(value) &&
    value.source === PAGE_SOURCE &&
    value.v === PROTOCOL_VERSION &&
    isBoundedString(value.sessionId, 256) &&
    value.sessionId.length > 0 &&
    isPageEvent(value.event) &&
    isJsonValue(value)
  );
}

export function isContentToPageMessage(value: unknown): value is ContentToPageMessage {
  return (
    isRecord(value) &&
    value.source === CONTENT_SOURCE &&
    value.v === PROTOCOL_VERSION &&
    (value.sessionId === null || isBoundedString(value.sessionId, 256)) &&
    isPageCommand(value.command) &&
    isJsonValue(value)
  );
}

export function isPortMessage(value: unknown): value is PortMessage {
  if (
    !isRecord(value) ||
    value.v !== PROTOCOL_VERSION ||
    !isBoundedString(value.kind, 64) ||
    !isJsonValue(value)
  ) {
    return false;
  }

  switch (value.kind) {
    case 'frame':
      return (
        isBoundedString(value.sessionId, 256) &&
        value.sessionId.length > 0 &&
        isNonNegativeInteger(value.seq) &&
        value.seq > 0 &&
        isPageEvent(value.event)
      );
    case 'panel-ready':
      return (
        (value.sessionId === null || isBoundedString(value.sessionId, 256)) &&
        isNonNegativeInteger(value.fromSeq)
      );
    case 'ack':
      return (
        isBoundedString(value.sessionId, 256) &&
        isNonNegativeInteger(value.seq)
      );
    case 'command':
      return (
        (value.sessionId === null || isBoundedString(value.sessionId, 256)) &&
        isPageCommand(value.command)
      );
    case 'gap':
      return (
        isBoundedString(value.sessionId, 256) &&
        isNonNegativeInteger(value.fromSeq) &&
        isNonNegativeInteger(value.toSeq) &&
        value.fromSeq <= value.toSeq
      );
    case 'page-connected':
      return true;
    case 'ping':
    case 'pong':
      return isNonNegativeInteger(value.id);
    default:
      return false;
  }
}
