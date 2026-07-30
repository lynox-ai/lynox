import type { ThreadMessageRecord } from './thread-store.js';

/**
 * Placeholder substituted by the agent for a thinking-only turn — a turn whose
 * entire output budget went to extended thinking, leaving no text. The agent
 * persists this so the message JSON stays valid for Anthropic (an empty
 * assistant content array is rejected), but it is a persistence artifact, NOT
 * something the user should see — `projectMessages` suppresses it (rafael
 * 2026-06-05: a "[…]" bubble at the end of a long chat). Shared so the agent's
 * substitution and this filter can never drift apart.
 */
export const THINKING_ONLY_PLACEHOLDER = '[…]';

/**
 * Trailing text block the agent appends to a tool-result carrier turn so the
 * model unmistakably reads it as the output of ITS OWN tool calls — not a new
 * (empty) user message. Without it, models sometimes reply "looks like an empty
 * submit / let me know when you want to continue" (a wasted, billed turn — prod
 * thread 2026-06-11). Lives at the decision point (the tool-result turn) rather
 * than the always-on system prefix, so it costs ~nothing per non-tool turn.
 * Shared so the agent's append and this projection's carrier-detection +
 * suppression can never drift apart — the hint must never render as a bubble.
 */
export const TOOL_RESULT_CONTINUATION_HINT =
  '[The block(s) above are results of your own tool calls — continue the task or briefly confirm. This is not a new user message.]';

/**
 * Prefix for the model-only extended-tool-guidance carrier block (see
 * `ToolEntry.detailedGuidance`). The agent injects `${TOOL_GUIDANCE_MARKER} <tool>:
 * <guidance>` into the tool-result carrier the first time a tool with detailed
 * guidance is used; like the continuation hint it must NEVER render as a chat
 * bubble. A prefix (not an exact string) because the guidance text varies per
 * tool. Shared so the agent's append and this projection's suppression can never
 * drift apart.
 */
export const TOOL_GUIDANCE_MARKER = '[tool-guidance]';

/**
 * UI-ready projection of stored thread messages.
 *
 * The storage layer keeps raw Anthropic `BetaMessageParam` shape (role + content
 * blocks). The Web UI wants a flattened, role-aware shape with tool-calls and
 * their results paired into a single structure, safety wrappers stripped, and
 * tool-result carrier messages (role='user' with tool_result blocks) merged
 * into the preceding assistant turn rather than rendered as empty user bubbles.
 *
 * `projectMessages()` is the single entry point; the shapes below mirror the
 * Web UI `ChatMessage` / `ContentBlock` / `ToolCallInfo` interfaces so the
 * client can consume them 1:1 without reverse-engineering.
 */

export interface RenderedToolCall {
  name: string;
  input: unknown;
  result?: string;
  status: 'running' | 'done' | 'error';
}

export type RenderedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; index: number };

/** Token/cost rollup for one assistant turn. Mirrors the Web UI `UsageInfo`
 *  so the client consumes it 1:1. `tokensIn` is the full input (base + both
 *  cache buckets). */
export interface RenderedUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  model?: string;
  /** Diagnostics fields persisted in usage_json (see RunUsageSummary) so the
   *  opt-in diagnostics panel survives a thread resume. */
  runId?: string;
  durationMs?: number;
}

/** Structured failure-note marker (B-full). The engine persists this as the
 *  content of a display-only assistant row instead of an English prose note,
 *  so the UI can render a localized message keyed by `code`. `detail` is a
 *  sanitized provider-error snippet (may be empty/absent). */
export interface DisplayNoteMarker {
  code: string;
  detail?: string;
}

export interface RenderedMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  blocks?: RenderedContentBlock[];
  toolCalls?: RenderedToolCall[];
  usage?: RenderedUsage;
  /** Set when this row is a B-full failure note — the client renders a
   *  localized banner from `note.code` instead of `content`. */
  note?: DisplayNoteMarker;
  created_at: string;
}

const NOTE_KEY = '_lynox_note';

/** Build the content payload for a display-only failure note. Persisted via
 *  `ThreadStore.appendDisplayNotes`; recognized on read by `parseDisplayNote`. */
