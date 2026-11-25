/**
 * How long a run may stay silent while one of its tools works.
 *
 * A run whose stream has dropped is taken over by a new message once its engine has been
 * silent for a minute. A tool can work silently for longer than that (a shell command runs up
 * to its own limit), and a run taken over in the middle of it is lost. So while a tool call is
 * open, the run counts as silent only once that call is past its own limit: the tool's bound
 * plus a margin. Every call has a deadline, also one whose result never arrives, so nothing
 * holds a run for longer than the longest bound.
 */

import { capTimeout, MAX_EXEC_TIMEOUT_MS } from '../shell-sidecar/protocol.js';
import { CLIENT_GRACE_MS } from '../shell-sidecar/client.js';
import { HTTP_HARD_CAP_MS } from '../tools/builtin/http.js';
import { FFMPEG_TIMEOUT_MS } from '../tools/builtin/media-process.js';
import { SPAWN_TIMEOUT } from '../tools/builtin/spawn.js';

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
}

/** The open tool calls of one run, each with the moment its own limit has passed. */
export class ToolSilenceClock {
  private readonly open = new Map<string, number>();
  private unpaired = 0;

  /** Opens a call on its `tool_call`, closes it on the `tool_result` with the same id. */
  note(event: ToolEvent, now: number = Date.now()): void {
    if (event.type === 'tool_call') {
      const key = this.keyOf(event);
      if (key === undefined) {
        // A call without a usable id cannot be paired with its result: it ends at the ceiling,
        // under a key no result can name.
        this.open.set(`unpaired ${String(++this.unpaired)}`, now + TOOL_SILENCE_CEILING_MS + TOOL_SILENCE_MARGIN_MS);
        return;
      }
      this.open.set(key, now + toolBoundMs(event.name ?? '', event.input) + TOOL_SILENCE_MARGIN_MS);
      return;
    }
    if (event.type === 'tool_result') {
      const key = this.keyOf(event);
      if (key !== undefined) this.open.delete(key);
    }
  }

  /** True while a call is open and not yet past its own limit. */
  holds(now: number = Date.now()): boolean {
    let held = false;
    for (const [key, deadline] of this.open) {
      if (deadline > now) held = true;
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
