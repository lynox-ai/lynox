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
    return { action: t('tool.knowledge_recalled'), subject: cut(query) };
  }
  const namespace = strOrEmpty(input?.['namespace']).trim();
  return { action: t('tool.knowledge_recalled'), subject: namespace };
}

function lastPathSegment(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * The longest subject the line shows; a longer one is cut and ends in „…“. A file name is
 * never cut: it is short, and a cut one loses its extension.
 */
const SUBJECT_MAX = 50;

/** `text` as the characters a reader sees; code points where the browser has no `Intl.Segmenter`. */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') return Array.from(text);
  return Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), (part) => part.segment);
}

/**
 * How much of a text is looked at before it is cut: a few code units per character the line can
 * show. A model can write a subject of megabytes (a heredoc, a stored note); splitting all of it
 * into characters on every render would stall the chat.
 */
const SUBJECT_UNITS_MAX = SUBJECT_MAX * 4;

/**
 * The longest one character may be, in code units. Longer is a base with a pile of combining
 * marks, which draws over the rows around it; it keeps its base. The longest emoji sequences
 * (a family, a couple with skin tones) stay below it.
 */
const CHAR_UNITS_MAX = 24;

/** `text` as characters, each at most {@link CHAR_UNITS_MAX} code units (else its base alone). */
function boundedChars(text: string): string[] {
  return graphemes(text).map((char) => (char.length > CHAR_UNITS_MAX ? String.fromCodePoint(char.codePointAt(0) ?? 0x20) : char));
}

/**
 * A file name as the line shows it: whole, as long as a line could ever show it. A longer one (a
 * name of megabytes is still one) keeps its end, so the extension stays, after „…“.
 */
function boundName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= SUBJECT_UNITS_MAX) return boundedChars(trimmed).join('');
  // Clipped from the front by code units, the first character may be a piece of one: it goes.
  return `…${boundedChars(trimmed.slice(-SUBJECT_UNITS_MAX)).slice(1).join('')}`;
}

/** The file name at the end of `path`, bounded as {@link boundName} does. */
function fileName(path: string): string {
  return boundName(lastPathSegment(path));
}

/**
 * `text` trimmed, at most {@link SUBJECT_MAX} characters, ending in „…“ when it was cut.
 * Counted by what a reader sees as one character, so a cut does not split an emoji or a flag.
 */
function cut(text: string): string {
  const trimmed = text.trim();
  const clipped = trimmed.length > SUBJECT_UNITS_MAX;
  const chars = boundedChars(clipped ? trimmed.slice(0, SUBJECT_UNITS_MAX) : trimmed);
  // Clipped by code units, the last character may be a piece of one: it goes, and the cut shows.
  if (clipped) return `${chars.slice(0, Math.min(chars.length - 1, SUBJECT_MAX - 1)).join('')}…`;
  return chars.length > SUBJECT_MAX ? `${chars.slice(0, SUBJECT_MAX - 1).join('')}…` : chars.join('');
}

/** The first of `fields` that holds text, cut. */
function firstOf(input: Record<string, unknown> | undefined, ...fields: string[]): string {
  for (const field of fields) {
    const value = strOrEmpty(input?.[field]).trim();
    if (value.length > 0) return cut(value);
  }
  return '';
}

/** The profile an api_setup call is about: `id`, or the id of the profile it writes; else none. */
function apiProfileId(input: Record<string, unknown> | undefined): string {
  const id = strOrEmpty(input?.['id']).trim();
  if (id.length > 0) return id;
  const profile = input?.['profile'];
  if (typeof profile !== 'object' || profile === null) return '';
  return strOrEmpty((profile as Record<string, unknown>)['id']).trim();
}

/** The inbox zones by the bucket names the tool takes, as the inbox page names them. */
const INBOX_ZONE_KEYS: Readonly<Record<string, string>> = {
  requires_user: 'inbox.zone_needs_you',
  draft_ready: 'inbox.zone_drafted',
  auto_handled: 'inbox.zone_handled',
};

function inboxReadSubject(input: Record<string, unknown> | undefined, t: Translator): string {
  if (input?.['action'] === 'item') return '';
  const bucket = strOrEmpty(input?.['bucket']);
  // Own keys only: a bucket named `constructor` or `__proto__` is no zone.
  return Object.hasOwn(INBOX_ZONE_KEYS, bucket) ? t(INBOX_ZONE_KEYS[bucket] ?? '') : '';
}

/** Where a bulk run works: the API host, the collection, or the file it reads its list from. */
function bulkPlanSubject(input: Record<string, unknown> | undefined): string {
  switch (input?.['target_system']) {
    case 'http':       return firstOf(input, 'target_host');
    case 'data_store': return firstOf(input, 'target_collection');
    case 'workspace':  return fileName(strOrEmpty(input?.['source_file']));
    default:           return '';
  }
}

