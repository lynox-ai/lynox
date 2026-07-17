/**
 * Per-tool inline label rendering for chat tool calls.
 *
 * Extracted from `ChatView.svelte` so the labelling rules can be unit-tested
 * without booting Svelte runes. The component still does the i18n lookup +
 * the actual rendering — this helper just maps `(tool name, input)` to the
 * pieces of text that go into the bubble.
 *
 * For trust + debugging UX (see HN-launch hardening), `memory_recall` is
 * deliberately rendered as a discrete tool call here. The pipeline that gets
 * it on screen (StreamProcessor → SSE → chat store → ChatView) is
 * regression-tested in `stream.test.ts` and this file's `.test.ts` so a
 * future "hide internal tools" refactor can't silently bury it.
 */

/** Tools hidden from inline display (truly redundant or noisy). */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'artifact_list',
  'data_store_list',
  // Terminal follow-up-chips tool: its output is the pills, not a tool card.
  'suggest_follow_ups',
]);

/** Result of label resolution. `null` = render nothing (tool is hidden). */
export interface ToolLabelParts {
  /** Translated action verb, e.g. "Knowledge recalled". */
  action: string;
  /** Subject text — empty string is OK (renders no separator). */
  subject: string;
}

/** Translator function shape — accepts an i18n key, returns the rendered string. */
export type Translator = (key: string) => string;

/**
 * Stringify a tool-input field that might be missing. Plain `String(x)`
 * turns `undefined` into the literal `"undefined"`, which leaked into the
 * memory_recall bubble whenever the LLM omitted the optional `query` arg
 * (see `src/tools/builtin/memory.ts` — query is optional; namespace-only
 * is a valid recall path).
 */
function strOrEmpty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Build the inline label for memory_recall. When the LLM passes a `query`
 * we show it directly. When the LLM uses the no-query path (recency-ranked
 * namespace dump), we show the namespace so the user still sees WHAT was
 * being recalled — otherwise the bubble would read "Knowledge recalled —"
 * with a trailing dash and no signal at all.
 */
function memoryRecallLabel(input: Record<string, unknown> | undefined, t: Translator): ToolLabelParts {
  const query = strOrEmpty(input?.['query']).trim();
  if (query.length > 0) {
    return { action: t('tool.knowledge_recalled'), subject: query };
  }
  const namespace = strOrEmpty(input?.['namespace']).trim();
  return { action: t('tool.knowledge_recalled'), subject: namespace };
}

function lastPathSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Map a tool call to its inline label. Returns `null` for hidden tools.
 *
 * Parallel to `TOOL_DISPLAY_NAMES` in `core/src/types/modes.ts` but renders
 * to <action> + <subject> rather than a single label — kept here because the
 * subject extraction differs per tool (input field name, slicing rules).
 */
export function toolCallLabel(
  toolName: string,
  input: unknown,
  t: Translator,
): ToolLabelParts | null {
  if (HIDDEN_TOOLS.has(toolName)) return null;
  const inp = (typeof input === 'object' && input !== null)
    ? input as Record<string, unknown>
    : undefined;

  switch (toolName) {
    case 'data_store_query':  return { action: t('tool.data_queried'),    subject: strOrEmpty(inp?.['collection']) };
    case 'data_store_insert': return { action: t('tool.data_stored'),     subject: strOrEmpty(inp?.['collection']) };
    case 'data_store_create': return { action: t('tool.table_created'),   subject: strOrEmpty(inp?.['collection']) };
    case 'memory_store':      return { action: t('tool.remembered'),      subject: strOrEmpty(inp?.['content']).slice(0, 50) };
    case 'memory_recall':     return memoryRecallLabel(inp, t);
    case 'memory_update':     return { action: t('tool.knowledge_updated'), subject: '' };
    case 'write_file':        return { action: t('tool.file_written'),    subject: lastPathSegment(strOrEmpty(inp?.['path'])) };
    case 'read_file':         return { action: t('tool.file_read'),       subject: lastPathSegment(strOrEmpty(inp?.['path'])) };
    case 'bash':              return { action: t('tool.command'),         subject: strOrEmpty(inp?.['command']).slice(0, 60) };
    case 'http_request':      return { action: t('tool.api_request'),     subject: `${strOrEmpty(inp?.['method']) || 'GET'} ${strOrEmpty(inp?.['url'])}`.trim() };
    case 'web_research':      return { action: t('tool.web_search'),      subject: strOrEmpty(inp?.['query']) };
    case 'run_workflow':      return { action: t('tool.pipeline'),        subject: strOrEmpty(inp?.['name']) };
    case 'spawn_agent':       return { action: t('tool.delegated'),       subject: strOrEmpty(inp?.['task']).slice(0, 50) };
    case 'artifact_save':     return { action: t('tool.artifact_saved'),  subject: strOrEmpty(inp?.['title']) };
    case 'task_create':       return { action: t('tool.task_created'),    subject: strOrEmpty(inp?.['title']) };
    default:                  return { action: toolName, subject: '' };
  }
}
