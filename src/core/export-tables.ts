/**
 * Table by table, what the customer's data export carries out of each SQLite store the
 * inventory marks `export: include` (`data-dir-inventory.ts`).
 *
 * WHY A LIST AND A TEST, NOT A QUERY. The export reads the stores by raw SQL from a snapshot,
 * not through the store classes, so nothing else would notice a table it skips. Every table a
 * store creates therefore needs a decision here — included, or named with a reason — and
 * `export-tables.test.ts` holds each store's `sqlite_master` after its migrations against this
 * file: a new table without a decision fails it, and so does a decision for a table that no
 * longer exists.
 *
 * WHAT A DECISION CARRIES.
 *   strip      columns left out of the export: a keyed digest (below) or another value bound
 *              to this instance
 *   stripJson  paths removed from a JSON column before it is written
 *   encrypted  columns stored encrypted; the export decrypts exactly these, strictly, and marks
 *              a value it cannot read instead of writing it out
 *
 * KEYED DIGESTS, ONE RULE. A column that stores a `keyedHash` or `storeBindingDigest` value is
 * bound to this instance's key and verifies a person's approval or a token. It is neither
 * readable content nor safe to hand out, so it is stripped wherever it is stored.
 * `KEYED_COLUMNS` names every such column, and the test fails when one is not stripped or when a
 * file starts computing one that this list does not account for.
 */

export interface ExportTable {
  /** What the table holds, in plain words for the archive's README. REQUIRED: a table without one does not compile. */
  readonly about: string;
  readonly strip?: readonly string[];
  readonly stripJson?: Readonly<Record<string, readonly string[]>>;
  readonly encrypted?: readonly string[];
}

export interface ExportTableList {
  /** Tables carried into the archive. */
  readonly include: Readonly<Record<string, ExportTable>>;
  /** Tables not carried, each with the reason the archive's manifest gives. */
  readonly name: Readonly<Record<string, string>>;
}

/**
 * The grant record's fields the export leaves out, as JSON paths into an API profile: every keyed
 * digest (`fingerprints`, `fingerprint_check`, `store_binding`) and every field the engine itself
 * never hands out (`withoutFingerprints`, which also drops `foreign`). An API profile lives as a
 * `connections` row (`config_json`) and, from before the move to engine.db or without it, as
 * `apis/<id>.json`, so the paths apply to both (`DIR_JSON_STRIP`).
 */
export const GRANT_RECORD_PATHS: readonly string[] = [
  '$.oauth_grant.fingerprints',
  '$.oauth_grant.fingerprint_check',
  '$.oauth_grant.foreign',
  '$.oauth_grant.store_binding',
];

/** JSON files in an included directory, and the paths stripped from each before it is written. */
export const DIR_JSON_STRIP: Readonly<Record<string, readonly string[]>> = { apis: GRANT_RECORD_PATHS };

export type ExportedStore = 'engine.db' | 'history.db' | 'agent-memory.db' | 'mail-state.db';

const OPERATING = 'technical counters and locks the software keeps for itself; they hold none of your content';
const MARKER = 'an internal note that a software update has run';
const ACCESS = 'records of which connections and secrets you allowed, and when; they only work on this installation, and the secrets themselves are never exported';