export function buildDisplayNoteContent(code: string, detail?: string): Record<string, DisplayNoteMarker> {
  const marker: DisplayNoteMarker = detail !== undefined && detail !== '' ? { code, detail } : { code };
  return { [NOTE_KEY]: marker };
}

/** Strip control chars + cap length for a failure-note detail embedded from a
 *  provider error body, which can echo attacker-influenced bytes (e.g. a
 *  fetched URL reflected in a 4xx). Done char-by-char to avoid a control-char
 *  regex literal. */
export function sanitizeNoteDetail(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out.slice(0, 300);
}

function parseDisplayNote(raw: string): DisplayNoteMarker | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v) && NOTE_KEY in v) {
      const m = (v as Record<string, unknown>)[NOTE_KEY];
      if (m && typeof m === 'object') {
        const code = (m as Record<string, unknown>)['code'];
        const detail = (m as Record<string, unknown>)['detail'];
        if (typeof code === 'string') {
          return typeof detail === 'string' ? { code, detail } : { code };
        }
      }
    }
  } catch { /* not JSON / not a note */ }
  return null;
}

interface RawContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

// Matches scanToolResult()'s prefix in output-guard.ts.
const TOOL_RESULT_WARNING_RE =
  /^⚠ WARNING: This tool result contains text that resembles prompt injection[^\n]*\.\n\n/;

// Matches wrapUntrustedData()'s envelope in data-boundary.ts.
const UNTRUSTED_DATA_RE =
  /<untrusted_data source="[^"]*">\n?([\s\S]*?)\n?<\/untrusted_data>/g;

// Matches the inner WARNING line wrapUntrustedData emits when injection
// is detected — it appears inside the unwrapped payload after the
// envelope is stripped above.
const INNER_WARNING_RE =
  /^⚠ WARNING: This content contains text that resembles prompt injection[^\n]*\.\n/;

/**
 * Strip server-injected safety wrappers from tool-result text. The wrappers
 * are defense-in-depth for the model's context; they should not bleed into
 * the user-facing render path. Storage keeps the originals intact.
 */
export function stripSafetyMarkers(s: string): string {
  if (!s) return s;
  let out = s.replace(TOOL_RESULT_WARNING_RE, '');
  out = out.replace(UNTRUSTED_DATA_RE, '$1');
  out = out.replace(INNER_WARNING_RE, '');
  return out;
}

function toolResultContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = b as RawContentBlock;
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'image') return '[image]';
      return '';
    })
    .join('');
}

function extractTextFromBlocks(blocks: RawContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function parseContent(raw: string): RawContentBlock[] | string {
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v as RawContentBlock[];
    return '';
  } catch {
    return raw;
  }
}

/** Parse the stored `usage_json` column into a `RenderedUsage`. Tolerant:
 *  null / malformed / missing-fields all collapse to `undefined`, so a bad
 *  row degrades to "no footer" instead of breaking the whole projection. */
function parseUsage(raw: string | null): RenderedUsage | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== 'object') return undefined;
    const u = v as Record<string, unknown>;
    if (typeof u['tokensIn'] !== 'number') return undefined;
    const num = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    const usage: RenderedUsage = {
      tokensIn: u['tokensIn'],
      tokensOut: num('tokensOut'),
      cacheRead: num('cacheRead'),
      cacheWrite: num('cacheWrite'),
      costUsd: num('costUsd'),
    };
    if (typeof u['model'] === 'string') usage.model = u['model'].slice(0, 64);
    if (typeof u['runId'] === 'string') usage.runId = u['runId'].slice(0, 64);
    if (typeof u['durationMs'] === 'number') usage.durationMs = u['durationMs'];
    return usage;
  } catch {
    return undefined;
  }
}

/** The interleaved-block view of an assistant message: its own `blocks` when it
 *  has them, else a single synthesized text block from `content` (so a
 *  string-content iteration still contributes to a merged block sequence). */
function asBlocks(m: RenderedMessage): RenderedContentBlock[] {
  if (m.blocks && m.blocks.length > 0) return m.blocks;
  if (m.content) return [{ type: 'text', text: m.content }];
  return [];
}

