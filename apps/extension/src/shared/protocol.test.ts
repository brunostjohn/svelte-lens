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
    expect(isContentToPageMessage(contentMessage('doc-1', {
      kind: 'inspect-rune-object',
      requestId: 'inspect-1',
      objectId: 'rune:1'
    }))).toBe(true);
  });

  it('accepts bounded rune object metadata and rejects oversized field lists', () => {
    const snapshot = pageMessage('doc-1', {
      type: 'snapshot',
      payload: {
        revision: 1,
        capturedAt: Date.now(),
        nodes: [],
        runeObjects: [{
          id: 'rune:1',
          name: 'Model',
          file: 'src/model.svelte.ts',
          source: { file: 'src/model.svelte.ts', line: 1, column: 0 },
          fields: [{
            name: 'count',
            kind: 'state',
            source: { file: 'src/model.svelte.ts', line: 2, column: 2 }
          }],
          totalFields: 1,
          truncated: false
        }]
      }
    });
    expect(isPageToContentMessage(snapshot)).toBe(true);
    if (snapshot.event.type !== 'snapshot' || !snapshot.event.payload.runeObjects?.[0]) {
      throw new Error('Expected rune object fixture');
    }
    snapshot.event.payload.runeObjects[0].fields = Array.from({ length: 65 }, (_, index) => ({
      name: `field${index}`,
      kind: 'state' as const,
      source: { file: 'src/model.svelte.ts', line: index + 1, column: 0 }
    }));
    expect(isPageToContentMessage(snapshot)).toBe(false);
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

  it('rejects unrelated window messages before walking their payloads', () => {
    let pagePayloadReads = 0;
    const unrelatedPageMessage = {
      source: 'another-library',
      v: PROTOCOL_VERSION,
      sessionId: 'doc-1',
      get event() {
        pagePayloadReads++;
        return hello.event;
      }
    };
    expect(isPageToContentMessage(unrelatedPageMessage)).toBe(false);
    expect(pagePayloadReads).toBe(0);

    let contentPayloadReads = 0;
    const unrelatedContentMessage = {
      source: 'host-page',
      v: PROTOCOL_VERSION,
      sessionId: null,
      get command() {
        contentPayloadReads++;
        return { kind: 'connect' };
      }
    };
    expect(isContentToPageMessage(unrelatedContentMessage)).toBe(false);
    expect(contentPayloadReads).toBe(0);
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
