import {
  PROTOCOL_VERSION,
  type PageEvent,
  type PageFrame,
  type PortMessage
} from '../shared/protocol';

export interface ReplayResult {
  frames: PageFrame[];
  gap?: Extract<PortMessage, { kind: 'gap' }>;
}

/**
 * A deliberately small, per-document replay window.
 *
 * The panel owns durable trace state. This buffer only closes the short gap
 * caused by an MV3 worker restart, a panel reload, or a navigation race.
 */
export class ReplayBuffer {
  readonly capacity: number;

  #sessionId: string | null = null;
  #nextSeq = 1;
  #forgottenThrough = 0;
  #frames: PageFrame[] = [];

  constructor(capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('ReplayBuffer capacity must be a positive integer');
    }
    this.capacity = capacity;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get latestSeq(): number {
    return this.#nextSeq - 1;
  }

  get size(): number {
    return this.#frames.length;
  }

  append(sessionId: string, event: PageEvent): PageFrame {
    if (sessionId !== this.#sessionId) this.#reset(sessionId);

    const frame: PageFrame = {
      v: PROTOCOL_VERSION,
      kind: 'frame',
      sessionId,
      seq: this.#nextSeq++,
      event
    };
    this.#frames.push(frame);

    while (this.#frames.length > this.capacity) {
      const forgotten = this.#frames.shift();
      if (forgotten) this.#forgottenThrough = forgotten.seq;
    }
    return frame;
  }

  /** Forget only frames the current panel says it has accepted. */
  acknowledge(sessionId: string, seq: number): void {
    if (sessionId !== this.#sessionId || seq <= this.#forgottenThrough) return;

    const through = Math.min(seq, this.latestSeq);
    let removeCount = 0;
    while (removeCount < this.#frames.length) {
      const frame = this.#frames[removeCount];
      if (!frame || frame.seq > through) break;
      removeCount++;
    }
    if (removeCount > 0) this.#frames.splice(0, removeCount);
    this.#forgottenThrough = Math.max(this.#forgottenThrough, through);
  }

  replay(requestedSessionId: string | null, fromSeq: number): ReplayResult {
    const sessionId = this.#sessionId;
    if (!sessionId) return { frames: [] };

    const cursor = requestedSessionId === sessionId ? fromSeq : 0;
    const result: ReplayResult = {
      frames: this.#frames.filter((frame) => frame.seq > cursor)
    };

    if (cursor < this.#forgottenThrough) {
      result.gap = {
        v: PROTOCOL_VERSION,
        kind: 'gap',
        sessionId,
        fromSeq: cursor + 1,
        toSeq: this.#forgottenThrough
      };
    }
    return result;
  }

  #reset(sessionId: string): void {
    this.#sessionId = sessionId;
    this.#nextSeq = 1;
    this.#forgottenThrough = 0;
    this.#frames = [];
  }
}
