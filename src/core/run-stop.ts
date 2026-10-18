// The note a stopped run leaves in the MODEL's context.
//
// When a run is stopped (the user stops it, or the engine breaks a repeated tool
// call), its question and every completed tool pair stay in the context, so a
// "continue" finds the work. The model is told the run did not finish by a short
// text that is NEVER persisted and never rendered: it is added to the outgoing
// copy of the history only, right after the kept prefix of the stopped turn.
//
// WHY NOT A PERSISTED BLOCK. A persisted marker would be recognized again by its
// TEXT (to hide it in the UI, to keep it out of memory extraction), and anything a
// user can type can then be forged. Here the source is state no user can write:
//   - live: a Symbol-keyed field on the message object. JSON cannot carry a
//     Symbol, so neither an HTTP body nor a stored row can produce one, and
//     `JSON.stringify` drops it on every write. Object spread copies it, so the
//     sanitize / eviction passes that rebuild a message keep it.
//   - after a reload: the display-only note row the engine writes for the stop,
//     flagged `inContext` (render-projection.ts `buildDisplayNoteContent`). Only
//     `appendDisplayNotes` writes display-only assistant rows whose content is an
//     object; no client path can (enumerated in the PR).
// A user who types the marker text sends plain text: nothing reads it back.

import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import type { ThreadMessageRecord } from './thread-store.js';
import { sanitizeNoteDetail } from './render-projection.js';

export type RunStopCode = 'run_interrupted' | 'tool_loop_break';

export interface RunStop {
  readonly code: RunStopCode;
  /** For a loop break: the repeated call, as the display note names it. */
  readonly detail?: string | undefined;
}

const RUN_STOP = Symbol('lynox.runStop');

type WithStop = BetaMessageParam & { [RUN_STOP]?: RunStop };

export function isRunStopCode(code: unknown): code is RunStopCode {
  return code === 'run_interrupted' || code === 'tool_loop_break';
}

/** The display-note detail for a loop break, from `ToolLoopBreakError.loopKey`
 *  (`tool\x00input`). One function for the live note and the stored one, so the
 *  text the model reads is the same before and after a reload. */
export function loopBreakDetail(loopKey: string): string {
  return sanitizeNoteDetail(`repeated call: ${loopKey.split('\x00').join(' ')}`);
}

/** A copy of `msg` that carries `stop`. */
export function withRunStop(msg: BetaMessageParam, stop: RunStop): BetaMessageParam {
  return { ...msg, [RUN_STOP]: stop } as WithStop;
}

export function readRunStop(msg: BetaMessageParam): RunStop | undefined {
  return (msg as WithStop)[RUN_STOP];
}

export function runStopText(stop: RunStop): string {
  return stop.code === 'tool_loop_break'
    ? `[This run was stopped by lynox because the same tool call kept repeating (${stop.detail ?? 'repeated call'}). Do not repeat that call; the steps above are kept.]`
    : '[This run was stopped by the user before it finished. The steps above are kept.]';
}

/**
 * The outgoing copy: each user message that carries a stop gets the stop text as
 * a last text block. The input array and its messages are not touched. Returns
 * the input itself when nothing carries a stop.
 */
export function applyRunStops(messages: BetaMessageParam[]): BetaMessageParam[] {
  let out: BetaMessageParam[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const stop = readRunStop(msg);
    if (stop === undefined || msg.role !== 'user') continue;
    out ??= messages.slice();
    const blocks: BetaContentBlockParam[] = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content.slice();
    blocks.push({ type: 'text', text: runStopText(stop) });
    out[i] = { role: msg.role, content: blocks };
  }
  return out ?? messages;
}

function toolUseIds(msg: BetaMessageParam): string[] {
  if (!Array.isArray(msg.content)) return [];
  const ids: string[] = [];
  for (const b of msg.content) if (b.type === 'tool_use') ids.push(b.id);
  return ids;
}

function toolResultIds(msg: BetaMessageParam): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(msg.content)) return ids;
  for (const b of msg.content) if (b.type === 'tool_result') ids.add(b.tool_use_id);
  return ids;
}

/**
 * End (exclusive) of a stopped run's completed prefix: the question at
 * `questionIdx`, then every (assistant, user) pair whose tool calls all have
 * their results. The first pair that is not complete, and everything after it,
 * is the unfinished step.
 */
export function completedPrefixEnd(messages: readonly BetaMessageParam[], questionIdx: number): number {
  let i = questionIdx + 1;
  while (i + 1 < messages.length) {
    const a = messages[i]!;
    const u = messages[i + 1]!;
    if (a.role !== 'assistant' || u.role !== 'user') break;
    const results = toolResultIds(u);
    if (!toolUseIds(a).every((id) => results.has(id))) break;
    i += 2;
  }
  return i;
}

/** The stop a stored display note names, when it was written for a run whose
 *  prefix stayed in the context. Anything else (another code, an older note
 *  without the flag, a row that is not a note) is null. */
export function runStopFromNoteRow(row: Pick<ThreadMessageRecord, 'role' | 'content_json' | 'display_only'>): RunStop | null {
  if (row.role !== 'assistant' || row.display_only !== 1) return null;
  let v: unknown;
  try { v = JSON.parse(row.content_json); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = (v as Record<string, unknown>)['_lynox_note'];
  if (!m || typeof m !== 'object') return null;
  const note = m as Record<string, unknown>;
  if (note['inContext'] !== true || !isRunStopCode(note['code'])) return null;
  const detail = note['detail'];
  return typeof detail === 'string' ? { code: note['code'], detail } : { code: note['code'] };
}

/**
 * The model's history from stored rows: the API rows, in order, with each stop
 * note attached to the API row right before it (by seq). `apiRows` are the
 * thread's API rows, `noteRows` its display-only rows (either may be a superset;
 * each row is judged by its own `display_only`). A note whose preceding API row
 * is not a user message attaches nowhere (the prefix it names is not there).
 */
export function hydrateApiMessages(
  apiRows: readonly ThreadMessageRecord[],
  noteRows: readonly ThreadMessageRecord[] = [],
): BetaMessageParam[] {
  const rows = [...apiRows.filter((r) => r.display_only !== 1), ...noteRows.filter((r) => r.display_only === 1)]
    .sort((a, b) => a.seq - b.seq);
  const out: BetaMessageParam[] = [];
  for (const r of rows) {
    if (r.display_only === 1) {
      const stop = runStopFromNoteRow(r);
      const prev = out[out.length - 1];
      if (stop !== null && prev !== undefined && prev.role === 'user') out[out.length - 1] = withRunStop(prev, stop);
      continue;
    }
    out.push({
      role: r.role as 'user' | 'assistant',
      content: JSON.parse(r.content_json) as BetaMessageParam['content'],
    });
  }
  return out;
}
