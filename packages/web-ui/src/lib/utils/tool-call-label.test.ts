import { describe, expect, it } from 'vitest';
import { HIDDEN_TOOLS, toolCallLabel } from './tool-call-label.js';

// Identity translator — keeps test assertions about the i18n KEY rather than
// the rendered string. Locks in which key is used per tool without coupling
// to DE/EN copy that may legitimately drift.
const tk = (key: string): string => key;

describe('toolCallLabel', () => {
  describe('memory_recall — discrete visibility (HN trust-debug fix)', () => {
    it('renders the query as subject when present', () => {
      // Happy path: LLM passed a query → user sees what was being recalled.
      const out = toolCallLabel('memory_recall', { namespace: 'knowledge', query: 'pricing strategy' }, tk);
      expect(out).toEqual({ action: 'tool.knowledge_recalled', subject: 'pricing strategy' });
    });

    it('falls back to namespace when LLM uses the no-query recency-dump path', () => {
      // memory_recall accepts namespace-only — see core/src/tools/builtin/memory.ts.
      // Without this fallback the bubble would render "Knowledge recalled —"
      // with no signal at all.
      const out = toolCallLabel('memory_recall', { namespace: 'status' }, tk);
      expect(out).toEqual({ action: 'tool.knowledge_recalled', subject: 'status' });
    });

    it('NEVER renders the literal string "undefined" as subject', () => {
      // Regression: plain String(undefined) leaked "undefined" into the bubble
      // whenever the optional query arg was omitted. Guard both no-query
      // and the truly-empty input shape.
      const noQuery = toolCallLabel('memory_recall', { namespace: 'methods' }, tk);
      expect(noQuery?.subject).not.toBe('undefined');
      const emptyInput = toolCallLabel('memory_recall', {}, tk);
      expect(emptyInput?.subject).not.toBe('undefined');
      const nullInput = toolCallLabel('memory_recall', null, tk);
      expect(nullInput?.subject).not.toBe('undefined');
    });

    it('trims whitespace-only query then falls back to namespace', () => {
      // Defensive: a query of "  " should not pass as a real query — that
      // would render the bubble as "Knowledge recalled —    " with no signal.
      const out = toolCallLabel('memory_recall', { namespace: 'knowledge', query: '   ' }, tk);
      expect(out?.subject).toBe('knowledge');
    });

    it('is NOT in HIDDEN_TOOLS — must always be visible alongside other tools', () => {
      // Belt-and-braces guard. If anyone ever tries to "clean up" by hiding
      // memory tools from the chat, this assertion fails loudly. The HN demo
      // and trust-debug story depends on memory_recall being visible.
      expect(HIDDEN_TOOLS.has('memory_recall')).toBe(false);
      expect(HIDDEN_TOOLS.has('memory_store')).toBe(false);
      expect(HIDDEN_TOOLS.has('memory_update')).toBe(false);
      expect(HIDDEN_TOOLS.has('memory_delete')).toBe(false);
    });
  });

  describe('other tools — sanity', () => {
    it('renders web_research query', () => {
      const out = toolCallLabel('web_research', { query: 'lynox launch' }, tk);
      expect(out).toEqual({ action: 'tool.web_search', subject: 'lynox launch' });
    });

    it('cuts memory_store content at 50 chars, ending in an ellipsis', () => {
      const out = toolCallLabel('memory_store', { content: 'a'.repeat(120) }, tk);
      expect(out?.subject).toBe(`${'a'.repeat(49)}…`);
    });

    it('returns null for hidden tools', () => {
      expect(toolCallLabel('artifact_list', {}, tk)).toBeNull();
      expect(toolCallLabel('data_store_list', {}, tk)).toBeNull();
    });

    it('HIDDEN_TOOLS positive membership (symmetry guard)', () => {
      // Counterpart to the memory-tools-NOT-hidden guard above — pins
      // which tools are deliberately suppressed so a future "unhide
      // everything" change has to delete this assertion intentionally.
      expect(HIDDEN_TOOLS.has('artifact_list')).toBe(true);
      expect(HIDDEN_TOOLS.has('data_store_list')).toBe(true);
    });

    it('cuts a bash command at 50 chars, ending in an ellipsis', () => {
      const out = toolCallLabel('bash', { command: 'x'.repeat(120) }, tk);
      expect(out?.subject).toBe(`${'x'.repeat(49)}…`);
    });

    it('cuts a spawn_agent task at 50 chars, ending in an ellipsis', () => {
      const out = toolCallLabel('spawn_agent', { task: 'y'.repeat(120) }, tk);
      expect(out?.subject).toBe(`${'y'.repeat(49)}…`);
    });

    it('coerces non-string collection input via strOrEmpty (locks the contract)', () => {
      // strOrEmpty falls through to String(value) for non-string inputs;
      // this pins the coercion behaviour so a future "stricter type" pass
      // doesn't silently turn numeric collections into empty bubbles.
      const out = toolCallLabel('data_store_query', { collection: 42 }, tk);
      expect(out).toEqual({ action: 'tool.data_queried', subject: '42' });
    });

    it('returns empty subject for read/write_file with empty path', () => {
      // Edge: an LLM that emits `{ path: "" }` should render an empty
      // subject, not crash and not produce undefined.
      const read = toolCallLabel('read_file', { path: '' }, tk);
      expect(read?.subject).toBe('');
      const write = toolCallLabel('write_file', { path: '' }, tk);
      expect(write?.subject).toBe('');
    });

    it('falls back to the tool name as action for unknown tools', () => {
      // Unknown / future tools still surface — never silently dropped.
      const out = toolCallLabel('mystery_tool', { foo: 'bar' }, tk);
      expect(out).toEqual({ action: 'mystery_tool', subject: '' });
    });

    it('tolerates undefined / non-object inputs', () => {
      expect(() => toolCallLabel('bash', undefined, tk)).not.toThrow();
      expect(() => toolCallLabel('bash', 'not an object', tk)).not.toThrow();
      const out = toolCallLabel('bash', undefined, tk);
      expect(out).toEqual({ action: 'tool.command', subject: '' });
    });

    it('extracts last path segment for read_file / write_file', () => {
      const read = toolCallLabel('read_file', { path: '/tmp/nested/dir/file.txt' }, tk);
      expect(read?.subject).toBe('file.txt');
      const write = toolCallLabel('write_file', { path: 'shallow.md' }, tk);
      expect(write?.subject).toBe('shallow.md');
    });

    it('http_request renders METHOD + URL even when method is missing', () => {
      // Default GET — matches pre-refactor behaviour.
      const out = toolCallLabel('http_request', { url: 'https://api.example.com/x' }, tk);
      expect(out?.subject).toBe('GET https://api.example.com/x');
    });
  });

  describe('api_setup', () => {
    it('labels the call as API profiles, never by its raw tool name', () => {
      const out = toolCallLabel('api_setup', { action: 'list' }, tk);
      expect(out).toEqual({ action: 'tool.api_profiles', subject: '' });
    });

    it('names the profile by its id when the call has one', () => {
      expect(toolCallLabel('api_setup', { action: 'view', id: 'bexio' }, tk)).toEqual({ action: 'tool.api_profiles', subject: 'bexio' });
      expect(toolCallLabel('api_setup', { action: 'create', profile: { id: 'stripe', name: 'Stripe' } }, tk)).toEqual({ action: 'tool.api_profiles', subject: 'stripe' });
      // An explicit id wins over the profile's.
      expect(toolCallLabel('api_setup', { action: 'update', id: 'a', profile: { id: 'b' } }, tk)?.subject).toBe('a');
      // A blank id falls back to the profile's.
      expect(toolCallLabel('api_setup', { action: 'update', id: '  ', profile: { id: 'b' } }, tk)?.subject).toBe('b');
    });

    it('shows no subject for a missing or malformed profile', () => {
      expect(toolCallLabel('api_setup', { action: 'create', profile: 'stripe' }, tk)?.subject).toBe('');
      expect(toolCallLabel('api_setup', { action: 'create', profile: null }, tk)?.subject).toBe('');
      expect(toolCallLabel('api_setup', undefined, tk)?.subject).toBe('');
    });

    it('cuts an id longer than a stored one can be at 64 chars', () => {
      expect(toolCallLabel('api_setup', { action: 'view', id: 'z'.repeat(200) }, tk)?.subject).toBe('z'.repeat(64));
    });
  });

  describe('subjects', () => {
    const subject = (tool: string, input: unknown): string | undefined => toolCallLabel(tool, input, tk)?.subject;

    it('keeps 50 chars whole and cuts from 51 on, ending in an ellipsis', () => {
      expect(subject('remember', { text: 'r'.repeat(50) })).toBe('r'.repeat(50));
      expect(subject('remember', { text: 'r'.repeat(51) })).toBe(`${'r'.repeat(49)}…`);
      expect(subject('remember', { text: 'r'.repeat(51) })?.length).toBe(50);
      expect(subject('memory_promote', { content_pattern: 'p'.repeat(80) })).toBe(`${'p'.repeat(49)}…`);
      // Counted by grapheme: an emoji, a flag or a family at the cut stays whole.
      expect(subject('remember', { text: `${'e'.repeat(48)}😀😀xyz` })).toBe(`${'e'.repeat(48)}😀…`);
      expect(subject('remember', { text: `${'e'.repeat(48)}🇨🇭👨‍👩‍👧xyz` })).toBe(`${'e'.repeat(48)}🇨🇭…`);
      // Without Intl.Segmenter it counts code points: never longer than the cut, never throwing.
      const segmenter = Intl.Segmenter;
      try {
        (Intl as { Segmenter?: unknown }).Segmenter = undefined;
        expect(subject('remember', { text: `${'e'.repeat(48)}😀😀xyz` })).toBe(`${'e'.repeat(48)}😀…`);
      } finally {
        (Intl as { Segmenter?: unknown }).Segmenter = segmenter;
      }
    });

    it('takes the first field that holds text', () => {
      expect(subject('mail_search', { text: 'invoice', subject: 'x', from: 'y' })).toBe('invoice');
      expect(subject('mail_search', { text: '  ', subject: 'Order 12', from: 'y' })).toBe('Order 12');
      expect(subject('mail_search', { from: 'anna@example.com' })).toBe('anna@example.com');
      expect(subject('remember', { subject: 'Acme', text: 'pays late' })).toBe('Acme');
      expect(subject('remember', { text: 'pays late' })).toBe('pays late');
      expect(subject('contacts_search', { email: 'b@example.com' })).toBe('b@example.com');
      expect(subject('set_thread_context', { customer: 'Acme' })).toBe('Acme');
      expect(subject('set_thread_context', { project: 'Relaunch', customer: 'Acme' })).toBe('Relaunch');
    });

    it('shows no opaque id, mail text, secret value or pasted block', () => {
      expect(subject('mail_read', { uid: '4711', folder: 'INBOX' })).toBe('');
      expect(subject('mail_reply', { uid: '4711', body: 'Dear Anna, …' })).toBe('');
      expect(subject('mail_send', { to: 'a@example.com', body: 'secret plan' })).toBe('');
      expect(subject('mail_send', { subject: 'Offer', body: 'secret plan' })).toBe('Offer');
      expect(subject('bulk_status', { run_id: 'run-1' })).toBe('');
      expect(subject('artifact_delete', { id: 'a1' })).toBe('');
      expect(subject('artifact_history', { id: 'a1' })).toBe('');
      expect(subject('artifact_restore', { id: 'a1', version: 2 })).toBe('');
      expect(subject('recall_tool_result', { id: 'tr-3' })).toBe('');
      expect(subject('diagnose_workflow_run', { run_id: 'r9' })).toBe('');
      expect(subject('export_workflow', { workflow_id: 'w1' })).toBe('');
      expect(subject('update_workflow_steps', { workflow_id: 'w1' })).toBe('');
      expect(subject('import_workflow', { block: '{"steps":[]}' })).toBe('');
      expect(subject('task_update', { task_id: 't1', status: 'done' })).toBe('');
      expect(subject('task_update', { task_id: 't1', title: 'Call Anna' })).toBe('Call Anna');
      expect(subject('google_docs', { action: 'read', document_id: 'doc1' })).toBe('');
      expect(subject('google_drive', { action: 'read', file_id: 'f1' })).toBe('');
      expect(subject('memory_retire', { id: 'm1', reason: 'old' })).toBe('');
      expect(subject('memory_block_edit', { block: 'profile', new_text: 'x' })).toBe('');
      expect(subject('ask_secret', { action: 'collect', name: 'SHOP_TOKEN', prompt: 'p' })).toBe('SHOP_TOKEN');
      // A list names no one secret, even if the call carries a name.
      expect(subject('ask_secret', { action: 'list', name: 'SHOP_TOKEN' })).toBe('');
    });

    it('names an inbox zone as the inbox page does, never the raw bucket', () => {
      expect(subject('inbox_read', { action: 'list', bucket: 'requires_user' })).toBe('inbox.zone_needs_you');
      expect(subject('inbox_read', { action: 'list', bucket: 'draft_ready' })).toBe('inbox.zone_drafted');
      expect(subject('inbox_read', { action: 'list', bucket: 'auto_handled' })).toBe('inbox.zone_handled');
      expect(subject('inbox_read', { action: 'list', bucket: 'other' })).toBe('');
      expect(subject('inbox_read', { action: 'item', bucket: 'requires_user', id: 'i1' })).toBe('');
      expect(subject('inbox_read', { action: 'counts' })).toBe('');
    });

    it('names what a bulk run changes by its target system', () => {
      expect(subject('bulk_plan', { target_system: 'http', target_host: 'api.example.com' })).toBe('api.example.com');
      expect(subject('bulk_plan', { target_system: 'data_store', target_collection: 'products' })).toBe('products');
      expect(subject('bulk_plan', { target_system: 'workspace', source_file: 'data/in/list.csv' })).toBe('list.csv');
      expect(subject('bulk_plan', { target_host: 'api.example.com' })).toBe('');
    });

    it('reads the Google tools by action', () => {
      expect(subject('google_docs', { action: 'create', title: 'Q4 plan' })).toBe('Q4 plan');
      expect(subject('google_drive', { action: 'search', query: 'invoice' })).toBe('invoice');
      expect(subject('google_drive', { action: 'upload', file_name: 'a.pdf' })).toBe('a.pdf');
      expect(subject('google_drive', { action: 'create_doc', file_name: 'Notes' })).toBe('Notes');
      expect(subject('google_sheets', { action: 'create', title: 'Budget', range: 'A1' })).toBe('Budget');
      expect(subject('google_sheets', { action: 'read', range: 'Sheet1!A1:B2' })).toBe('Sheet1!A1:B2');
    });

    it('names files by their last path segment', () => {
      expect(subject('edit_file', { path: '/workspace/notes/todo.md' })).toBe('todo.md');
      expect(subject('media_process', { input: 'uploads/clip.mp4' })).toBe('clip.mp4');
      expect(subject('batch_files', { operation: 'rename', pattern: '*.jpg' })).toBe('*.jpg');
    });

    it('cuts a URL, a query and a title, never a file name', () => {
      const long = 'w'.repeat(80);
      expect(subject('http_request', { method: 'POST', url: `https://api.example.com/${long}` })).toBe(`POST https://api.example.com/${'w'.repeat(20)}…`);
      expect(subject('web_research', { query: long })).toBe(`${'w'.repeat(49)}…`);
      expect(subject('artifact_save', { title: long })).toBe(`${'w'.repeat(49)}…`);
      expect(subject('task_create', { title: long })).toBe(`${'w'.repeat(49)}…`);
      expect(subject('google_docs', { action: 'create', title: long })).toBe(`${'w'.repeat(49)}…`);
      const file = `${'f'.repeat(70)}.csv`;
      expect(subject('edit_file', { path: `/workspace/${file}` })).toBe(file);
      expect(subject('media_process', { input: file })).toBe(file);
      expect(subject('bulk_plan', { target_system: 'workspace', source_file: file })).toBe(file);
      expect(subject('write_file', { path: file })).toBe(file);
      expect(subject('google_drive', { action: 'upload', file_name: file })).toBe(file);
      expect(subject('google_drive', { action: 'create_doc', file_name: long })).toBe(`${'w'.repeat(49)}…`);
      expect(subject('memory_recall', { query: long })).toBe(`${'w'.repeat(49)}…`);
      expect(subject('run_workflow', { name: long })).toBe(`${'w'.repeat(49)}…`);
      expect(subject('data_store_query', { collection: long })).toBe(`${'w'.repeat(49)}…`);
    });

    it('joins a merge as duplicate → canonical, only with both', () => {
      expect(subject('subjects_merge', { duplicate: 'ACME AG', canonical: 'Acme' })).toBe('ACME AG → Acme');
      expect(subject('subjects_merge', { duplicate: 'ACME AG' })).toBe('');
    });

    it('reads the rest from their one field', () => {
      expect(subject('mail_connect', { email: 'shop@example.com', account_id: 'x' })).toBe('shop@example.com');
      expect(subject('inbox_rule_propose', { name: 'Newsletters', matcher_value: 'x' })).toBe('Newsletters');
      expect(subject('recall', { query: 'pricing' })).toBe('pricing');
      expect(subject('archive_search', { query: 'contract' })).toBe('contract');
      expect(subject('memory_delete', { pattern: 'old prices', namespace: 'knowledge' })).toBe('old prices');
      expect(subject('memory_list', { namespace: 'knowledge' })).toBe('');
      expect(subject('data_store_delete', { collection: 'orders', filter: {} })).toBe('orders');
      expect(subject('data_store_drop', { collection: 'orders' })).toBe('orders');
      expect(subject('data_store_create', { name: 'leads' })).toBe('leads');
      expect(subject('contacts_save', { name: 'Anna Muster', email: 'a@example.com' })).toBe('Anna Muster');
      expect(subject('calendar_read', { calendar: 'Team' })).toBe('Team');
      expect(subject('save_workflow', { name: 'Weekly report', workflow_id: 'w1' })).toBe('Weekly report');
    });
  });

  describe('labels that depend on the input', () => {
    const action = (tool: string, input: unknown): string | undefined => toolCallLabel(tool, input, tk)?.action;

    it('batch_files names its operation, and holds without one', () => {
      expect(action('batch_files', { operation: 'rename' })).toBe('tool.files_renamed');
      expect(action('batch_files', { operation: 'move' })).toBe('tool.files_moved');
      expect(action('batch_files', { operation: 'transform' })).toBe('tool.files_text_replaced');
      expect(action('batch_files', undefined)).toBe('tool.files_processed');
    });

    it('memory_focus sets or clears, and holds without input', () => {
      expect(toolCallLabel('memory_focus', { subject: 'Acme' }, tk)).toEqual({ action: 'tool.focus_set', subject: 'Acme' });
      expect(toolCallLabel('memory_focus', {}, tk)).toEqual({ action: 'tool.focus_cleared', subject: '' });
      expect(toolCallLabel('memory_focus', undefined, tk)).toEqual({ action: 'tool.focus', subject: '' });
    });

    it('set_thread_context sets or clears, and holds without input', () => {
      expect(toolCallLabel('set_thread_context', { project: 'Relaunch' }, tk)).toEqual({ action: 'tool.project_set', subject: 'Relaunch' });
      expect(toolCallLabel('set_thread_context', { clear: true, project: 'Relaunch' }, tk)).toEqual({ action: 'tool.project_cleared', subject: '' });
      expect(toolCallLabel('set_thread_context', undefined, tk)).toEqual({ action: 'tool.project', subject: '' });
    });
  });
});
