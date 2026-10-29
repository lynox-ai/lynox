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
 * Every tool the engine itself registers that a mandate's turn keeps, apart from the pattern
 * writers the lock still holds back (`MANDATE_PATTERN_WRITE_TOOLS`). Each one works on the
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
  // network, behind the engine's network policy. Not the provider's own `web_search`: it
  // searches at the provider, where no row can be written before it runs.
  'http_request', 'api_setup', 'web_research',
  // schedules and workflows (a mandate's writes wait for the owner's stamp, §3.12)
  'task_create', 'task_update', 'task_list', 'plan_task', 'run_workflow', 'save_workflow',
  'update_workflow_steps', 'import_workflow', 'export_workflow', 'diagnose_workflow_run',
  'bulk_plan', 'bulk_status',
  // children: they inherit this lock through the parent's tool set
  'spawn_agent',
  // memory
  'remember', 'recall', 'memory_block_edit', 'memory_retire', 'archive_search',
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
 * The tools on `MANDATE_TOOL_SURFACE` that read outside the instance (PRD
 * customer-granted-operator-access §3.9: what happens through the access is in the trail, a
 * read included). Each declares `outwardRead`, and a mandate's call leaves a `read` row
 * before it runs. Every other tool on the surface works inside the instance, or reaches
 * outside only through the tools a child agent or a workflow step calls, which are recorded
 * there. A test over a booted registry holds both halves to the tools themselves.
 */
export const MANDATE_OUTWARD_READERS: ReadonlySet<string> = new Set([
  'http_request', 'api_setup', 'web_research',
  'mail_read', 'mail_search', 'mail_triage', 'mail_reply',
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
  memory_focus: 'sets the knowledge focus for every session of the instance',
});

/**
 * The write sites of the tools placed in `MANDATE_INSIDE_WRITERS`, as `'<tool>#<branch>'`. Each
 * one is the `site` of exactly one `withInstanceWrite` call in the engine's source, and that
 * call writes the `attempt` row before the block's first change (`instance-trail.ts`). A
 * source scan holds both directions: a label without its call and a call without its label.
 * The type makes a label that is not listed fail to compile. Every tool with a site is in
 * `MANDATE_INSIDE_WRITERS`, and each of them has at least one site.
 */
export const TOOL_WRITE_SITES = [
  'remember#create', 'memory_block_edit#change', 'memory_retire#change',
  'memory_store#create', 'memory_delete#delete', 'memory_update#exact', 'memory_update#fallback',
  'memory_promote#move', 'subjects_merge#change',
  'data_store_create#create', 'data_store_insert#save', 'data_store_delete#delete', 'data_store_drop#delete',
  'contacts_save#save',
  'artifact_save#save', 'artifact_delete#delete', 'artifact_restore#change',
  'media_process#anchored', 'media_process#unanchored',
  'set_thread_context#clear', 'set_thread_context#set',
  'task_create#workflow', 'task_create#scheduled', 'task_create#watch', 'task_create#one-shot', 'task_create#todo',
  'task_update#change', 'plan_task#create',
  'save_workflow#copy', 'save_workflow#session', 'update_workflow_steps#change', 'import_workflow#create',
  'api_setup#refine', 'api_setup#save', 'api_setup#delete',
] as const;

/**
 * The write sites no tool call owns (660a-3), as `'<kind>#<what>'`: entries the engine writes after
 * or beside a mandate's act, under that mandate, through `withInstanceWriteAs` with the actor
 * captured as a value. `capture#…` writes at the end of a turn, unasked (`auto=1`); `derived#…`
 * is what a subscriber or a write left running derives from an act whose own row names it
 * (`ref=`). Each is the `site` of exactly one such call, held by the same source scan; their
 * fixtures live with their tests (`instance-trail-derived.test.ts`, `capture-trail.test.ts`), not
 * with the tool dispatch's.
 */
export const DERIVED_WRITE_SITES = [
  'capture#durable', 'capture#extract', 'derived#memory', 'derived#memory_update',
] as const;

/** Every write site inside the instance: a tool's, then a derived one's. */
export const INSTANCE_WRITE_SITES = [...TOOL_WRITE_SITES, ...DERIVED_WRITE_SITES] as const;

export type InstanceWriteSite = typeof INSTANCE_WRITE_SITES[number];

/**
 * The tools on `MANDATE_TOOL_SURFACE` placed as writers inside the instance. Each has at least
 * one entry in `INSTANCE_WRITE_SITES`. Together with `MANDATE_INSIDE_NON_WRITERS` this places
 * every tool on the surface exactly once, checked against a booted registry.
 */
