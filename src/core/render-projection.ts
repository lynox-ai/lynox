import type { ThreadMessageRecord } from './thread-store.js';

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

export interface RenderedMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  blocks?: RenderedContentBlock[];
  toolCalls?: RenderedToolCall[];
  created_at: string;
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
    if (typeof content === 'string') {
      out.push({
        seq: r.seq,
        role: 'assistant',
        content,
        created_at: r.created_at,
      });
      continue;
    }
    if (!Array.isArray(content)) {
      out.push({ seq: r.seq, role: 'assistant', content: '', created_at: r.created_at });
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

    const msg: RenderedMessage = {
      seq: r.seq,
      role: 'assistant',
      content: textAccum,
      created_at: r.created_at,
    };
    if (blocks.length > 0) msg.blocks = blocks;
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
    out.push(msg);
  }

  return out;
}
