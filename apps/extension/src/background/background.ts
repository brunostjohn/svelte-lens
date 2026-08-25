import {
  isPortMessage,
  PAGE_PORT_NAME,
  PANEL_PORT_PREFIX,
  PROTOCOL_VERSION,
  type PortMessage
} from '../shared/protocol';
import { ensurePageHookRegistered } from './register-page-hook';

interface PortPair {
  page?: chrome.runtime.Port;
  panel?: chrome.runtime.Port;
}

const portsByTab = new Map<number, PortPair>();

void registerPageHook();
chrome.runtime.onInstalled.addListener(() => void registerPageHook());
chrome.runtime.onStartup.addListener(() => void registerPageHook());

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }

  if (port.name === PAGE_PORT_NAME) {
    attachPagePort(port);
    return;
  }

  const tabId = panelTabId(port.name);
  if (tabId === null || !isExtensionPage(port.sender?.url)) {
    port.disconnect();
    return;
  }
  attachPanelPort(tabId, port);
});

async function registerPageHook(): Promise<void> {
  try {
    await ensurePageHookRegistered();
  } catch (error) {
    console.error('[svelte-lens] unable to register page-hook.js in the MAIN world', error);
  }
}

function attachPagePort(port: chrome.runtime.Port): void {
  const sender = port.sender;
  const tabId = sender?.tab?.id;
  if (tabId === undefined || (sender?.frameId !== undefined && sender.frameId !== 0)) {
    port.disconnect();
    return;
  }

  const pair = pairFor(tabId);
  replacePort(pair.page, port);
  pair.page = port;

  post(pair.panel, { v: PROTOCOL_VERSION, kind: 'page-connected' });

  port.onMessage.addListener((candidate: unknown) => {
    if (!isPortMessage(candidate)) return;
    if (answerPing(port, candidate)) return;
    if (isPageToPanel(candidate)) post(pair.panel, candidate);
  });
  port.onDisconnect.addListener(() => {
    if (pair.page === port) pair.page = undefined;
    deleteEmptyPair(tabId, pair);
  });
}

function attachPanelPort(tabId: number, port: chrome.runtime.Port): void {
  const pair = pairFor(tabId);
  replacePort(pair.panel, port);
  pair.panel = port;

  if (pair.page) post(port, { v: PROTOCOL_VERSION, kind: 'page-connected' });

  port.onMessage.addListener((candidate: unknown) => {
    if (!isPortMessage(candidate)) return;
    if (answerPing(port, candidate)) return;
    if (isPanelToPage(candidate)) post(pair.page, candidate);
  });
  port.onDisconnect.addListener(() => {
    if (pair.panel === port) {
      pair.panel = undefined;
      post(pair.page, {
        v: PROTOCOL_VERSION,
        kind: 'command',
        sessionId: null,
        command: { kind: 'record', enabled: false }
      });
    }
    deleteEmptyPair(tabId, pair);
  });
}

function pairFor(tabId: number): PortPair {
  let pair = portsByTab.get(tabId);
  if (!pair) {
    pair = {};
    portsByTab.set(tabId, pair);
  }
  return pair;
}

function deleteEmptyPair(tabId: number, pair: PortPair): void {
  if (!pair.page && !pair.panel && portsByTab.get(tabId) === pair) portsByTab.delete(tabId);
}

function replacePort(previous: chrome.runtime.Port | undefined, next: chrome.runtime.Port): void {
  if (!previous || previous === next) return;
  try {
    previous.disconnect();
  } catch {
    // It was already closing.
  }
}

function post(port: chrome.runtime.Port | undefined, message: PortMessage): void {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // Its disconnect listener clears the stale half. Endpoints resync by cursor.
  }
}

function answerPing(port: chrome.runtime.Port, message: PortMessage): boolean {
  if (message.kind !== 'ping') return false;
  post(port, { v: PROTOCOL_VERSION, kind: 'pong', id: message.id });
  return true;
}

function isPageToPanel(message: PortMessage): boolean {
  return message.kind === 'frame' || message.kind === 'gap' || message.kind === 'pong';
}

function isPanelToPage(message: PortMessage): boolean {
  return (
    message.kind === 'panel-ready' ||
    message.kind === 'ack' ||
    message.kind === 'command' ||
    message.kind === 'pong'
  );
}

function panelTabId(name: string): number | null {
  if (!name.startsWith(PANEL_PORT_PREFIX)) return null;
  const raw = name.slice(PANEL_PORT_PREFIX.length);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
  const tabId = Number(raw);
  return Number.isSafeInteger(tabId) ? tabId : null;
}

function isExtensionPage(url: string | undefined): boolean {
  return url?.startsWith(chrome.runtime.getURL('')) ?? false;
}
