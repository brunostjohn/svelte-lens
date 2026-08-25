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
      capabilities: { inspect: true, picker: true, trace: true, state: true, timeTravel: true }
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
            invocation: { file: 'src/App.svelte', line: 34, column: 4, componentTag: 'Counter' }
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
          detail: { enhanced: true, domCount: 11, updateCount: 2, props: {}, state: { draft: '', nextId: 4, todos: [{ id: 1, text: 'Open Svelte Lens', done: true }, { id: 2, text: 'Pick this component', done: false }] }, derived: { remaining: 1 } }
        }
      ]
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
        { id: 't4', at: 1723987012121, kind: 'update', componentId: 'counter-1', causeId: 't2-cause', detail: { phase: 'update', cursor: 4, changes: ['state.count', 'derived.doubled'], checkpointId: 'cp4', restorable: true } }
      ]
    }
  }
];

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
    if (message.kind !== 'panel-ready' || sent) return;
    sent = true;
    queueMicrotask(() => {
      events.forEach((event, index) => {
        for (const listener of messageListeners) {
          listener({ v: 1, kind: 'frame', sessionId: 'preview-session', seq: index + 1, event });
        }
      });
    });
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
