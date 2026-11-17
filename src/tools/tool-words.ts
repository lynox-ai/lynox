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
 * Only tools that can reach a dialog are listed; the test fails for every built-in tool
 * that can reach a dialog without a word. Any other tool (a plugin's, an MCP server's) is
 * named `Tool "<name>"`: a tool name holds no space or quote, so it can never read as one
 * of these words, whatever it is called.
 */

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

/** A tool this table has a word for. */
export type DialogTool = keyof typeof TOOL_LINE_WORDS | keyof typeof DIALOG_ONLY_WORDS;

/** The dialog's word for `toolName`; a tool without one is named, marked as a name. */
export function dialogToolWord(toolName: string): string {
  const dialogOnly: Readonly<Record<string, string>> = DIALOG_ONLY_WORDS;
  const lineWords: Readonly<Record<string, string>> = TOOL_LINE_WORDS;
  if (Object.hasOwn(dialogOnly, toolName)) return dialogOnly[toolName]!;
  if (Object.hasOwn(lineWords, toolName)) return lineWords[toolName]!;
  return `Tool "${toolName}"`;
}

/**
 * A tool's dialog word as FRAME, for a `pv` prompt, where a plain `${…}` would be a value.
 * It takes a tool from this table, never free text: nothing else can be spliced in as frame.
 */
export function toolWordFrame(tool: DialogTool): PromptText {
  return { [PROMPT_TEXT_BRAND]: true, segments: [{ kind: 'frame', text: dialogToolWord(tool) }] };
}
