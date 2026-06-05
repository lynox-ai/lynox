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

export function projectMessages(records: ThreadMessageRecord[]): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  // Carries tool_use id → its RenderedToolCall, so later tool_result
  // carriers (possibly many messages later) can attach results by id.
  const toolCallById = new Map<string, RenderedToolCall>();

  for (const r of records) {
    const content = parseContent(r.content_json);
    const role = r.role === 'assistant' ? 'assistant' : 'user';

    if (role === 'user') {
      if (Array.isArray(content) && content.length > 0 && content.every((b) => b.type === 'tool_result')) {
        // Tool-result carrier: merge into previously-emitted tool calls.
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
    // tool calls whose only text is the placeholder (or nothing at all). It
    // carries no information for the user — rendering it shows a confusing
    // empty "[…]" bubble. Its cost still lives in the thread total.
    if (toolCalls.length === 0 && (textAccum === THINKING_ONLY_PLACEHOLDER || textAccum.trim() === '')) {
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

  return out;
}
