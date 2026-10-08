/**
 * The tools an agent turn a mandate started may use (PRD customer-granted-operator-access
 * D1, §3.13 "Werkzeugsperre").
 *
 * A person the owner let in sets the instance up; they do not get a shell, and they do not
 * read the files the engine process can read (`~/.lynox`, the process filesystem). The lock
 * follows the principal of the REQUEST that started the turn, not the session the turn runs
 * in: an owner and a mandate can drive the same session one after the other.
 *
 * An ALLOWLIST, not a list of what is withheld. A plugin tool is arbitrary code, and so is
 * whatever a later integration registers; a list of exclusions would hand each of them to a
 * mandate the day it appears. A tool reaches a mandate only once it is named here, so a new
 * tool is off for mandates until someone decides otherwise.
 *
 * The lock removes tools; it does not ask. An interactive turn only prompts before
 * `read_file` touches a sensitive path, and a mandate answers its own session's prompts, so
 * a prompt would be no lock at all.
 */
import type { RequestPrincipal } from './request-principal.js';

/**
 * Every tool the engine itself registers that a mandate's turn keeps. Each one works on the
 * engine's own stores, the file area (`media_process` resolves its paths there), or the
 * network behind its gates. The agent also refuses a mandate's turn the provider keys and
 * infrastructure secrets as `secret:` references (`Agent._executeOneInner`).
 * `spawn_agent` and `run_workflow` stay because every agent they build — a spawned child, a
 * workflow step — is built for the parent's principal, so the lock applies to it by tool
 * name, whatever list it was handed.
 */
export const MANDATE_TOOL_SURFACE: ReadonlySet<string> = new Set([
  // conversation
  'ask_user', 'ask_secret', 'suggest_follow_ups', 'recall_tool_result', 'set_thread_context',
  // network, behind the engine's network policy
  'http_request', 'api_setup', 'web_research', 'web_search',
  // schedules and workflows (a mandate's writes wait for the owner's stamp, §3.12)
  'task_create', 'task_update', 'task_list', 'plan_task', 'run_workflow', 'save_workflow',
  'update_workflow_steps', 'import_workflow', 'export_workflow', 'diagnose_workflow_run',
  'score_results', 'bulk_plan', 'bulk_status',
  // children: they inherit this lock through the parent's tool set
  'spawn_agent',
  // memory
  'remember', 'recall', 'memory_block_edit', 'memory_retire', 'memory_focus', 'archive_search',
  'memory_store', 'memory_recall', 'memory_delete', 'memory_update', 'memory_list',
  'memory_promote', 'subjects_merge',
  // stores
  'data_store_create', 'data_store_insert', 'data_store_query', 'data_store_list',
  'data_store_delete', 'data_store_drop', 'contacts_save', 'contacts_search',
  'artifact_save', 'artifact_list', 'artifact_delete', 'artifact_history', 'artifact_restore',
  'media_process',
  // integrations the owner connected
  'mail_read', 'mail_search', 'mail_triage', 'mail_send', 'mail_reply', 'mail_connect',
  'google_calendar', 'google_docs', 'google_drive', 'google_sheets', 'calendar_read',
]);

/**
 * The engine's own tools a mandate's turn does not get, each with the reason. Together with
 * `MANDATE_TOOL_SURFACE` this is the closed classification a booted registry is checked
 * against: a new engine tool that is in neither fails that test until someone places it.
 */
export const MANDATE_WITHHELD_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  bash: 'a shell in the engine process',
  read_file: 'opens any absolute path outside a workspace',
  write_file: 'writes any absolute path outside a workspace',
  edit_file: 'edits any absolute path outside a workspace',
  batch_files: 'reads and writes files like read_file and write_file',
});

/**
 * The lock for a principal: the set of tool names its turn may use, or `null` when nothing
 * is locked (the owner). Every agent turn applies it on top of the user's disabled tools.
 */
export function toolLockFor(principal: RequestPrincipal): ReadonlySet<string> | null {
  return principal.kind === 'owner' ? null : MANDATE_TOOL_SURFACE;
}
