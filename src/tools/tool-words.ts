/**
 * The word a confirmation dialog names a tool by, in English.
 *
 * A dialog asks before a call runs, so it names the tool by a noun. Where the chat's
 * tool line already names the tool by a noun, the dialog takes exactly that word: the
 * web UI's English word for the tool is held equal to this table by a test
 * (`packages/web-ui/src/lib/utils/tool-dialog-words.svelte.test.ts`). The tool line
 * stands after the call and names some tools by a participle ("File read"); those
 * tools get a noun of their own here, listed in `DIALOG_ONLY_WORDS`.
 *
 * Only tools that can reach a dialog are listed. A tool missing here falls back to
 * its name, and the test fails for every tool that can reach a dialog without a word.
 */

/** Tools whose dialog word is the chat's tool-line word, word for word. */
export const TOOL_LINE_WORDS: Readonly<Record<string, string>> = {
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
};

/** Tools the tool line names by a participle; the dialog names them by these nouns. */
export const DIALOG_ONLY_WORDS: Readonly<Record<string, string>> = {
  read_file: 'File access',
  write_file: 'File write',
  edit_file: 'File edit',
  batch_files: 'Bulk file change',
  spawn_agent: 'Delegation',
};

/** The dialog's word for `toolName`, or the name itself for a tool without one. */
export function dialogToolWord(toolName: string): string {
  if (Object.hasOwn(DIALOG_ONLY_WORDS, toolName)) return DIALOG_ONLY_WORDS[toolName]!;
  if (Object.hasOwn(TOOL_LINE_WORDS, toolName)) return TOOL_LINE_WORDS[toolName]!;
  return toolName;
}
