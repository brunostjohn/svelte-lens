import {
  PROTOCOL_VERSION,
  contentMessage,
  isPageToContentMessage,
  isPortMessage,
  PAGE_PORT_NAME,
  type PageFrame,
  type PortMessage
} from '../shared/protocol';
import { ReplayBuffer } from './replay-buffer';

const replayBuffer = new ReplayBuffer(256);
const reconnectDelays = [100, 250, 500, 1_000, 2_000, 5_000] as const;

let port: chrome.runtime.Port | null = null;
let panelReady = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

window.addEventListener('message', onWindowMessage);

// Establish the cross-world listener before asking the MAIN agent to identify itself.
window.postMessage(contentMessage(null, { kind: 'connect' }), '*');
connect();

function onWindowMessage(event: MessageEvent<unknown>): void {
  if (event.source !== window || !isPageToContentMessage(event.data)) return;

  const frame = replayBuffer.append(event.data.sessionId, event.data.event);
  if (panelReady) postFrame(frame);
}

function connect(): void {
  if (port) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (!chrome.runtime?.id) return scheduleReconnect();
    const nextPort = chrome.runtime.connect({ name: PAGE_PORT_NAME });
    port = nextPort;

    nextPort.onMessage.addListener((candidate: unknown) => {
      if (!isPortMessage(candidate)) return;
      reconnectAttempt = 0;
      onPortMessage(nextPort, candidate);
    });
    nextPort.onDisconnect.addListener(() => {
      if (port !== nextPort) return;
      port = null;
      panelReady = false;
      window.postMessage(
        contentMessage(replayBuffer.sessionId, { kind: 'record', enabled: false }),
        '*'
      );
      scheduleReconnect();
    });
  } catch {
    port = null;
    panelReady = false;
    scheduleReconnect();
  }
}

function onPortMessage(sender: chrome.runtime.Port, message: PortMessage): void {
  switch (message.kind) {
    case 'panel-ready':
      panelReady = true;
      replay(sender, message.sessionId, message.fromSeq);
      break;
    case 'ack':
      replayBuffer.acknowledge(message.sessionId, message.seq);
      break;
    case 'command': {
      const currentSession = replayBuffer.sessionId;
      if (message.sessionId !== null && message.sessionId !== currentSession) return;
      window.postMessage(contentMessage(currentSession, message.command), '*');
      break;
    }
    case 'ping':
      safePost(sender, { v: PROTOCOL_VERSION, kind: 'pong', id: message.id });
      break;
    case 'frame':
    case 'gap':
    case 'page-connected':
    case 'pong':
      // These messages only travel toward the panel (or terminate there).
      break;
  }
}

function replay(sender: chrome.runtime.Port, sessionId: string | null, fromSeq: number): void {
  const replay = replayBuffer.replay(sessionId, fromSeq);
  if (replay.gap && !safePost(sender, replay.gap)) return;
  for (const frame of replay.frames) {
    if (!safePost(sender, frame)) return;
  }
}

function postFrame(frame: PageFrame): void {
  const current = port;
  if (!current || !safePost(current, frame)) {
    panelReady = false;
  }
}

function safePost(target: chrome.runtime.Port, message: PortMessage): boolean {
  try {
    target.postMessage(message);
    return true;
  } catch {
    if (port === target) {
      port = null;
      panelReady = false;
      scheduleReconnect();
    }
    return false;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 5_000;
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}
