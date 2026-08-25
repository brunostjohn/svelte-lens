import { mount } from 'svelte';
import App from '../../../apps/extension/src/panel/App.svelte';
import '../../../apps/extension/src/panel/styles.css';
import type { PageEvent, PortMessage } from '../../../apps/extension/src/shared/protocol';

type Listener<T> = (value: T) => void;

const messageListeners = new Set<Listener<PortMessage>>();
const disconnectListeners = new Set<Listener<void>>();
let sent = false;

const events: PageEvent[] = [
  {
    type: 'hello',
    payload: {
      svelteVersion: '5.56.9',
      mode: 'dev',
      capabilities: { inspect: true, picker: true, trace: true, state: true, timeTravel: true, effects: true, runeObjects: true }
    }
  },
  {
    type: 'snapshot',
    payload: {
      revision: 4,
      capturedAt: Date.now(),
      nodes: [
        {
          id: 'app',
          kind: 'component',
          name: 'App',
          source: { file: 'src/App.svelte', line: 1, column: 0 },
          detail: { enhanced: true, domCount: 8, updateCount: 3, props: {}, state: { accent: '#ff3e78', showSecond: true, interactions: 1 }, derived: {} }
        },
        {
          id: 'counter-1',
          parentId: 'app',
          kind: 'component',
          name: 'Counter',
          source: { file: 'src/Counter.svelte', line: 1, column: 0 },
          detail: {
            enhanced: true,
            domCount: 7,
            updateCount: 6,
            props: { label: 'Primary counter', start: 2, accent: '#ff3e78' },
            state: { count: 5, step: 1, history: [2, 3, 4, 5] },
            derived: { doubled: 10 },
            writableState: { count: true, step: true, history: true },
            invocation: { file: 'src/App.svelte', line: 34, column: 4, componentTag: 'Counter' },
            effects: [{
              id: 'fx-counter',
              siteId: 'site:counter-observer',
              componentId: 'counter-1',
              kind: 'effect',
              source: { file: 'src/Counter.svelte', line: 12, column: 2 },
              status: 'active',
              adapter: 'exact',
              runCount: 4,
              rerunCount: 3,
              capturedRunCount: 4,
              timedRunCount: 4,
              cleanupCount: 3,
              cleanupRegistered: true,
              errorCount: 0,
              lastSyncDurationMs: 0.18,
              maxSyncDurationMs: 0.31,
              totalSyncDurationMs: 0.72,
              averageSyncDurationMs: 0.18,
              dependencyCount: 2,
              directDependencyCount: 2,
              dependencyTruncated: false,
              triggers: [{ id: 'sig-count', label: 'count', kind: 'state', invalidated: true, direct: true, before: 4, current: 5, afterCallback: 6, previewChanged: true, updatedAt: ['Error: count updated\n    at increment (src/Counter.svelte:38:7)'] }],
              dependencies: [
                { id: 'sig-count', label: 'count', kind: 'state', value: 5, direct: true, depth: 0, parentId: null, createdAt: 'Error: count created\n    at Counter (src/Counter.svelte:5:14)' },
                { id: 'sig-step', label: 'step', kind: 'state', value: 1, direct: true, depth: 0 }
              ],
              addedDependencyIds: [],
              removedDependencyIds: [],
              phase: 'rerun',
              outcome: 'ok',
              captureGap: false
            }]
          }
        },
        {
          id: 'if-1',
          parentId: 'app',
          kind: 'block',
          name: '#if',
          source: { file: 'src/App.svelte', line: 35, column: 4 },
          detail: { domCount: 1, updateCount: 1 }
        },
        {
          id: 'counter-2',
          parentId: 'if-1',
          kind: 'component',
          name: 'Counter',
          source: { file: 'src/Counter.svelte', line: 1, column: 0 },
          detail: { enhanced: true, domCount: 7, updateCount: 1, props: { label: 'Conditional counter', start: 10 }, state: { count: 10, step: 1 }, derived: { doubled: 20 } }
        },
        {
          id: 'todos',
          parentId: 'app',
          kind: 'component',
          name: 'TodoList',
          source: { file: 'src/TodoList.svelte', line: 1, column: 0 },
          detail: {
            enhanced: true,
            domCount: 11,
            updateCount: 2,
            props: {},
            state: { draft: '', nextId: 4, todos: [{ id: 1, text: 'Open Svelte Lens', done: true }, { id: 2, text: 'Pick this component', done: false }] },
            derived: { remaining: 1 },
            effects: [{
              id: 'fx-todos',
              siteId: 'site:todo-observer',
              componentId: 'todos',
              kind: 'pre',
              source: { file: 'src/TodoList.svelte', line: 16, column: 2 },
              status: 'error',
              adapter: 'exact',
              runCount: 2,
              rerunCount: 1,
              capturedRunCount: 2,
              timedRunCount: 2,
              cleanupCount: 0,
              cleanupRegistered: false,
              errorCount: 1,
              lastSyncDurationMs: 0.09,
              maxSyncDurationMs: 0.12,
              totalSyncDurationMs: 0.21,
              averageSyncDurationMs: 0.105,
              dependencyCount: 1,
              directDependencyCount: 1,
              dependencyTruncated: false,
              triggers: [{ id: 'sig-remaining', label: 'remaining', kind: 'derived', invalidated: true, direct: true, before: 2, current: 1, previewChanged: true }],
              dependencies: [{ id: 'sig-remaining', label: 'remaining', kind: 'derived', value: 1, direct: true, depth: 0 }],
              addedDependencyIds: [],
              removedDependencyIds: [],
              phase: 'rerun',
              outcome: 'error',
              lastError: { name: 'Error', message: 'Preview effect failure' }
            }]
          }
        }
      ],
      runeObjects: [{
        id: 'rune-object:counter-store:1',
        name: 'CounterStore',
        file: 'src/lib/CounterStore.svelte.ts',
        source: { file: 'src/lib/CounterStore.svelte.ts', line: 3, column: 0 },
        ownerComponentId: 'counter-1',
        fields: [
          { name: 'count', kind: 'state', source: { file: 'src/lib/CounterStore.svelte.ts', line: 4, column: 2 } },
          { name: 'doubled', kind: 'derived', source: { file: 'src/lib/CounterStore.svelte.ts', line: 5, column: 2 } }
        ],
        totalFields: 2,
        truncated: false
      }]
    }
  },
  {
    type: 'trace',
    payload: {
      events: [
        { id: 't1', at: 1723987011200, kind: 'mount', componentId: 'counter-1', detail: { phase: 'init', checkpointId: 'cp1', cursor: 1, changes: [], restorable: true } },
        { id: 't2-cause', at: 1723987011500, kind: 'interaction', componentId: 'counter-1', detail: { interaction: 'click', target: 'button' } },
        { id: 't2', at: 1723987011538, kind: 'update', componentId: 'counter-1', causeId: 't2-cause', detail: { phase: 'update', cursor: 2, changes: ['state.count'], checkpointId: 'cp2', restorable: true } },
        { id: 't3', at: 1723987011852, kind: 'dom', componentId: 'app', causeId: 't2-cause', detail: { added: 0, removed: 0, attributes: 1, text: 2 } },
        { id: 't3-fx-cleanup', at: 1723987011900, kind: 'effect-cleanup', componentId: 'counter-1', causeId: 't2-cause', detail: { effectId: 'fx-counter', siteId: 'site:counter-observer', kind: 'effect', source: { file: 'src/Counter.svelte', line: 12, column: 2 }, originatingRun: 3, cleanupCount: 3, syncDurationMs: 0.04, outcome: 'ok' } },
        { id: 't3-fx', at: 1723987011902, kind: 'effect-run', componentId: 'counter-1', causeId: 't2-cause', detail: { effectId: 'fx-counter', siteId: 'site:counter-observer', kind: 'effect', source: { file: 'src/Counter.svelte', line: 12, column: 2 }, parentEffectId: null, runCount: 4, rerunCount: 3, capturedRunCount: 4, timedRunCount: 4, phase: 'rerun', reason: 'dependencies', syncDurationMs: 0.18, outcome: 'ok', cleanupRegistered: true, cleanupCount: 3, errorCount: 0, adapter: 'svelte-5-dev-internals', triggers: [{ id: 'sig-count', label: 'count', kind: 'state', invalidated: true, direct: true, before: 4, current: 5, afterCallback: 6, previewChanged: true, updatedAt: ['Error: count updated\n    at increment (src/Counter.svelte:38:7)'] }], dependencies: [{ id: 'sig-count', label: 'count', kind: 'state', value: 5, direct: true, depth: 0, parentId: null, createdAt: 'Error: count created\n    at Counter (src/Counter.svelte:5:14)' }, { id: 'sig-step', label: 'step', kind: 'state', value: 1, direct: true, depth: 0, parentId: null }], directDependencyCount: 2, dependencyTruncated: false, addedDependencyIds: [], removedDependencyIds: [] } },
        { id: 't4', at: 1723987012121, kind: 'update', componentId: 'counter-1', causeId: 't2-cause', detail: { phase: 'update', cursor: 4, changes: ['state.count', 'derived.doubled'], checkpointId: 'cp4', restorable: true } }
      ]
    }
  }
];

