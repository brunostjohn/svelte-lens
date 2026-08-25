import { describe, expect, it } from 'vitest';
import type { PageEvent } from '../shared/protocol';
import { ReplayBuffer } from './replay-buffer';

const hello: PageEvent = {
  type: 'hello',
  payload: {
    svelteVersion: '5',
    mode: 'dev',
    capabilities: {
      inspect: true,
      picker: true,
      trace: true,
      state: false,
      timeTravel: false
    }
  }
};

describe('ReplayBuffer', () => {
  it('sequences frames and replays only after the panel cursor', () => {
    const buffer = new ReplayBuffer(4);
    buffer.append('doc-a', hello);
    buffer.append('doc-a', hello);

    expect(buffer.replay('doc-a', 1).frames.map((frame) => frame.seq)).toEqual([2]);
  });

  it('reports an honest gap after bounded overflow', () => {
    const buffer = new ReplayBuffer(2);
    buffer.append('doc-a', hello);
    buffer.append('doc-a', hello);
    buffer.append('doc-a', hello);

    const replay = buffer.replay('doc-a', 0);
    expect(replay.gap).toMatchObject({ fromSeq: 1, toSeq: 1 });
    expect(replay.frames.map((frame) => frame.seq)).toEqual([2, 3]);
  });

  it('resets sequence and history at the document session boundary', () => {
    const buffer = new ReplayBuffer(4);
    buffer.append('doc-a', hello);
    const first = buffer.append('doc-b', hello);

    expect(first.seq).toBe(1);
    expect(buffer.replay('doc-a', 9).frames.map((frame) => frame.seq)).toEqual([1]);
  });

  it('forgets acknowledged frames without accepting an impossible cursor', () => {
    const buffer = new ReplayBuffer(4);
    buffer.append('doc-a', hello);
    buffer.append('doc-a', hello);
    buffer.acknowledge('doc-a', 99);

    const replay = buffer.replay('doc-a', 0);
    expect(replay.frames).toEqual([]);
    expect(replay.gap).toMatchObject({ fromSeq: 1, toSeq: 2 });
  });
});
