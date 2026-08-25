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
  readonly maxBytes: number;

  #sessionId: string | null = null;
  #nextSeq = 1;
  #forgottenThrough = 0;
  #bytes = 0;
  #frames: Array<{ frame: PageFrame; bytes: number }> = [];

  constructor(capacity = 256, maxBytes = 8 * 1024 * 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('ReplayBuffer capacity must be a positive integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('ReplayBuffer maxBytes must be a positive safe integer');
    }
    this.capacity = capacity;
    this.maxBytes = maxBytes;
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

  get bytes(): number {
    return this.#bytes;
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
    const bytes = estimateFrameBytes(frame);
    this.#frames.push({ frame, bytes });
    this.#bytes += bytes;

    while (this.#frames.length > this.capacity || this.#bytes > this.maxBytes) {
      const forgotten = this.#frames.shift();
      if (forgotten) {
        this.#bytes = Math.max(0, this.#bytes - forgotten.bytes);
        this.#forgottenThrough = forgotten.frame.seq;
      }
    }
    return frame;
  }

  /** Forget only frames the current panel says it has accepted. */
  acknowledge(sessionId: string, seq: number): void {
    if (sessionId !== this.#sessionId || seq <= this.#forgottenThrough) return;

    const through = Math.min(seq, this.latestSeq);
    let removeCount = 0;
    while (removeCount < this.#frames.length) {
      const entry = this.#frames[removeCount];
      if (!entry || entry.frame.seq > through) break;
      removeCount++;
    }
    if (removeCount > 0) {
      const removed = this.#frames.splice(0, removeCount);
      for (const entry of removed) this.#bytes = Math.max(0, this.#bytes - entry.bytes);
    }
    this.#forgottenThrough = Math.max(this.#forgottenThrough, through);
  }

  replay(requestedSessionId: string | null, fromSeq: number): ReplayResult {
    const sessionId = this.#sessionId;
    if (!sessionId) return { frames: [] };

    const cursor = requestedSessionId === sessionId ? fromSeq : 0;
    const result: ReplayResult = {
      frames: this.#frames.flatMap(({ frame }) => frame.seq > cursor ? [frame] : [])
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
    this.#bytes = 0;
    this.#frames = [];
  }
}

/** Chrome messaging copies strings, so UTF-16 size is a safe conservative cap. */
function estimateFrameBytes(frame: PageFrame): number {
  try {
    return JSON.stringify(frame).length * 2;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
