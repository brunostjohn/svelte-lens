import { describe, expect, it } from 'vitest';
import {
  contentMessage,
  isContentToPageMessage,
  isPageToContentMessage,
  isPortMessage,
  pageMessage,
  PROTOCOL_VERSION
} from './protocol';

const hello = pageMessage('doc-1', {
  type: 'hello',
  payload: {
    svelteVersion: '5',
    mode: 'dev',
    capabilities: {
      inspect: true,
      picker: true,
      trace: true,
      state: false,
      timeTravel: false,
      effects: true
    }
  }
});

describe('extension protocol guards', () => {
  it('accepts valid page and command envelopes', () => {
    expect(isPageToContentMessage(hello)).toBe(true);
    expect(isContentToPageMessage(contentMessage('doc-1', { kind: 'picker', action: 'start' }))).toBe(
      true
    );
  });

  it('rejects spoofed channels, versions, and cyclic payloads', () => {
    expect(isPageToContentMessage({ ...hello, source: 'host-page' })).toBe(false);
    expect(isPageToContentMessage({ ...hello, v: 99 })).toBe(false);
    if (hello.event.type !== 'hello') throw new Error('Expected hello fixture');
    expect(isPageToContentMessage({
      ...hello,
      event: {
        ...hello.event,
        payload: {
          ...hello.event.payload,
          capabilities: { ...hello.event.payload.capabilities, effects: 'yes' }
        }
      }
    })).toBe(false);

    const cyclic: Record<string, unknown> = { ...hello };
    cyclic.self = cyclic;
    expect(isPageToContentMessage(cyclic)).toBe(false);
  });

  it('guards panel port messages by direction-independent wire shape', () => {
    expect(
      isPortMessage({
        v: PROTOCOL_VERSION,
        kind: 'command',
        sessionId: 'doc-1',
        command: { kind: 'snapshot', requestId: 'request-1' }
      })
    ).toBe(true);
    expect(
      isPortMessage({
        v: PROTOCOL_VERSION,
        kind: 'ack',
        sessionId: 'doc-1',
        seq: -1
      })
    ).toBe(false);
  });
});