/**
 * Merge one assistant iteration (`add`) into the running turn message (`into`).
 * A multi-step turn is persisted as several assistant rows (text → tool_use →
 * [tool_result carrier] → text → …); the carriers are already suppressed by the
 * main loop, so consecutive assistant entries in the projection are iterations
 * of ONE turn and must render as ONE bubble — matching the live stream, which
 * accumulates them into a single message (chat.svelte.ts). Without this a
 * resumed turn shows as N "assistant"-badged blocks with N footers (#4).
 *
 * - `blocks` are concatenated with `add`'s tool_call indices shifted past
 *   `into`'s existing tool calls, and a text/text seam coalesced into one block
 *   (same growing-text-block behaviour as the live path).
 * - `content` gets the live `\n\n` separator when text follows a tool call.
 * - `usage` takes `add`'s when present — only the FINAL row of a run carries the
 *   cumulative rollup (ThreadStore.setMessageUsage), so last-non-null = the
 *   turn's Σ total the live footer shows.
 */
function mergeAssistantInto(into: RenderedMessage, add: RenderedMessage): void {
  const intoToolCount = into.toolCalls?.length ?? 0;
  const intoBlocks = asBlocks(into);
  const addBlocks = asBlocks(add).map((b) =>
    b.type === 'tool_call' ? { type: 'tool_call' as const, index: b.index + intoToolCount } : b);

  const mergedBlocks: RenderedContentBlock[] = intoBlocks.slice();
  for (const b of addBlocks) {
    const last = mergedBlocks[mergedBlocks.length - 1];
    if (b.type === 'text' && last && last.type === 'text') {
      mergedBlocks[mergedBlocks.length - 1] = { type: 'text', text: last.text + b.text };
    } else {
      mergedBlocks.push(b);
    }
  }

  if (into.content && add.content) {
    const lastIntoBlock = intoBlocks[intoBlocks.length - 1];
    if (lastIntoBlock && lastIntoBlock.type === 'tool_call'
      && !into.content.endsWith('\n') && !into.content.endsWith(' ')) {
      into.content += '\n\n';
    }
  }
  into.content += add.content;
  if (mergedBlocks.length > 0) into.blocks = mergedBlocks;
  if (add.toolCalls && add.toolCalls.length > 0) {
    into.toolCalls = [...(into.toolCalls ?? []), ...add.toolCalls];
  }
  if (add.usage) into.usage = add.usage;
}

/**
 * @param opts.mergeTurns — collapse a turn's consecutive assistant iterations
 *   into one message (the UI-ready default). Pass `false` for a raw,
 *   per-iteration view — the debug export wants the granular row-by-row truth,
 *   not the merged bubble the chat renders (#4).
 */
