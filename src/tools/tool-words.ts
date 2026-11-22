/**
 * The word a confirmation dialog names a tool by, in English and German.
 *
 * A dialog asks before a call runs, so it names the tool by a noun. Where the chat's
 * tool line already names the tool by a noun, the dialog takes exactly that word: the
 * web UI's English word for the tool is held equal to this table by a test
 * (`packages/web-ui/src/lib/utils/tool-dialog-words.svelte.test.ts`). The tool line
 * stands after the call and names some tools by a participle ("File read"); those
 * tools get a noun of their own here, listed in `DIALOG_ONLY_WORDS`.
 *
 * Only tools that can reach a dialog are listed; the test fails for every built-in tool
 * that can reach a dialog without a word. Any other tool (a plugin's, an MCP server's) is
 * named `External tool "<name>"`, so it can never read as one of these words, whatever it
 * is called. Nothing guarantees which characters such a name holds, so it is handled as any
 * foreign value is (see `externalToolName`). Every key here is a built-in tool's name, which
 * no plugin can take.
 */

import { singleLine } from '../core/prompt-value.js';
import { QUOTE_MARKS, type DialogLanguage } from './dialog-text.js';
import { PROMPT_TEXT_BRAND, type PromptText } from '../types/agent.js';

/** Tools whose dialog word is the chat's tool-line word, word for word. */
export const TOOL_LINE_WORDS = {
  bash: 'Command',
  http_request: 'API request',
  api_setup: 'API profiles',
  mail_send: 'New email',
  mail_reply: 'Reply to email',
  mail_connect: 'Mailbox connection',
  google_calendar: 'Calendar',
  google_docs: 'Google Docs',
  google_drive: 'Google Drive',
  google_sheets: 'Google Sheets',
  artifact_delete: 'Artifact deletion',
  data_store_delete: 'Row deletion',
  data_store_drop: 'Table deletion',
  memory_block_edit: 'Knowledge edit',
  memory_retire: 'Knowledge retirement',
  memory_delete: 'Knowledge deletion',
  memory_promote: 'Knowledge promotion',
  subjects_merge: 'Merge',
  update_workflow_steps: 'Workflow edit',
} as const satisfies Record<string, string>;

/** Tools the tool line names by a participle; the dialog names them by these nouns. */
export const DIALOG_ONLY_WORDS = {
  read_file: 'File access',
  write_file: 'File write',
  edit_file: 'File edit',
  batch_files: 'Bulk file change',
  spawn_agent: 'Delegation',
} as const satisfies Record<string, string>;

/**
 * The German words, for the same tools. Where the tool line names a tool by a noun, this is
 * the web UI's German tool-line word, held equal by the same test.
 */
export const TOOL_LINE_WORDS_DE = {
  bash: 'Befehl',
  http_request: 'API-Anfrage',
  api_setup: 'API-Profile',
  mail_send: 'Neue Mail',
  mail_reply: 'Antwort auf Mail',
  mail_connect: 'Postfach-Verbindung',
  google_calendar: 'Kalender',
  google_docs: 'Google Docs',
  google_drive: 'Google Drive',
  google_sheets: 'Google Sheets',
  artifact_delete: 'Artifact-Löschung',
  data_store_delete: 'Zeilen-Löschung',
  data_store_drop: 'Tabellen-Löschung',
  memory_block_edit: 'Wissens-Änderung',
  memory_retire: 'Wissens-Rückzug',
  memory_delete: 'Wissens-Löschung',
  memory_promote: 'Wissens-Hochstufung',
  subjects_merge: 'Zusammenführung',
  update_workflow_steps: 'Workflow-Änderung',
} as const satisfies Record<keyof typeof TOOL_LINE_WORDS, string>;

/** The German dialog-only nouns. */
export const DIALOG_ONLY_WORDS_DE = {
  read_file: 'Dateizugriff',
  write_file: 'Datei schreiben',
  edit_file: 'Datei bearbeiten',
  batch_files: 'Mehrere Dateien ändern',
  spawn_agent: 'Delegation',
} as const satisfies Record<keyof typeof DIALOG_ONLY_WORDS, string>;

/** How a dialog names a tool without a word, around its name. */
const EXTERNAL_TOOL: Readonly<Record<DialogLanguage, string>> = { en: 'External tool', de: 'Externes Werkzeug' };

/** A tool this table has a word for. */
export type DialogTool = keyof typeof TOOL_LINE_WORDS | keyof typeof DIALOG_ONLY_WORDS;

/** The longest a foreign tool's name is shown in a dialog, "…" included. */
const EXTERNAL_NAME_MAX = 64;

/**
 * A foreign tool's name as a dialog shows it: on one line, without control or bidi
 * characters, at most 64 characters with "…", and with `\` and every quotation mark escaped, so
 * the marks around it are the dialog's own.
 */
function externalToolName(toolName: string): string {
  const chars = Array.from(singleLine(toolName).trim());
  const shown = chars.length > EXTERNAL_NAME_MAX ? `${chars.slice(0, EXTERNAL_NAME_MAX - 1).join('')}…` : chars.join('');
  return shown.replace(/[\\"“”„]/g, (c) => `\\${c}`);
}

/**
 * The dialog's word for `toolName` as plain text (the warning, the audit); a tool without one
 * is named as an external tool. A dialog shows it through {@link dialogToolHead}.
 */
export function dialogToolWord(toolName: string, language: DialogLanguage = 'en'): string {
  const word = tableWord(toolName, language);
  return word ?? `${EXTERNAL_TOOL[language]} "${externalToolName(toolName)}"`;
}

/** The table's word for `toolName` in `language`, or null for a tool without one. */
function tableWord(toolName: string, language: DialogLanguage): string | null {
  const dialogOnly: Readonly<Record<string, string>> = language === 'de' ? DIALOG_ONLY_WORDS_DE : DIALOG_ONLY_WORDS;
  const lineWords: Readonly<Record<string, string>> = language === 'de' ? TOOL_LINE_WORDS_DE : TOOL_LINE_WORDS;
  if (Object.hasOwn(dialogOnly, toolName)) return dialogOnly[toolName]!;
  if (Object.hasOwn(lineWords, toolName)) return lineWords[toolName]!;
  return null;
}

/**
 * The dialog's word for `toolName` as a prompt: a word of the table is the engine's own text
 * (frame); an external tool's name is a VALUE between the frame's quotes, so nothing in it can
 * shape the dialog, whatever characters it holds.
 */
export function dialogToolHead(toolName: string, language: DialogLanguage = 'en'): PromptText {
  const word = tableWord(toolName, language);
  if (word !== null) return { [PROMPT_TEXT_BRAND]: true, segments: [{ kind: 'frame', text: word }] };
  return {
    [PROMPT_TEXT_BRAND]: true,
    segments: [
      { kind: 'frame', text: `${EXTERNAL_TOOL[language]} ${QUOTE_MARKS[language][0]}` },
      { kind: 'value', text: externalToolName(toolName) },
      { kind: 'frame', text: QUOTE_MARKS[language][1] },
    ],
  };
}

/**
 * A tool's dialog word as FRAME, for a `pv` prompt, where a plain `${…}` would be a value.
 * It takes a tool from this table, never free text: nothing else can be spliced in as frame.
 */
export function toolWordFrame(tool: DialogTool, language: DialogLanguage = 'en'): PromptText {
  return { [PROMPT_TEXT_BRAND]: true, segments: [{ kind: 'frame', text: dialogToolWord(tool, language) }] };
}