export const EXPORT_TABLES: Readonly<Record<ExportedStore, ExportTableList>> = {
  'engine.db': {
    include: {
      threads: { about: 'your conversations (one row per chat)' },
      bulk_host_probes: { about: 'services you checked by hand before a list job could change many items there' },
      thread_messages: { about: 'the messages of each conversation; content_json holds the text and any attachments' },
      knowledge_entries: { about: 'facts the assistant keeps about your business', encrypted: ['text'] },
      entry_sources: { about: 'where each kept fact came from', encrypted: ['text'] },
      memories: { about: 'notes the assistant remembers', encrypted: ['text'] },
      memory_blocks: { about: 'longer memory texts the assistant keeps per topic', encrypted: ['content'] },
      memory_subjects: { about: 'which memory belongs to which person, company or topic' },
      subjects: { about: 'the people, companies and topics the assistant knows' },
      subject_mints: { about: 'when each person, company or topic was first recorded' },
      subject_cooccurrences: { about: 'which people, companies and topics appear together' },
      people: { about: 'your contacts', encrypted: ['email', 'phone'] },
      organizations: { about: 'the companies in your contacts', encrypted: ['vat_id'] },
      relationships: { about: 'how your contacts relate to each other' },
      engagements: { about: 'your deals and engagements with contacts' },
      products: { about: 'your products' },
      services: { about: 'your services' },
      artifacts: { about: 'documents and pages the assistant made for you' },
      tasks: { about: 'your tasks and to-dos' },
      workflows: { about: 'your saved workflows', stripJson: { definition_json: ['$.reviewedGrant'] } },
      workflow_grants: { about: 'what each saved workflow is allowed to do', strip: ['checksum'] },
      triggers: { about: 'your schedules and automatic triggers' },
      pending_prompts: { about: 'questions the assistant asked you and is waiting on' },
      approval_entries: { about: 'actions that waited for your approval, and your answers', strip: ['checksum', 'dedup_key', 'family_key'], encrypted: ['payload_json', 'result_json'] },
      bulk_runs: { about: 'list jobs the assistant ran over many items', strip: ['rule_hash', 'judge_rule_hash', 'approval_checksum'], encrypted: ['list_source', 'judge_rule', 'start_domains'] },
      bulk_targets: { about: 'each item of a list job and what was changed', encrypted: ['target_key', 'before', 'after_planned', 'after_actual', 'result', 'context'] },
      inbound_events: { about: 'events other services sent to this installation', encrypted: ['values_json'] },
      audit_log: { about: 'a log of what the assistant changed, and when' },
      connections: { about: 'the services you connected (without their passwords or keys)', stripJson: { config_json: GRANT_RECORD_PATHS } },
      connection_records: { about: 'records read from connected services' },
      conflicts: { about: 'facts that contradicted each other, and how they were settled' },
      supersedes: { about: 'which fact replaced an older one' },
      profile_seeds: { about: 'the starting profile of your business' },
      onboarding_flags: { about: 'which setup steps you completed' },
    },
    name: {
      connection_grants: ACCESS,
      connection_grant_hosts: ACCESS,
      secret_releases: ACCESS,
      secret_release_requests: ACCESS,
      vault_name_bindings: ACCESS,
      mandate_ends: ACCESS,
      // Each row names an end in `mandate_ends`, which stays here too: on another instance no
      // warning was sent, and a pause there says so.
      plan_advance_warnings: OPERATING,
      contained: MARKER,
      exact_marker: MARKER,
      verb_backfill_marker: MARKER,
      vault_name_binding_migration: MARKER,
      profile_seed_backfill: MARKER,
      schema_version: MARKER,
    },
  },
  'history.db': {
    include: {
      runs: { about: 'every assistant run: your request, the answer, cost and time', encrypted: ['task_text', 'response_text', 'error_text'] },
      run_tool_calls: { about: 'each tool the assistant used in a run, with its input and output', encrypted: ['input_json', 'output_json'] },
      run_spawns: { about: 'helper assistants a run started' },
      wire_snapshots: { about: 'the message a run started from', encrypted: ['user_message'] },
      prompt_snapshots: { about: 'which instructions a run was given (as a fingerprint)' },
      pipeline_runs: { about: 'multi-step jobs' },
      pipeline_step_results: { about: 'the result of each step of a multi-step job' },
      processes: { about: 'saved processes the assistant learned' },
      advisor_suggestions: { about: 'suggestions the assistant made' },
      compaction_events: { about: 'when a long conversation was summarised' },
      pending_prompts: { about: 'older copy: questions waiting on you' },
      pre_approval_sets: { about: 'actions you approved in advance' },
      pre_approval_events: { about: 'when an approval given in advance was used' },
      conversation_grants: { about: 'permissions you gave within a conversation' },
      tenants: { about: 'separate budgets an older version of the software could set up; current versions no longer write here' },
      deleted_threads: { about: 'which conversations were deleted, and when' },
      security_events: { about: 'security checks that stopped or flagged something' },
      threads: { about: 'older copy of your conversations, from before a software update' },
      thread_messages: { about: 'older copy of conversation messages, from before a software update' },
      tasks: { about: 'older copy of your tasks' },
      triggers: { about: 'older copy of your schedules' },
      scopes: { about: 'older copy of memory areas' },
    },
    name: {
      metrics: OPERATING,
      bulk_cost_days: OPERATING,
      active_runs: OPERATING,
      workflow_run_claims: OPERATING,
      model_provenance_backfill_marker: MARKER,
      // history.db's copies of engine.db's `contained` and `exact_marker`, labelled like them.
      contained_threads: MARKER,
      exact_marker_mirror: MARKER,
      schema_version: MARKER,
    },
  },
  'agent-memory.db': {
    include: {
      entities: { about: 'people, companies and things in the knowledge graph' },
      relations: { about: 'how they are connected' },
      mentions: { about: 'where each one was mentioned' },
      memories: { about: 'remembered facts in the knowledge graph' },
      cooccurrences: { about: 'which ones appear together' },
      supersedes: { about: 'which fact replaced an older one' },
    },
    name: {
      metrics: OPERATING,
      schema_version: MARKER,
    },
  },
  'mail-state.db': {
    include: {
      inbox_items: { about: 'the mails in your inbox and how they were sorted' },
      inbox_item_bodies: { about: 'the text of those mails' },
      inbox_thread_messages: { about: 'the mails of each mail thread' },
      inbox_rules: { about: 'your rules for sorting mail' },
      inbox_settings: { about: 'your inbox settings' },
      mail_followups: { about: 'mails you wanted a reminder about' },
      mail_scheduled: { about: 'mails scheduled to be sent later' },
      mail_sent_log: { about: 'mails that were sent' },
      inbox_audit_log: { about: 'a log of what happened to each mail' },
      inbox_user_action_log: { about: 'what you did with each mail' },
      // No credentials: an account's passwords and tokens live in the vault.
      mail_accounts: { about: 'your mail accounts (without passwords)' },
      // Mails the inbox put aside, waiting to be sorted: their envelopes (sender, subject) are
      // the customer's correspondence, so they are carried, not named.
      mail_deferred: { about: 'mails put aside, waiting to be sorted' },
    },
    name: {
      mail_delta_cursors: 'where the last mailbox sync stopped; it holds no mail',
      processed_mail_messages: 'which mails were already sorted, by their message id; the mails themselves are in inbox_items',
      schema_version: MARKER,
    },
  },
};

