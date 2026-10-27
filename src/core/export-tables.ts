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

const T: ExportTable = {};
const OPERATING = 'operating state of this installation, not customer content';
const MARKER = 'a migration or backfill marker';
const ACCESS = 'access control and credential bookkeeping';

export const EXPORT_TABLES: Readonly<Record<ExportedStore, ExportTableList>> = {
  'engine.db': {
    include: {
      threads: T,
      thread_messages: T,
      knowledge_entries: { encrypted: ['text'] },
      entry_sources: { encrypted: ['text'] },
      memories: { encrypted: ['text'] },
      memory_blocks: { encrypted: ['content'] },
      memory_subjects: T,
      subjects: T,
      subject_mints: T,
      subject_cooccurrences: T,
      people: { encrypted: ['email', 'phone'] },
      organizations: { encrypted: ['vat_id'] },
      relationships: T,
      engagements: T,
      products: T,
      services: T,
      artifacts: T,
      tasks: T,
      workflows: { stripJson: { definition_json: ['$.reviewedGrant'] } },
      workflow_grants: { strip: ['checksum'] },
      triggers: T,
      pending_prompts: T,
      approval_entries: { strip: ['checksum', 'dedup_key', 'family_key'], encrypted: ['payload_json', 'result_json'] },
      bulk_runs: { strip: ['rule_hash', 'judge_rule_hash', 'approval_checksum'], encrypted: ['list_source', 'judge_rule'] },
      bulk_targets: { encrypted: ['target_key', 'before', 'after_planned', 'after_actual', 'result'] },
      inbound_events: { encrypted: ['values_json'] },
      audit_log: T,
      connections: { stripJson: { config_json: GRANT_RECORD_PATHS } },
      connection_records: T,
      conflicts: T,
      supersedes: T,
      profile_seeds: T,
      onboarding_flags: T,
    },
    name: {
      connection_grants: ACCESS,
      connection_grant_hosts: ACCESS,
      secret_releases: ACCESS,
      secret_release_requests: ACCESS,
      vault_name_bindings: ACCESS,
      mandate_ends: ACCESS,
      bulk_host_probes: ACCESS,
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
      runs: { encrypted: ['task_text', 'response_text', 'error_text'] },
      run_tool_calls: { encrypted: ['input_json', 'output_json'] },
      run_spawns: T,
      wire_snapshots: { encrypted: ['user_message'] },
      prompt_snapshots: T,
      pipeline_runs: T,
      pipeline_step_results: T,
      processes: T,
      advisor_suggestions: T,
      compaction_events: T,
      pending_prompts: T,
      pre_approval_sets: T,
      pre_approval_events: T,
      conversation_grants: T,
      deleted_threads: T,
      security_events: T,
      threads: T,
      thread_messages: T,
      tasks: T,
      triggers: T,
      scopes: T,
    },
    name: {
      metrics: OPERATING,
      bulk_cost_days: OPERATING,
      active_runs: OPERATING,
      workflow_run_claims: OPERATING,
      tenants: OPERATING,
      model_provenance_backfill_marker: MARKER,
      // history.db's copies of engine.db's `contained` and `exact_marker`, labelled like them.
      contained_threads: MARKER,
      exact_marker_mirror: MARKER,
      schema_version: MARKER,
    },
  },
  'agent-memory.db': {
    include: {
      entities: T,
      relations: T,
      mentions: T,
      memories: T,
      cooccurrences: T,
      supersedes: T,
    },
    name: {
      metrics: OPERATING,
      schema_version: MARKER,
    },
  },
  'mail-state.db': {
    include: {
      inbox_items: T,
      inbox_item_bodies: T,
      inbox_thread_messages: T,
      inbox_rules: T,
      inbox_settings: T,
      mail_followups: T,
      mail_scheduled: T,
      mail_sent_log: T,
      inbox_audit_log: T,
      inbox_user_action_log: T,
      // No credentials: an account's passwords and tokens live in the vault.
      mail_accounts: T,
    },
    name: {
      mail_delta_cursors: 'mail sync state',
      processed_mail_messages: 'mail sync state',
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