export const MANDATE_INSIDE_WRITERS: ReadonlySet<string> = new Set([
  'remember', 'memory_block_edit', 'memory_retire', 'memory_store', 'memory_delete', 'memory_update',
  'memory_promote', 'subjects_merge',
  'data_store_create', 'data_store_insert', 'data_store_delete', 'data_store_drop', 'contacts_save',
  'artifact_save', 'artifact_delete', 'artifact_restore', 'media_process', 'set_thread_context',
  'task_create', 'task_update', 'plan_task', 'save_workflow', 'update_workflow_steps', 'import_workflow',
  'api_setup',
]);

/**
 * The tools on `MANDATE_TOOL_SURFACE` placed as non-writers, each with the reason for its place.
 */
export const MANDATE_INSIDE_NON_WRITERS: Readonly<Record<string, string>> = Object.freeze({
  ask_user: 'asks a question; the prompt row is the question, not an entry',
  ask_secret: 'asks for a secret; the vault write behind it is the owner\'s route, refused for a mandate',
  suggest_follow_ups: 'shows suggestions, writes nothing',
  recall_tool_result: 'reads a stored tool result',
  http_request: 'writes outside the instance, recorded by the outward trail; a due renewal runs api_setup fetch_token, which records its own pair',
  web_research: 'reads outside, recorded as a read',
  task_list: 'reads tasks',
  run_workflow: 'its steps record their own calls; its run bookkeeping is not an entry',
  export_workflow: 'reads a workflow',
  diagnose_workflow_run: 'reads a run',
  bulk_plan: 'writes a preview to the bulk ledger; a preview is not an entry',
  bulk_status: 'reads a bulk run',
  spawn_agent: 'its children record their own calls',
  recall: 'reads knowledge',
  archive_search: 'reads the archive; the retrieval counter is bookkeeping',
  memory_recall: 'reads memory',
  memory_list: 'reads memory',
  data_store_query: 'reads a table',
  data_store_list: 'reads the table list',
  contacts_search: 'reads contacts',
  artifact_list: 'reads artifacts; the index reconcile is bookkeeping',
  artifact_history: 'reads an artifact\'s versions; the index reconcile is bookkeeping',
  mail_read: 'reads mail, recorded as a read',
  mail_search: 'reads mail, recorded as a read',
  mail_triage: 'reads mail, recorded as a read',
  mail_send: 'writes outside, recorded by the outward trail',
  mail_reply: 'writes outside, recorded by the outward trail',
  mail_connect: 'asks for a connection; the account write is the owner\'s route, refused for a mandate',
  google_calendar: 'reads and writes outside, recorded by the outward trail',
  google_docs: 'reads and writes outside, recorded by the outward trail',
  google_drive: 'reads and writes outside, recorded by the outward trail',
  google_sheets: 'reads and writes outside, recorded by the outward trail',
  calendar_read: 'reads a feed outside, recorded as a read',
});

/**
 * The tools on `MANDATE_TOOL_SURFACE` that the lock still holds back, each with the reason.
 * They change memory by a pattern the model writes, so a trail row cannot name what they hit.
 * The engine registers them only beside the legacy memory (`legacyMemoryReason`), and the
 * sign-in refuses a mandate on such an engine — but a mandate's plan runs later under the
 * mandate, outside any sign-in, so the lock is where they are kept from it. They stay on the
 * surface and among the writers: their write sites are real, and the owner calls them.
 */
export const MANDATE_PATTERN_WRITE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  memory_delete: 'deletes memory by a pattern, and what it hits cannot be recorded',
  memory_update: 'changes memory by a pattern, and what it hits cannot be recorded',
  memory_promote: 'moves memory by a pattern, and what it hits cannot be recorded',
});

/** What a mandate's turn may use: the surface without the pattern writers. */
const MANDATE_TURN_TOOLS: ReadonlySet<string> = new Set(
  [...MANDATE_TOOL_SURFACE].filter(n => !Object.hasOwn(MANDATE_PATTERN_WRITE_TOOLS, n)),
);

/**
 * The lock for a principal: the set of tool names its turn may use, or `null` when nothing
 * is locked (the owner). Every agent turn applies it on top of the user's disabled tools.
 */
export function toolLockFor(principal: RequestPrincipal): ReadonlySet<string> | null {
  return principal.kind === 'owner' ? null : MANDATE_TURN_TOOLS;
}