let sequence = events.length;

function emitPreviewEvent(event: PageEvent) {
  sequence++;
  for (const listener of messageListeners) {
    listener({ v: 1, kind: 'frame', sessionId: 'preview-session', seq: sequence, event });
  }
}

const port = {
  name: 'svelte-lens/panel:1',
  onMessage: {
    addListener(listener: Listener<PortMessage>) {
      messageListeners.add(listener);
    }
  },
  onDisconnect: {
    addListener(listener: Listener<void>) {
      disconnectListeners.add(listener);
    }
  },
  postMessage(message: PortMessage) {
    if (message.kind === 'panel-ready' && !sent) {
      sent = true;
      queueMicrotask(() => {
        events.forEach((event, index) => {
          for (const listener of messageListeners) {
            listener({ v: 1, kind: 'frame', sessionId: 'preview-session', seq: index + 1, event });
          }
        });
      });
      return;
    }
    if (message.kind === 'command' && message.command.kind === 'inspect-rune-object') {
      const { requestId, objectId } = message.command;
      queueMicrotask(() => {
        if (objectId !== 'rune-object:counter-store:1') {
          emitPreviewEvent({
            type: 'command-result',
            payload: { requestId, ok: false, error: 'Rune object is no longer available' }
          });
          return;
        }
        emitPreviewEvent({
          type: 'command-result',
          payload: {
            requestId,
            ok: true,
            data: {
            id: objectId,
            name: 'CounterStore',
            file: 'src/lib/CounterStore.svelte.ts',
            source: { file: 'src/lib/CounterStore.svelte.ts', line: 3, column: 0 },
            ownerComponentId: 'counter-1',
            fields: {
              count: { kind: 'state', source: { file: 'src/lib/CounterStore.svelte.ts', line: 4, column: 2 }, value: 5 },
              doubled: { kind: 'derived', source: { file: 'src/lib/CounterStore.svelte.ts', line: 5, column: 2 }, value: 10 }
            },
            totalFields: 2,
            truncated: false
            }
          }
        });
      });
    }
  },
  disconnect() {
    for (const listener of disconnectListeners) listener();
  }
};

(globalThis as typeof globalThis & { __SVELTE_LENS_PANEL_PREVIEW_PORT__?: typeof port })
  .__SVELTE_LENS_PANEL_PREVIEW_PORT__ = port;

const target = document.querySelector('#app');
if (!target) throw new Error('Preview mount target missing');
mount(App, { target });
