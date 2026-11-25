/**
 * How long a run may stay silent while one of its tools works.
 *
 * A run whose stream has dropped is taken over by a new message once its engine has been
 * silent for a minute. A tool can work silently for longer than that (a shell command runs up
 * to its own limit), and a run taken over in the middle of it is lost. So while a tool call is
 * open, the run counts as silent only once that call is past its own limit: the tool's bound
 * plus a margin. Every call has a deadline, also one whose result never arrives, so nothing
 * holds a run for longer than the longest bound.
 *
 * Not every call streams a result: a refused call answers the model without one. What shows that
 * a turn's calls are over is the agent's next response: the agent streams it only once every
 * call of the response before has settled. A response ends with its `turn_end`, before its calls
 * run; the next text, thinking or call of the same agent after it ends the hold of every call
 * that response made. (A sub-agent's `turn_end` is not forwarded: its calls end with their
 * result or their limit.) Time the run spends waiting on a person (a consent or secret prompt)
 * does not count against a call's limit.
 */

import { capTimeout, MAX_EXEC_TIMEOUT_MS } from '../shell-sidecar/protocol.js';
import { CLIENT_GRACE_MS } from '../shell-sidecar/client.js';
import { HTTP_HARD_CAP_MS } from '../tools/builtin/http.js';
import { FFMPEG_TIMEOUT_MS } from '../tools/builtin/media-process.js';
import { SPAWN_TIMEOUT } from '../tools/builtin/spawn.js';
import { FOLLOW_UP_TOOL_NAME } from './follow-up-fallback.js';

/** The bound for a tool without one of its own (workflow steps, bulk checks, integrations,
 *  MCP tools). No built-in tool with its own bound runs longer than a shell command at its
 *  ceiling, and the run's wall clock ends any run past half an hour regardless. */
export const TOOL_SILENCE_CEILING_MS = MAX_EXEC_TIMEOUT_MS;

/** Added to every bound: for the result to travel back, and for clocks. */
export const TOOL_SILENCE_MARGIN_MS = 5_000;

/** How long a call of `name` with `input` can work before its own limit ends it. */
export function toolBoundMs(name: string, input: unknown): number {
  switch (name) {
    case 'bash': {
      // The model writes the input: the same cap the execution applies, never the raw value.
      const requested = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)['timeout_ms'] : undefined;
      return capTimeout(requested) + CLIENT_GRACE_MS;
    }
    case 'http_request': return HTTP_HARD_CAP_MS;
    case 'media_process': return FFMPEG_TIMEOUT_MS;
    case 'spawn_agent': return SPAWN_TIMEOUT;
    default: return TOOL_SILENCE_CEILING_MS;
  }
}

interface ToolEvent {
  readonly type: string;
  readonly name?: string | undefined;
  readonly input?: unknown;
  readonly toolUseId?: string | undefined;
  readonly subAgentId?: string | undefined;
  readonly subAgent?: string | undefined;
}

interface OpenCall {
  deadline: number;
  /** The agent the call belongs to: the run's own (`''`) or a sub-agent, by name. */
  readonly owner: string;
  /** The response that made the call has ended: the agent's next event shows it settled. */
  responseEnded: boolean;
}

/** The open tool calls of one run, each with the moment its own limit has passed. */
export class ToolSilenceClock {
  private readonly open = new Map<string, OpenCall>();
  private unpaired = 0;
  private pausedAt: number | undefined;

  /** Opens a call on its `tool_call`, closes it on the `tool_result` with the same id. */
  note(event: ToolEvent, now: number = Date.now()): void {
    const owner = event.subAgent ?? '';
    if (event.type === 'turn_end') {
      for (const call of this.open.values()) if (call.owner === owner) call.responseEnded = true;
      return;
    }
    if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_call') {
      for (const [key, call] of this.open) if (call.owner === owner && call.responseEnded) this.open.delete(key);
    }
    if (event.type === 'tool_call') {
      // Answered on the spot from the turn's own text, at the end of the turn.
      if (event.name === FOLLOW_UP_TOOL_NAME) return;
      const key = this.keyOf(event);
      if (key === undefined) {
        // A call without a usable id cannot be paired with its result: it ends at the ceiling,
        // under a key no result can name.
        this.open.set(`unpaired ${String(++this.unpaired)}`, { deadline: now + TOOL_SILENCE_CEILING_MS + TOOL_SILENCE_MARGIN_MS, owner, responseEnded: false });
        return;
      }
      this.open.set(key, { deadline: now + toolBoundMs(event.name ?? '', event.input) + TOOL_SILENCE_MARGIN_MS, owner, responseEnded: false });
      return;
    }
    if (event.type === 'tool_result') {
      const key = this.keyOf(event);
      if (key !== undefined) this.open.delete(key);
    }
  }

  /** The run waits on a person from now. Idempotent. */
  pause(now: number = Date.now()): void {
    this.pausedAt ??= now;
  }

  /** The wait is over: every open call gets the time it waited added to its limit. */
  resume(now: number = Date.now()): void {
    if (this.pausedAt === undefined) return;
    const waited = Math.max(0, now - this.pausedAt);
    this.pausedAt = undefined;
    for (const call of this.open.values()) call.deadline += waited;
  }

  /** True while a call is open and not yet past its own limit (counting a wait still going on). */
  holds(now: number = Date.now()): boolean {
    const waiting = this.pausedAt === undefined ? 0 : Math.max(0, now - this.pausedAt);
    let held = false;
    for (const [key, call] of this.open) {
      if (call.deadline + waiting > now) held = true;
      else this.open.delete(key);
    }
    return held;
  }

  private keyOf(event: ToolEvent): string | undefined {
    const id = event.toolUseId;
    if (typeof id !== 'string' || id === '') return undefined;
    return JSON.stringify([event.subAgentId ?? null, id]);
  }
}