export function projectMessages(
  records: ThreadMessageRecord[],
  opts?: { mergeTurns?: boolean },
): RenderedMessage[] {
  const mergeTurns = opts?.mergeTurns ?? true;
  const out: RenderedMessage[] = [];
  // Carries tool_use id → its RenderedToolCall, so later tool_result
  // carriers (possibly many messages later) can attach results by id.
  const toolCallById = new Map<string, RenderedToolCall>();

  for (const r of records) {
    const content = parseContent(r.content_json);
    const role = r.role === 'assistant' ? 'assistant' : 'user';

    if (role === 'user') {
      if (Array.isArray(content) && content.length > 0
        && content.every((b) => b.type === 'tool_result'
          || (b.type === 'text' && b.text === TOOL_RESULT_CONTINUATION_HINT)
          || (b.type === 'text' && b.text !== undefined && b.text.startsWith(TOOL_GUIDANCE_MARKER)))) {
        // Tool-result carrier (incl. a degenerate hint-only turn): merge any
        // tool_results into previously-emitted tool calls; the hint never
        // renders. Arbitrary user text alongside a tool_result is NOT a carrier
        // (the `every` fails) and renders normally.
        // Never renders as its own bubble.
        for (const block of content) {
          const id = block.tool_use_id ?? '';
          const target = toolCallById.get(id);
          if (!target) continue;
          const text = toolResultContentToString(block.content);
          target.result = stripSafetyMarkers(text);
          target.status = block.is_error ? 'error' : 'done';
        }
        continue;
      }

      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? extractTextFromBlocks(content)
          : '';
      out.push({
        seq: r.seq,
        role: 'user',
        content: text,
        created_at: r.created_at,
      });
      continue;
    }

    // role === 'assistant'
    // B-full failure note: a display-only assistant row whose content is a
    // structured marker. Emit it as `note` (localized client-side) rather than
    // running it through the normal text/block projection.
    const note = parseDisplayNote(r.content_json);
    if (note) {
      out.push({ seq: r.seq, role: 'assistant', content: '', note, created_at: r.created_at });
      continue;
    }
    const usage = parseUsage(r.usage_json);
    if (typeof content === 'string') {
      const msg: RenderedMessage = {
        seq: r.seq,
        role: 'assistant',
        content,
        created_at: r.created_at,
      };
      if (usage) msg.usage = usage;
      out.push(msg);
      continue;
    }
    if (!Array.isArray(content)) {
      const fallback: RenderedMessage = { seq: r.seq, role: 'assistant', content: '', created_at: r.created_at };
      if (usage) fallback.usage = usage;
      out.push(fallback);
      continue;
    }

    const blocks: RenderedContentBlock[] = [];
    const toolCalls: RenderedToolCall[] = [];
    let textAccum = '';

    for (const block of content) {
      if (block.type === 'text') {
        const text = block.text ?? '';
        blocks.push({ type: 'text', text });
        textAccum += text;
      } else if (block.type === 'tool_use') {
        const idx = toolCalls.length;
        blocks.push({ type: 'tool_call', index: idx });
        const tc: RenderedToolCall = {
          name: block.name ?? '',
          input: block.input,
          status: 'running',
        };
        toolCalls.push(tc);
        if (block.id) toolCallById.set(block.id, tc);
      }
      // thinking blocks + any unknown types: drop silently for render projection
    }

    // Suppress a thinking-only persistence artifact: an assistant turn with no
    // tool calls whose only text is the placeholder (or empty). It carries no
    // information for the user — rendering it shows a confusing empty "[…]"
    // bubble. Its cost still lives in the thread total. Guard the empty-text
    // case to turns whose raw content is ALL text blocks: a turn that produced
    // an image / document / server-tool / other non-text block projects to
    // empty text here (those block types aren't rendered in this loop) but is a
    // REAL message and must NOT be dropped.
    const allBlocksAreText = content.every((b) => b.type === 'text');
    if (toolCalls.length === 0 && (textAccum === THINKING_ONLY_PLACEHOLDER || (textAccum.trim() === '' && allBlocksAreText))) {
      // The suppressed row is dropped, but if it is the run's FINAL row it carries
      // the cumulative usage rollup (setMessageUsage stamps the highest-seq
      // assistant row). Hoist that onto the turn's last visible assistant message
      // so the merged footer still shows the run's Σ total instead of losing it.
      const prev = out[out.length - 1];
      if (usage && prev !== undefined && prev.role === 'assistant' && prev.note === undefined) {
        prev.usage = usage;
      }
      continue;
    }

    const msg: RenderedMessage = {
      seq: r.seq,
      role: 'assistant',
      content: textAccum,
      created_at: r.created_at,
    };
    if (blocks.length > 0) msg.blocks = blocks;
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
    if (usage) msg.usage = usage;
    out.push(msg);
  }

  // Merge consecutive assistant iterations of the same turn into one message
  // (#4). The main loop emits one entry per stored assistant ROW, but a
  // multi-step turn is many rows; a real USER message (which pushes an entry)
  // separates turns, while tool-result carriers between iterations were
  // suppressed above — so adjacent assistant entries here belong to ONE turn.
  // A B-full failure note (`note`) is a distinct localized element and never
  // merges. The shared RenderedToolCall refs mean a carrier's later result
  // update still reaches the merged message's tool call.
  if (!mergeTurns) return out;
  const merged: RenderedMessage[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (m.role === 'assistant' && m.note === undefined
      && last !== undefined && last.role === 'assistant' && last.note === undefined) {
      mergeAssistantInto(last, m);
    } else {
      merged.push(m);
    }
  }
  return merged;
}
