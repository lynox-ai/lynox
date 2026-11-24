import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HIDDEN_TOOLS, toolCallLabel } from './tool-call-label.js';
import { getLocale, setLocale, t } from '../i18n.svelte.js';

// The chat's tool line names every tool by a word, in German and in English, never by its raw name.

const before = getLocale();
afterEach(() => setLocale(before));

/** [tool, input, German, English] — the word each tool's line reads. */
const WORDS: ReadonlyArray<readonly [string, unknown, string, string]> = [
  ['mail_read', {}, 'Mail gelesen', 'Email read'],
  ['mail_search', {}, 'Mails durchsucht', 'Emails searched'],
  ['mail_reply', {}, 'Antwort auf Mail', 'Reply to email'],
  ['mail_send', {}, 'Neue Mail', 'New email'],
  ['mail_triage', {}, 'Posteingang gesichtet', 'Inbox triaged'],
  ['mail_connect', {}, 'Postfach-Verbindung', 'Mailbox connection'],
  ['inbox_read', {}, 'Inbox gelesen', 'Inbox read'],
  ['inbox_rule_propose', {}, 'Inbox-Regel vorgeschlagen', 'Inbox rule proposed'],
  ['bulk_plan', {}, 'Massenlauf geplant', 'Bulk run planned'],
  ['bulk_status', {}, 'Stand des Massenlaufs', 'Bulk run status'],
  ['remember', {}, 'Gemerkt', 'Remembered'],
  ['recall', {}, 'Wissen abgerufen', 'Knowledge recalled'],
  ['archive_search', {}, 'Archiv durchsucht', 'Archive searched'],
  ['artifact_delete', {}, 'Artifact-Löschung', 'Artifact deletion'],
  ['artifact_history', {}, 'Versionen angesehen', 'Versions viewed'],
  ['artifact_restore', {}, 'Version wiederhergestellt', 'Version restored'],
  ['ask_secret', {}, 'Zugangsdaten', 'Credentials'],
  ['batch_files', { operation: 'rename' }, 'Dateien umbenannt', 'Files renamed'],
  ['batch_files', { operation: 'move' }, 'Dateien verschoben', 'Files moved'],
  ['batch_files', { operation: 'transform' }, 'Text in Dateien ersetzt', 'Text replaced in files'],
  ['batch_files', undefined, 'Dateien bearbeitet', 'Files processed'],
  ['calendar_read', {}, 'Kalender gelesen', 'Calendar read'],
  ['contacts_save', {}, 'Kontakt gespeichert', 'Contact saved'],
  ['contacts_search', {}, 'Kontakte durchsucht', 'Contacts searched'],
  ['data_store_delete', {}, 'Zeilen-Löschung', 'Row deletion'],
  ['data_store_drop', {}, 'Tabellen-Löschung', 'Table deletion'],
  ['diagnose_workflow_run', {}, 'Workflow-Lauf geprüft', 'Workflow run checked'],
  ['edit_file', {}, 'Datei geändert', 'File edited'],
  ['export_workflow', {}, 'Workflow exportiert', 'Workflow exported'],
  ['google_docs', {}, 'Google Docs', 'Google Docs'],
  ['google_drive', {}, 'Google Drive', 'Google Drive'],
  ['google_sheets', {}, 'Google Sheets', 'Google Sheets'],
  ['import_workflow', {}, 'Workflow importiert', 'Workflow imported'],
  ['media_process', {}, 'Medien verarbeitet', 'Media processed'],
  ['memory_block_edit', {}, 'Wissens-Änderung', 'Knowledge edit'],
  ['memory_delete', {}, 'Wissens-Löschung', 'Knowledge deletion'],
  ['memory_focus', { subject: 'Acme' }, 'Fokus gesetzt', 'Focus set'],
  ['memory_focus', {}, 'Fokus aufgehoben', 'Focus cleared'],
  ['memory_focus', undefined, 'Fokus', 'Focus'],
  ['memory_list', {}, 'Wissen durchgesehen', 'Knowledge browsed'],
  ['memory_promote', {}, 'Wissens-Hochstufung', 'Knowledge promotion'],
  ['memory_retire', {}, 'Wissens-Rückzug', 'Knowledge retirement'],
  ['recall_tool_result', {}, 'Früheres Ergebnis geholt', 'Earlier result fetched'],
  ['save_workflow', {}, 'Workflow gespeichert', 'Workflow saved'],
  ['set_thread_context', { project: 'Relaunch' }, 'Projekt gesetzt', 'Project set'],
  ['set_thread_context', { clear: true }, 'Projekt aufgehoben', 'Project cleared'],
  ['set_thread_context', undefined, 'Projekt', 'Project'],
  ['subjects_merge', {}, 'Zusammenführung', 'Merge'],
  ['task_list', {}, 'Aufgaben angesehen', 'Tasks listed'],
  ['task_update', {}, 'Aufgabe aktualisiert', 'Task updated'],
  ['update_workflow_steps', {}, 'Workflow-Änderung', 'Workflow edit'],
];

describe('the word each tool line reads', () => {
  it.each(WORDS)('%s (%j): %s / %s', (tool, input, de, en) => {
    setLocale('de');
    expect(toolCallLabel(tool, input, t)?.action).toBe(de);
    setLocale('en');
    expect(toolCallLabel(tool, input, t)?.action).toBe(en);
  });

  it('names an inbox zone in the reader\'s language', () => {
    setLocale('de');
    expect(toolCallLabel('inbox_read', { action: 'list', bucket: 'requires_user' }, t)?.subject).toBe('Braucht dich');
    setLocale('en');
    expect(toolCallLabel('inbox_read', { action: 'list', bucket: 'requires_user' }, t)?.subject).toBe('Needs you');
  });
});

/** The tools the engine defines by a literal name, read from its sources: `definition: { name: '…' }`. */
function definedToolNames(): string[] {
  // The test runs from the repo root or from this package; the engine's sources sit at the root.
  let root = process.cwd();
  while (!existsSync(join(root, 'src/tools/builtin')) && dirname(root) !== root) root = dirname(root);
  const names = new Set<string>();
  for (const entry of readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
    for (const m of text.matchAll(/definition:\s*\{\s*name:\s*'([a-z_]+)'/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

/**
 * Tools that still show their raw name. This list may only shrink: a tool that gets a word must
 * leave it, and a new tool without a word fails the check below instead of joining it.
 */
const STILL_RAW: readonly string[] = [];

describe('every tool defined by a literal name', () => {
  const tools = definedToolNames().filter((name) => !HIDDEN_TOOLS.has(name));

  it('finds the engine\'s tools', () => {
    expect(tools.length).toBeGreaterThan(50);
    expect(tools).toEqual(expect.arrayContaining(['mail_send', 'remember', 'bulk_plan', 'api_setup']));
  });

  it.each(['de', 'en'] as const)('reads a word, not its raw name and not empty, with and without input (%s)', (locale) => {
    setLocale(locale);
    const raw: string[] = [];
    for (const name of tools) {
      for (const input of [undefined, {}]) {
        const word = toolCallLabel(name, input, t)?.action ?? '';
        if (word === '' || word === name || /^tool\./.test(word)) raw.push(`${name} (${input === undefined ? 'no input' : '{}'}): "${word}"`);
      }
    }
    expect(raw.filter((line) => !STILL_RAW.some((name) => line.startsWith(`${name} `)))).toEqual([]);
  });

  it('lists only tools that are still raw', () => {
    setLocale('en');
    for (const name of STILL_RAW) expect(toolCallLabel(name, {}, t)?.action).toBe(name);
  });
});
