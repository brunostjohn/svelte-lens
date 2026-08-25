import {
  PROTOCOL_VERSION,
  isPortMessage,
  panelPortName,
  type PageCommand,
  type PageEvent,
  type PortMessage
} from '../shared/protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface PanelConnectionHandlers {
  onEvent(event: PageEvent, sessionId: string): void;
  onSession(sessionId: string): void;
  onPageConnected(): void;
  onGap(fromSeq: number, toSeq: number): void;
  onStatus(status: ConnectionStatus): void;
}

export interface PanelConnection {
  command(command: PageCommand): void;
  close(): void;
}

interface PortLike {
  postMessage(message: PortMessage): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

function previewPort(): PortLike | null {
  return (
    globalThis as typeof globalThis & { __SVELTE_LENS_PANEL_PREVIEW_PORT__?: PortLike }
  ).__SVELTE_LENS_PANEL_PREVIEW_PORT__ ?? null;
}

export function connectPanel(handlers: PanelConnectionHandlers): PanelConnection {
  let port: PortLike | null = null;
  let sessionId: string | null = null;
  let cursor = 0;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const post = (message: PortMessage) => {
    try {
      port?.postMessage(message);
    } catch {
      scheduleReconnect();
    }
  };

  const ready = () => {
    post({
      v: PROTOCOL_VERSION,
      kind: 'panel-ready',
      sessionId,
      fromSeq: cursor
    });
  };

  const connect = () => {
    if (closed) return;
    handlers.onStatus('connecting');

    try {
      const nextPort =
        previewPort() ??
        chrome.runtime.connect({ name: panelPortName(chrome.devtools.inspectedWindow.tabId) });
      port = nextPort;

      nextPort.onMessage.addListener((raw: unknown) => {
        if (!isPortMessage(raw)) return;
        attempt = 0;

        if (raw.kind === 'ping') {
          post({ v: PROTOCOL_VERSION, kind: 'pong', id: raw.id });
          return;
        }

        if (raw.kind === 'page-connected') {
          ready();
          handlers.onPageConnected();
          return;
        }

        if (raw.kind === 'gap') {
          if (raw.sessionId !== sessionId) {
            sessionId = raw.sessionId;
            cursor = 0;
            handlers.onSession(raw.sessionId);
          }
          handlers.onGap(raw.fromSeq, raw.toSeq);
          cursor = Math.max(cursor, raw.toSeq);
          return;
        }

        if (raw.kind !== 'frame') return;

        if (raw.sessionId !== sessionId) {
          sessionId = raw.sessionId;
          cursor = 0;
          handlers.onSession(raw.sessionId);
        }

        if (raw.seq <= cursor) return;
        handlers.onEvent(raw.event, raw.sessionId);
        cursor = raw.seq;
        post({
          v: PROTOCOL_VERSION,
          kind: 'ack',
          sessionId: raw.sessionId,
          seq: raw.seq
        });
      });

      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort || closed) return;
        port = null;
        handlers.onStatus('disconnected');
        scheduleReconnect();
      });

      handlers.onStatus('connected');
      ready();
    } catch {
      port = null;
      handlers.onStatus('disconnected');
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    const delay = Math.min(8_000, 250 * 2 ** Math.min(attempt++, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  connect();

  return {
    command(command) {
      post({
        v: PROTOCOL_VERSION,
        kind: 'command',
        sessionId,
        command
      });
    },
    close() {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      try {
        port?.disconnect();
      } catch {
        // Already disconnected.
      }
      port = null;
    }
  };
}
