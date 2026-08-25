import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION, type PageEvent, type PortMessage } from '../shared/protocol';
import { connectPanel } from './transport';

type MessageListener = (message: unknown) => void;

class FakePort {
  posted: PortMessage[] = [];
  messageListeners: MessageListener[] = [];
  disconnectListeners: Array<() => void> = [];

  onMessage = {
    addListener: (listener: MessageListener) => this.messageListeners.push(listener)
  };

  onDisconnect = {
    addListener: (listener: () => void) => this.disconnectListeners.push(listener)
  };

  postMessage(message: PortMessage) {
    this.posted.push(message);
  }

  disconnect() {
    for (const listener of this.disconnectListeners) listener();
  }

  emit(message: PortMessage) {
    for (const listener of this.messageListeners) listener(message);
  }
}

const previewGlobal = globalThis as typeof globalThis & {
  __SVELTE_LENS_PANEL_PREVIEW_PORT__?: FakePort;
};

afterEach(() => {
  delete previewGlobal.__SVELTE_LENS_PANEL_PREVIEW_PORT__;
  vi.restoreAllMocks();
});

describe('panel transport', () => {
  it('resets to a gap session, acknowledges frames, and reactivates a reconnected page', () => {
    const port = new FakePort();
    previewGlobal.__SVELTE_LENS_PANEL_PREVIEW_PORT__ = port;
    const sessions: string[] = [];
    const gaps: Array<[number, number]> = [];
    const events: PageEvent[] = [];
    let pageConnections = 0;

    const connection = connectPanel({
      onEvent: (event) => events.push(event),
      onSession: (sessionId) => sessions.push(sessionId),
      onPageConnected: () => pageConnections++,
      onGap: (from, to) => gaps.push([from, to]),
      onStatus: vi.fn()
    });

    expect(port.posted[0]).toMatchObject({ kind: 'panel-ready', sessionId: null, fromSeq: 0 });

    port.emit({ v: PROTOCOL_VERSION, kind: 'page-connected' });
    expect(pageConnections).toBe(1);
    expect(port.posted.at(-1)).toMatchObject({ kind: 'panel-ready', sessionId: null, fromSeq: 0 });

    port.emit({
      v: PROTOCOL_VERSION,
      kind: 'gap',
      sessionId: 'document-a',
      fromSeq: 1,
      toSeq: 5
    });
    expect(sessions).toEqual(['document-a']);
    expect(gaps).toEqual([[1, 5]]);

    const hello: PageEvent = {
      type: 'hello',
      payload: {
        svelteVersion: '5.56.9',
        mode: 'dev',
        capabilities: { inspect: true, picker: true, trace: true, state: false, timeTravel: false }
      }
    };
    port.emit({
      v: PROTOCOL_VERSION,
      kind: 'frame',
      sessionId: 'document-a',
      seq: 6,
      event: hello
    });
    expect(events).toEqual([hello]);
    expect(port.posted.at(-1)).toMatchObject({ kind: 'ack', sessionId: 'document-a', seq: 6 });

    connection.command({ kind: 'snapshot', requestId: 'snapshot-1' });
    expect(port.posted.at(-1)).toMatchObject({
      kind: 'command',
      sessionId: 'document-a',
      command: { kind: 'snapshot', requestId: 'snapshot-1' }
    });

    connection.close();
  });
});
