/**
 * Resumable run event buffer — the live-gap bridge for chat-run resilience.
 *
 * `eager-persist` owns the DURABLE transcript (thread_messages); this buffer
 * only bridges the LIVE gap between the last persisted checkpoint and "now" so
 * a reconnecting client can replay-then-tail the in-flight activity instead of
 * going blind. It is **pure in-memory** (Decision D3): a process restart drops
 * it, the run is marked `interrupted`, and the client shows a Retry — there is
 * no SQLite event tail.
 *
 * Per-run, the buffer is a seq-numbered ring of `StreamEvent`s (the rendered
 * event stream — `text`/`tool_call`/`tool_result`/`spawn*`/…), fanned out to N
 * ephemeral subscribers. The `GET /api/runs/:runId/stream?since=<seq>` endpoint
 * replays events newer than `since`, then live-tails new appends.
 *
 * Secret safety (S1, D-S1): `append` is typed to `StreamEvent`, and
 * `secret_prompt`/`ask_secret` prompts are NOT `StreamEvent`s — they travel a
 * separate value-free handler path and can never enter this buffer. The
 * type system is the guard; a unit test asserts the invariant holds.
 */

import type { StreamEvent } from '../types/tools.js';

/** One buffered, sequenced event. `seq` is a per-rendered-event counter (NOT
 * the persisted-row counter eager-persist uses — see PRD U9 seq-space note). */
export interface BufferedEvent {
  seq: number;
  event: StreamEvent;
}

type EventSubscriber = (e: BufferedEvent) => void;
type EndSubscriber = () => void;

/** Default ring capacity per run. A long multi-step run rarely renders more
 * than a few hundred events between eager-persist checkpoints; 1000 leaves
 * generous headroom while bounding memory (R3). Oldest entries drop first —
 * the durable transcript still covers anything that falls off the tail. */
export const DEFAULT_RUN_BUFFER_CAP = 1000;

export class RunBuffer {
  private _seq = 0;
  private readonly ring: BufferedEvent[] = [];
  private readonly cap: number;
  private readonly eventSubs = new Set<EventSubscriber>();
  private readonly endSubs = new Set<EndSubscriber>();
  private _ended = false;

  constructor(cap: number = DEFAULT_RUN_BUFFER_CAP) {
    this.cap = Math.max(1, cap);
  }

  /** Append an event, assign the next seq, fan out to live subscribers.
   * Returns the assigned seq (for `id:` lines + lastPersistedSeq checkpoints).
   * No-op-safe after `end()` — a late onStream event past completion is dropped
   * rather than resurrecting a closed buffer. */
  append(event: StreamEvent): number {
    if (this._ended) return this._seq;
    const seq = ++this._seq;
    const entry: BufferedEvent = { seq, event };
    this.ring.push(entry);
    if (this.ring.length > this.cap) this.ring.shift(); // drop oldest (R3)
    for (const sub of this.eventSubs) {
      // One slow/throwing subscriber must never break the fan-out to others
      // or the run itself.
      try { sub(entry); } catch { /* subscriber-local failure, ignore */ }
    }
    return seq;
  }

  /** High-water seq — the executor records this at each eager-persist
   * checkpoint as `RunRecord.lastPersistedSeq` so replay can compare like
   * units (D-U1). */
  currentSeq(): number {
    return this._seq;
  }

  /** The oldest seq still retained (0 if empty). A subscriber whose `since`
   * is below this fell off the ring tail — the client rebuilds its base from
   * the persisted transcript, so this is a soft signal, not an error. */
  oldestSeq(): number {
    return this.ring[0]?.seq ?? 0;
  }

  /** Buffered events strictly newer than `since`. `since=0` replays the whole
   * retained ring; `since>=currentSeq` replays nothing (caller then live-tails). */
  replaySince(since: number): BufferedEvent[] {
    if (since <= 0) return [...this.ring];
    return this.ring.filter((e) => e.seq > since);
  }

  /** Subscribe to future appends (and, optionally, run completion). Returns an
   * unsubscribe fn. The endpoint replays first, THEN subscribes, holding a
   * lock-free gap only as wide as one synchronous append (acceptable: the
   * replay+subscribe pair runs to completion before the next event loop tick). */
  subscribe(onEvent: EventSubscriber, onEnd?: EndSubscriber): () => void {
    if (this._ended) {
      // Already done — fire onEnd on the next tick so the caller can close.
      if (onEnd) queueMicrotask(onEnd);
      return () => {};
    }
    this.eventSubs.add(onEvent);
    if (onEnd) this.endSubs.add(onEnd);
    return () => {
      this.eventSubs.delete(onEvent);
      if (onEnd) this.endSubs.delete(onEnd);
    };
  }

  /** Mark the run complete: notify end-subscribers (so live tails close) and
   * stop accepting appends. The ring is retained until the manager removes the
   * buffer, so a subscriber that races completion still replays the tail. */
  end(): void {
    if (this._ended) return;
    this._ended = true;
    for (const sub of this.endSubs) {
      try { sub(); } catch { /* subscriber-local failure, ignore */ }
    }
    this.eventSubs.clear();
    this.endSubs.clear();
  }

  get ended(): boolean {
    return this._ended;
  }

  get subscriberCount(): number {
    return this.eventSubs.size;
  }
}

/**
 * Engine-owned registry of live run buffers, keyed by runId. Created alongside
 * the run, removed on terminal completion (the durable transcript persists
 * regardless). Lives on the Engine (not the request) so a headless run's
 * buffer outlives the SSE connection that started it.
 */
export class RunBufferManager {
  private readonly buffers = new Map<string, RunBuffer>();

  create(runId: string, cap?: number): RunBuffer {
    const buf = new RunBuffer(cap);
    this.buffers.set(runId, buf);
    return buf;
  }

  get(runId: string): RunBuffer | undefined {
    return this.buffers.get(runId);
  }

  /** Terminate + drop a run's buffer. Idempotent. */
  remove(runId: string): void {
    const buf = this.buffers.get(runId);
    if (!buf) return;
    buf.end();
    this.buffers.delete(runId);
  }

  get size(): number {
    return this.buffers.size;
  }
}