function batchFilesAction(input: Record<string, unknown> | undefined): string {
  switch (input?.['operation']) {
    case 'rename':    return 'tool.files_renamed';
    case 'move':      return 'tool.files_moved';
    case 'transform': return 'tool.files_text_replaced';
    default:          return 'tool.files_processed';
  }
}

function googleDriveSubject(input: Record<string, unknown> | undefined): string {
  switch (input?.['action']) {
    case 'search':     return firstOf(input, 'query');
    case 'upload':     return boundName(strOrEmpty(input?.['file_name']));
    case 'create_doc': return firstOf(input, 'file_name');
    default:           return '';
  }
}

function subjectsMergeSubject(input: Record<string, unknown> | undefined): string {
  const duplicate = strOrEmpty(input?.['duplicate']).trim();
  const canonical = strOrEmpty(input?.['canonical']).trim();
  return duplicate && canonical ? cut(`${duplicate} → ${canonical}`) : '';
}

/**
 * Map a tool call to its inline label. Returns `null` for hidden tools.
 *
 * Parallel to `TOOL_DISPLAY_NAMES` in `core/src/types/modes.ts` but renders
 * to <action> + <subject> rather than a single label — kept here because the
 * subject extraction differs per tool (input field name, slicing rules).
 *
 * The side panel calls this without an input, so every label holds without one.
 * A subject is only ever a readable field: never an opaque id, a mail's text, a
 * secret's value or a raw enum value (memory_recall's namespace fallback, older than
 * this rule, is the one exception). A tool that asks before it acts is named by
 * a noun ("New email"), since a declined call still shows the done mark; so is a tool
 * with several actions ("Google Drive", "Credentials") and one that reports a state
 * ("Bulk run status"). A file name is shown whole; other free text is cut at 50.
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
    case 'data_store_query':  return { action: t('tool.data_queried'),    subject: firstOf(inp, 'collection') };
    case 'data_store_insert': return { action: t('tool.data_stored'),     subject: firstOf(inp, 'collection') };
    case 'data_store_create': return { action: t('tool.table_created'),   subject: firstOf(inp, 'name') };
    case 'memory_store':      return { action: t('tool.remembered'),      subject: cut(strOrEmpty(inp?.['content'])) };
    case 'memory_recall':     return memoryRecallLabel(inp, t);
    case 'memory_update':     return { action: t('tool.knowledge_updated'), subject: '' };
    case 'write_file':        return { action: t('tool.file_written'),    subject: fileName(strOrEmpty(inp?.['path'])) };
    case 'read_file':         return { action: t('tool.file_read'),       subject: fileName(strOrEmpty(inp?.['path'])) };
    case 'bash':              return { action: t('tool.command'),         subject: cut(strOrEmpty(inp?.['command'])) };
    case 'http_request':      return { action: t('tool.api_request'),     subject: cut(`${strOrEmpty(inp?.['method']) || 'GET'} ${strOrEmpty(inp?.['url'])}`) };
    case 'web_research':      return { action: t('tool.web_search'),      subject: cut(strOrEmpty(inp?.['query'])) };
    case 'run_workflow':      return { action: t('tool.pipeline'),        subject: firstOf(inp, 'name') };
    case 'spawn_agent':       return { action: t('tool.delegated'),       subject: cut(strOrEmpty(inp?.['task'])) };
    case 'artifact_save':     return { action: t('tool.artifact_saved'),  subject: cut(strOrEmpty(inp?.['title'])) };
    case 'task_create':       return { action: t('tool.task_created'),    subject: cut(strOrEmpty(inp?.['title'])) };
    case 'ask_user':          return { action: t('tool.question'),        subject: '' };
    case 'plan_task':         return { action: t('tool.plan_created'),    subject: '' };
    case 'google_calendar':   return { action: t('tool.calendar'),        subject: '' };
    case 'api_setup':         return { action: t('tool.api_profiles'),    subject: apiProfileId(inp).slice(0, 64) };

    // Mail and inbox.
    case 'mail_read':          return { action: t('tool.mail_read'),           subject: '' };
    case 'mail_search':        return { action: t('tool.mails_searched'),      subject: firstOf(inp, 'text', 'subject', 'from') };
    case 'mail_reply':         return { action: t('tool.mail_reply'),          subject: '' };
    case 'mail_send':          return { action: t('tool.mail_new'),            subject: firstOf(inp, 'subject') };
    case 'mail_triage':        return { action: t('tool.inbox_triaged'),       subject: '' };
    case 'mail_connect':       return { action: t('tool.mailbox_connection'),  subject: firstOf(inp, 'email') };
    case 'inbox_read':         return { action: t('tool.inbox_read'),          subject: inboxReadSubject(inp, t) };
    case 'inbox_rule_propose': return { action: t('tool.inbox_rule_proposed'), subject: firstOf(inp, 'name') };

    // Bulk runs.
    case 'bulk_plan':   return { action: t('tool.bulk_planned'), subject: bulkPlanSubject(inp) };
    case 'bulk_status': return { action: t('tool.bulk_status'),  subject: '' };

    // Knowledge.
    case 'remember':          return { action: t('tool.remembered'),           subject: firstOf(inp, 'subject', 'text') };
    case 'recall':            return { action: t('tool.knowledge_recalled'),   subject: firstOf(inp, 'query') };
    case 'archive_search':    return { action: t('tool.archive_searched'),     subject: firstOf(inp, 'query') };
    case 'memory_block_edit': return { action: t('tool.knowledge_edit'),       subject: '' };
    case 'memory_delete':     return { action: t('tool.knowledge_deletion'),   subject: firstOf(inp, 'pattern') };
    case 'memory_list':       return { action: t('tool.knowledge_browsed'),    subject: firstOf(inp, 'pattern') };
    case 'memory_promote':    return { action: t('tool.knowledge_promotion'),  subject: firstOf(inp, 'content_pattern') };
    case 'memory_retire':     return { action: t('tool.knowledge_retirement'), subject: '' };
    case 'memory_focus':
      if (inp === undefined) return { action: t('tool.focus'), subject: '' };
      return firstOf(inp, 'subject')
        ? { action: t('tool.focus_set'), subject: firstOf(inp, 'subject') }
        : { action: t('tool.focus_cleared'), subject: '' };
    case 'subjects_merge':    return { action: t('tool.merge'),                subject: subjectsMergeSubject(inp) };
    case 'set_thread_context':
      if (inp === undefined) return { action: t('tool.project'), subject: '' };
      // As the tool reads it: any truthy `clear` clears.
      if (inp['clear']) return { action: t('tool.project_cleared'), subject: '' };
      return { action: t('tool.project_set'), subject: firstOf(inp, 'project', 'customer') };

    // Artifacts, data, files.
    case 'artifact_delete':    return { action: t('tool.artifact_deletion'),   subject: '' };
    case 'artifact_history':   return { action: t('tool.versions_viewed'),     subject: '' };
    case 'artifact_restore':   return { action: t('tool.version_restored'),    subject: '' };
    case 'data_store_delete':  return { action: t('tool.rows_deletion'),       subject: firstOf(inp, 'collection') };
    case 'data_store_drop':    return { action: t('tool.table_deletion'),      subject: firstOf(inp, 'collection') };
    case 'edit_file':          return { action: t('tool.file_edited'),         subject: fileName(strOrEmpty(inp?.['path'])) };
    case 'batch_files':        return { action: t(batchFilesAction(inp)),      subject: firstOf(inp, 'pattern') };
    case 'media_process':      return { action: t('tool.media_processed'),     subject: fileName(strOrEmpty(inp?.['input'])) };
    case 'recall_tool_result': return { action: t('tool.earlier_result_fetched'), subject: '' };

    // Contacts, calendar, credentials.
    case 'contacts_save':   return { action: t('tool.contact_saved'),     subject: firstOf(inp, 'name') };
    case 'contacts_search': return { action: t('tool.contacts_searched'), subject: firstOf(inp, 'query', 'email') };
    case 'calendar_read':   return { action: t('tool.calendar_read'),     subject: firstOf(inp, 'calendar') };
    case 'ask_secret':      return { action: t('tool.credentials'),       subject: inp?.['action'] === 'list' ? '' : firstOf(inp, 'name') };

    // Google Workspace: several actions each, so a noun.
    case 'google_docs':   return { action: t('tool.google_docs'),   subject: inp?.['action'] === 'create' ? firstOf(inp, 'title') : '' };
    case 'google_drive':  return { action: t('tool.google_drive'),  subject: googleDriveSubject(inp) };
    case 'google_sheets': return { action: t('tool.google_sheets'), subject: inp?.['action'] === 'create' ? firstOf(inp, 'title') : firstOf(inp, 'range') };

    // Workflows and tasks.
    case 'diagnose_workflow_run': return { action: t('tool.workflow_run_checked'),   subject: '' };
    case 'export_workflow':       return { action: t('tool.workflow_exported'),      subject: '' };
    case 'import_workflow':       return { action: t('tool.workflow_imported'),      subject: '' };
    case 'save_workflow':         return { action: t('tool.workflow_saved'),         subject: firstOf(inp, 'name') };
    case 'update_workflow_steps': return { action: t('tool.workflow_edit'),          subject: '' };
    case 'task_list':             return { action: t('tool.tasks_listed'),           subject: '' };
    case 'task_update':           return { action: t('tool.task_updated'),           subject: firstOf(inp, 'title') };

    default:                  return { action: toolName, subject: '' };
  }
}