/**
 * `datastore.db` is included by RULE, not by list: its tables are created per collection.
 * Carried are the registry and every `ds_<name>` table whose `<name>` has a registry row; a
 * `ds_*` table without its row is an inconsistency the export refuses to guess at.
 */
export const DATASTORE_EXPORT = { registry: 'ds_collections', tablePrefix: 'ds_' } as const;


/** Every stored keyed digest, by where it is stored. */
export const KEYED_COLUMNS: ReadonlyArray<{ readonly store: ExportedStore; readonly table: string; readonly column: string; readonly jsonPath?: string }> = [
  { store: 'engine.db', table: 'approval_entries', column: 'checksum' },
  { store: 'engine.db', table: 'approval_entries', column: 'dedup_key' },
  { store: 'engine.db', table: 'approval_entries', column: 'family_key' },
  { store: 'engine.db', table: 'bulk_runs', column: 'rule_hash' },
  { store: 'engine.db', table: 'bulk_runs', column: 'judge_rule_hash' },
  { store: 'engine.db', table: 'bulk_runs', column: 'approval_checksum' },
  { store: 'engine.db', table: 'workflow_grants', column: 'checksum' },
  { store: 'engine.db', table: 'workflows', column: 'definition_json', jsonPath: '$.reviewedGrant' },
  ...GRANT_RECORD_PATHS.map(jsonPath => ({ store: 'engine.db' as const, table: 'connections', column: 'config_json', jsonPath })),
];
