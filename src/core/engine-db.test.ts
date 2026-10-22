import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { OPEN_IN_FAMILY_SQL } from './bulk-ledger.js';

/**
 * Top up a hand-built fixture with the v1-baseline tables it omitted.
 *
 * Every fixture in this file constructs a partial database at some old version, and every
 * later migration that READS a baseline table then throws on it — v4 needed `memories`, v7
 * needed `subjects`, v11 needs the verb tables. Three rounds of the same edit is the signal:
 * the fixtures encode "what this migration touches", not "what a real db at that version
 * looks like", and a REAL pre-v11 db has all of these (v1 creates them). `IF NOT EXISTS`
 * so a fixture that defines its own richer shape keeps it.
 */
function topUpBaselineTables(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY, kind TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, created_at TEXT);
    CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY);
    -- confirmed_at (v6): every caller of this stub starts at v6 or later, and v20's backfill
    -- reads it. The v2/v5 tests build their own triggers table first, so IF NOT EXISTS skips this.
    CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, source TEXT, effect TEXT, confirmed_at TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY);
    -- v49 adds a column to it and fills that from the grant ledger; v50 sets it again from
    -- created_at and config_json, which every real connections table has had since the baseline.
    CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, kind TEXT, created_at TEXT, config_json TEXT);
  `);
}

describe('EngineDb (Foundation Rework v2 — S0 baseline)', () => {
  const tmpDirs: string[] = [];

  // Default the key to '' so a no-key case is hermetic: without this, EngineDb
  // falls back to the ambient process.env.LYNOX_VAULT_KEY, which a dev/CI shell
  // running the engine often has set — flipping isEncrypted and failing the
  // passthrough assertions. Pass an explicit key for the encryption case.
  function createEngineDb(key = ''): EngineDb {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    return new EngineDb(join(dir, 'engine.db'), key);
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('leaves no deleted value in the bytes of engine.db or its WAL after deleteAllData + scrubFreedPages', () => {
    // The route-level byte scan cannot see engine.db: the values its fixture writes
    // there are encrypted at rest. A plaintext table written through the store's own
    // connection can, and that connection is where `secure_delete` is set.
    const e = createEngineDb();
    const raw = e.getDb();
    raw.exec('CREATE TABLE zz_probe (x TEXT)');
    raw.prepare('INSERT INTO zz_probe (x) VALUES (?)').run('ZZDELETED-engine-7f3a');
    e.scrubFreedPages();
    const path = raw.name;
    expect(readFileSync(path).includes(Buffer.from('ZZDELETED')), 'fixture: the value is in the main file').toBe(true);
    e.deleteAllData();
    e.scrubFreedPages();
    expect(readFileSync(path).includes(Buffer.from('ZZDELETED'))).toBe(false);
    expect(readFileSync(`${path}-wal`).includes(Buffer.from('ZZDELETED'))).toBe(false);
    e.close();
  });

  it('creates the database and stamps the latest schema_version', () => {
    const e = createEngineDb();
    const row = e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(51); // v1 baseline + v2 (idx_triggers_next_run) + v3 (effect) + v4 (idx_memories_created) + v5 (verb_backfill_marker) + v6 (triggers.confirmed_at + grandfather) + v7 (subjects.merged_into) + v8 (memories evidence: source_channel/source_untrusted) + v9 (knowledge_entries + memory_blocks — Durable Knowledge Substrate) + v10 (onboarding_flags — Onboarding Wave 1) + v11 (onboarding backfill for pre-W1 instances) + v12 (triggers.waiting_until — durable wait state) + v13 (bulk_runs + bulk_targets — the bulk-run ledger) + v14 (bulk apply/undo: atomic, kind, claimed_at) + v15 (bulk_targets.after_actual) + v16 (trigger run lease) + v17 (idx_bulk_runs_source) + v18 (bulk_targets.write_sent) + v19 (triggers.created_untrusted) + v20 (triggers.created_by/edited_by/confirmed_by) + v21 (triggers.model_tier) + v22 (audit_log) + v23 (tasks.created_by) + v24 (mandate_ends) + v25 (triggers.consent_reminded_at) + v26 (triggers.last_escalation_at/outcome) + v27 (secret_release_requests + secret_releases) + v28 (knowledge_entries.source_thread_deleted_at) + v29 (entry_sources + profile_seeds) + v30 (subject_mints) + v31 (bulk_runs.principal/mandate_id) + v32 (bulk_runs list_* — a GET list as a bulk source) + v33 (connection_grants — the grant ledger) + v34 (audit_log.recorded_at) + v35 (bulk_runs.cost_usd/cost_cap_usd — model spend of a bulk run) + v36 (judge_rule/judge_rule_hash/judge_started_at, judged_at/judge_claimed_at/judge_claim_token — the per-target judge) + v37 (workflow_grants — one row per accepted workflow grant) + v38 (exact_marker — the engine's own record of the exact clearance) + v39 (bulk_targets.failed_once — a target failed in any pass of its run) + v40 (contained — which containers a store connection was attached for) + v41 (vault_name_bindings + its migration marker) + v42 (connection_grant_hosts) + v43 (bulk_targets/bulk_runs connection and grant) + v44 (triggers.created_mandate_id/mandate_editor/mandate_editor_id) + v45 (workflows authorship + triggers.mandate_edited_at) + v46 (bulk_runs.unsent_tracked + bulk_targets.found_unsent) + v47 (triggers.route_token_hash + inbound_events) + v48 (approval_entries) + v49 (connections.first_grant_id + connection_records) + v50 (first_grant_id set by time) + v51 (triggers.stamp_connections)
    // v5 (B1): the exactly-once boot-backfill marker table is created + seeded done=0.
    const marker = e.getDb().prepare('SELECT done FROM verb_backfill_marker WHERE id = 1').get() as { done: number } | undefined;
    expect(marker?.done).toBe(0);
    expect(e.isVerbBackfillDone()).toBe(false);
    // v2's DDL ran in the same txn as its version stamp: the money-path index exists.
    const idx = e.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_triggers_next_run'",
    ).get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_triggers_next_run');
    // v3 added the `effect` column (fresh install gets it via the migration loop).
    const cols = e.getDb().prepare("SELECT name FROM pragma_table_info('triggers')").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('effect');
    // v4 (S5b): the memory-recall created_at index for the ORDER BY DESC hot path.
    const memIdx = e.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_created'",
    ).get() as { name: string } | undefined;
    expect(memIdx?.name).toBe('idx_memories_created');
    e.close();
  });

  it('v3 migration remaps legacy verbatim task_type → clean (source, effect), EXHAUSTIVELY', () => {
    // The money-critical remap (RU1): every pre-v3 row (which held the legacy
    // task_type VERBATIM in `source`, no `effect` column) must land on an explicit
    // (source, effect) — never lean on the DEFAULT so a missed backup/reminder can't
    // strand at the money-spending default. Build a v2 DB with legacy rows, then let
    // EngineDb apply v3 and assert row-by-row (the unit twin of the staging walk).
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig3-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (2);
      CREATE TABLE triggers (id TEXT PRIMARY KEY, source TEXT NOT NULL, condition_json TEXT NOT NULL DEFAULT '{}', target_workflow_id TEXT);
      -- A real pre-v4 engine.db has the memories table (v1 baseline); the v4 migration
      -- indexes memories(created_at), so the fixture must carry it or v4 fails the open.
      CREATE TABLE memories (id TEXT PRIMARY KEY, created_at TEXT);
      -- v7 (ALTER TABLE subjects ADD merged_into) likewise needs the v1 subjects table to
      -- exist, else the migration throws → _openOrRecreate treats it as corruption + wipes.
      CREATE TABLE subjects (id TEXT PRIMARY KEY);
    `);
    const seed = raw.prepare('INSERT INTO triggers (id, source, condition_json, target_workflow_id) VALUES (?, ?, ?, ?)');
    seed.run('r-backup', 'backup', '{}', null);
    seed.run('r-reminder', 'reminder', '{}', null);
    seed.run('r-pipe-cron', 'pipeline', JSON.stringify({ schedule_cron: '0 9 * * *' }), 'wf-a');
    seed.run('r-pipe-watch', 'pipeline', JSON.stringify({ watch_config: '{"url":"x"}' }), 'wf-b');
    seed.run('r-pipe-bare', 'pipeline', '{}', 'wf-c');
    seed.run('r-watch', 'watch', JSON.stringify({ watch_config: '{"url":"y"}' }), null);
    // The REAL legacy value written by createScheduled is 'scheduled' (NOT 'standard'
    // — that was a phantom the first cut mis-seeded, letting a wrong constant pass CI):
    seed.run('r-sched-cron', 'scheduled', JSON.stringify({ schedule_cron: '0 8 * * *' }), null);
    seed.run('r-sched-bare', 'scheduled', '{}', null);
    seed.run('r-manual', 'manual', '{}', null);
    // A legacy row that bound a workflow WITHOUT source='pipeline' (a raw create) — the
    // migration must still route it to run_workflow (the legacy `|| pipeline_id` guard),
    // NOT run_agent (which would be an autonomous money run of the title):
    seed.run('r-bound-manual', 'manual', '{}', 'wf-d');
    seed.run('r-bound-sched', 'scheduled', JSON.stringify({ schedule_cron: '0 7 * * *' }), 'wf-e');
    // A backup/reminder with a stray target must NOT be flipped to run_workflow by
    // the guard (`AND source NOT IN ('backup','reminder')` on the target-bound UPDATE):
    seed.run('r-backup-bound', 'backup', '{}', 'wf-f');
    seed.run('r-reminder-bound', 'reminder', '{}', 'wf-g');
    seed.run('r-weird', 'zzz-unexpected', '{}', null);   // an unknown value must fail safe
    seed.run('r-corrupt', 'scheduled', 'not-json', null); // malformed condition_json → json_valid guard
    topUpBaselineTables(raw);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const rows = e.getDb().prepare('SELECT id, source, effect FROM triggers').all() as Array<{ id: string; source: string; effect: string }>;
    const byId = Object.fromEntries(rows.map(r => [r.id, { source: r.source, effect: r.effect }]));
    // Money-boundary rows (deterministic — must NEVER become a run_* effect):
    expect(byId['r-backup']).toEqual({ source: 'cron', effect: 'backup' });
    expect(byId['r-reminder']).toEqual({ source: 'cron', effect: 'notify' });
    expect(byId['r-backup-bound']).toEqual({ source: 'cron', effect: 'backup' }); // stray target ignored
    expect(byId['r-reminder-bound']).toEqual({ source: 'cron', effect: 'notify' }); // stray target ignored
    // Workflow rows (run_workflow) — source derived from the condition:
    expect(byId['r-pipe-cron']).toEqual({ source: 'cron', effect: 'run_workflow' });
    expect(byId['r-pipe-watch']).toEqual({ source: 'watch', effect: 'run_workflow' });
    expect(byId['r-pipe-bare']).toEqual({ source: 'manual', effect: 'run_workflow' });
    // Target-bound-but-not-pipeline rows → run_workflow (the `|| pipeline_id` guard):
    expect(byId['r-bound-manual']).toEqual({ source: 'manual', effect: 'run_workflow' });
    expect(byId['r-bound-sched']).toEqual({ source: 'cron', effect: 'run_workflow' });
    // Agent rows (run_agent):
    expect(byId['r-watch']).toEqual({ source: 'watch', effect: 'run_agent' });
    expect(byId['r-sched-cron']).toEqual({ source: 'cron', effect: 'run_agent' });  // 'scheduled' → cron
    expect(byId['r-sched-bare']).toEqual({ source: 'manual', effect: 'run_agent' });
    expect(byId['r-manual']).toEqual({ source: 'manual', effect: 'run_agent' });
    // Unknown source → manual (fires nothing until edited); effect run_agent.
    expect(byId['r-weird']).toEqual({ source: 'manual', effect: 'run_agent' });
    // Malformed condition_json is tolerated by the json_valid guard → manual.
    expect(byId['r-corrupt']).toEqual({ source: 'manual', effect: 'run_agent' });
    // NO row is left on a non-clean source or an empty effect.
    for (const r of rows) {
      expect(['cron', 'watch', 'webhook', 'inbox_event', 'manual']).toContain(r.source);
      expect(['run_workflow', 'run_agent', 'backup', 'notify']).toContain(r.effect);
    }
    e.close();
  });

  it('v6 migration grandfathers pre-existing run_agent triggers (ISO confirmed_at); other effects stay NULL', () => {
    // A pre-v6 engine.db: schema at v5 (the `effect` column from v3 is present, but
    // `confirmed_at` is not). v6 must stamp the EXISTING run_agent rows confirmed (so a
    // deploy never pauses the operator's own live schedules — the FORK-1 grandfather)
    // while leaving deterministic/workflow effects NULL (they aren't gated on it).
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig6-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (5);
      CREATE TABLE triggers (id TEXT PRIMARY KEY, source TEXT NOT NULL, effect TEXT NOT NULL, condition_json TEXT NOT NULL DEFAULT '{}', next_run_at TEXT);
      CREATE TABLE subjects (id TEXT PRIMARY KEY);   -- v7 ALTERs it (see the v3 fixture note)
      CREATE TABLE memories (id TEXT PRIMARY KEY);   -- v8 ALTERs it (adds evidence columns)
    `);
    const seed = raw.prepare('INSERT INTO triggers (id, source, effect) VALUES (?, ?, ?)');
    seed.run('g-agent', 'cron', 'run_agent');
    seed.run('g-workflow', 'cron', 'run_workflow');
    seed.run('g-backup', 'cron', 'backup');
    seed.run('g-notify', 'cron', 'notify');
    topUpBaselineTables(raw);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const rows = e.getDb().prepare('SELECT id, confirmed_at FROM triggers').all() as Array<{ id: string; confirmed_at: string | null }>;
    const byId = Object.fromEntries(rows.map(r => [r.id, r.confirmed_at]));
    // run_agent grandfathered, stamped in the SAME ISO format every other writer uses
    // (toISOString) — not SQLite's space-separated datetime('now').
    expect(byId['g-agent']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(byId['g-workflow']).toBeNull();
    expect(byId['g-backup']).toBeNull();
    expect(byId['g-notify']).toBeNull();
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v44 migration keeps the last mandate that changed a trigger and gives no row a grant it cannot know, once', () => {
    // A v43 database: the current schema with v44's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig44-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 44; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;
      INSERT INTO triggers (id, title, source, effect, created_by, edited_by) VALUES
        ('by-mandate', 't', 'cron', 'run_workflow', 'mandate:eva@kanzlei.example', 'mandate:max@kanzlei.example'),
        ('stamped', 't', 'cron', 'run_workflow', 'mandate:eva@kanzlei.example', 'owner'),
        ('owners', 't', 'cron', 'run_workflow', 'owner', NULL),
        ('look-alike', 't', 'cron', 'run_workflow', NULL, 'MANDATE:eva@kanzlei.example');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const rows = (): unknown[] => e.getDb().prepare('SELECT id, created_mandate_id, mandate_editor, mandate_editor_id FROM triggers ORDER BY id').all();
    expect(rows()).toEqual([
      { id: 'by-mandate', created_mandate_id: null, mandate_editor: 'mandate:max@kanzlei.example', mandate_editor_id: null },
      { id: 'look-alike', created_mandate_id: null, mandate_editor: null, mandate_editor_id: null },
      { id: 'owners', created_mandate_id: null, mandate_editor: null, mandate_editor_id: null },
      { id: 'stamped', created_mandate_id: null, mandate_editor: null, mandate_editor_id: null },
    ]);
    e.getDb().prepare("UPDATE triggers SET mandate_editor_id = 'grant-x' WHERE id = 'by-mandate'").run();
    e.close();
    // A restart does not run it again: the ALTERs would fail on the columns, and the values stay.
    const again = new EngineDb(dbPath, '');
    expect(again.getDb().prepare("SELECT mandate_editor_id FROM triggers WHERE id = 'by-mandate'").get()).toEqual({ mandate_editor_id: 'grant-x' });
    expect((again.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    again.close();
  });

  it('v46 migration marks every existing bulk run as unable to tell an unsent target, and a new run as able', () => {
    // A v45 database: the current schema with v46's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig46-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 46; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;
      INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase) VALUES ('old', 't', 'h', 'http:shop.example', 'restorable', 'writing');
      INSERT INTO bulk_targets (run_id, seq, target_key, change) VALUES ('old', 0, 'k', 'update');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT unsent_tracked FROM bulk_runs').all()).toEqual([{ unsent_tracked: 0 }]);
    expect(e.getDb().prepare('SELECT found_unsent FROM bulk_targets').all()).toEqual([{ found_unsent: 0 }]);
    e.getDb().prepare("INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase) VALUES ('new', 't', 'h', 'http:shop.example', 'restorable', 'planned')").run();
    expect(e.getDb().prepare("SELECT unsent_tracked FROM bulk_runs WHERE id = 'new'").get()).toEqual({ unsent_tracked: 1 });
    e.close();
    // A restart does not run it again: the old run stays unable to tell.
    const again = new EngineDb(dbPath, '');
    expect(again.getDb().prepare('SELECT id, unsent_tracked FROM bulk_runs ORDER BY id').all()).toEqual([{ id: 'new', unsent_tracked: 1 }, { id: 'old', unsent_tracked: 0 }]);
    expect((again.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    again.close();
  });

  it('v43 migration adds an empty connection and grant to every existing bulk run and target, once', () => {
    // A v42 database: the current schema with v43's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig43-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 43; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;
      INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase) VALUES ('r', 't', 'h', 'http:shop.example', 'restorable', 'done');
      INSERT INTO bulk_targets (run_id, seq, target_key, change, write_sent) VALUES ('r', 0, 'k', 'update', 1);
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT read_connection_id, read_grant_id, write_connection_id, write_grant_id, write_sent FROM bulk_targets').all())
      .toEqual([{ read_connection_id: null, read_grant_id: null, write_connection_id: null, write_grant_id: null, write_sent: 1 }]);
    expect(e.getDb().prepare('SELECT first_connection_id, first_grant_id FROM bulk_runs').all()).toEqual([{ first_connection_id: null, first_grant_id: null }]);
    e.getDb().prepare("UPDATE bulk_targets SET write_connection_id = 'shop', write_grant_id = 'g1'").run();
    e.close();
    // A restart does not run it again: the ALTERs would fail on the columns, and the values stay.
    const again = new EngineDb(dbPath, '');
    expect(again.getDb().prepare('SELECT write_connection_id, write_grant_id FROM bulk_targets').get()).toEqual({ write_connection_id: 'shop', write_grant_id: 'g1' });
    expect((again.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    again.close();
  });

  it('v39 migration leaves failed_once unknown on the targets of a run approved before it, and 0 on one never approved', () => {
    // A v38 database: the current schema with v39's column and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig39-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 39; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;
      INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, approved_at) VALUES
        ('planned', 't', 'h', 'workspace', 'restorable', 'planned', NULL),
        ('previewed', 't', 'h', 'workspace', 'restorable', 'previewed', NULL),
        ('writing', 't', 'h', 'workspace', 'restorable', 'writing', '2026-10-01T00:00:00.000Z'),
        ('done', 't', 'h', 'workspace', 'restorable', 'done', '2026-10-01T00:00:00.000Z');
      INSERT INTO bulk_targets (run_id, seq, target_key, change) VALUES
        ('planned', 0, 'k', 'update'), ('previewed', 0, 'k', 'update'), ('writing', 0, 'k', 'update'), ('done', 0, 'k', 'update');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const rows = e.getDb().prepare('SELECT run_id AS id, failed_once AS f FROM bulk_targets ORDER BY run_id').all();
    expect(rows).toEqual([
      { id: 'done', f: null }, { id: 'planned', f: 0 }, { id: 'previewed', f: 0 }, { id: 'writing', f: null },
    ]);
    // A target recorded after the migration starts at 0.
    e.getDb().prepare(`INSERT INTO bulk_targets (run_id, seq, target_key, change) VALUES ('writing', 1, 'k2', 'update')`).run();
    expect(e.getDb().prepare(`SELECT failed_once AS f FROM bulk_targets WHERE run_id = 'writing' AND seq = 1`).get()).toEqual({ f: 0 });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v36 migration leaves every existing run and target without a judge', () => {
    // A v35 database: the current schema with v36's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig36-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 36; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;
      INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase) VALUES ('r1', 'thread-1', 'h', 'workspace', 'restorable', 'done');
      INSERT INTO bulk_targets (run_id, seq, target_key, change) VALUES ('r1', 0, 'k', 'update');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT id, judge_rule, judge_rule_hash, judge_started_at FROM bulk_runs').get())
      .toEqual({ id: 'r1', judge_rule: null, judge_rule_hash: null, judge_started_at: null });
    expect(e.getDb().prepare('SELECT judged_at, judge_claimed_at, judge_claim_token FROM bulk_targets').get())
      .toEqual({ judged_at: null, judge_claimed_at: null, judge_claim_token: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v35 migration adds zero spend and no limit to a populated bulk_runs table', () => {
    // A v34 database: the current schema with v35's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig35-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 35; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events; -- v35 and v36
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;
      INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase) VALUES ('r1', 'thread-1', 'h', 'workspace', 'restorable', 'done');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT id, cost_usd, cost_cap_usd FROM bulk_runs').get())
      .toEqual({ id: 'r1', cost_usd: 0, cost_cap_usd: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v34 migration adds recorded_at to a populated audit_log, empty on the rows from before', () => {
    // A v33 database: the current schema with v34's column and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig34-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 34; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events; -- v34 and v35
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;
      INSERT INTO audit_log (ts, actor_kind, action, phase, correlation_id) VALUES ('2026-10-01T00:00:00.000Z', 'mandate', 'a', 'attempt', 'c-1');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT correlation_id, ts, recorded_at FROM audit_log').get())
      .toEqual({ correlation_id: 'c-1', ts: '2026-10-01T00:00:00.000Z', recorded_at: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v32 migration adds an empty list source and zero progress to a populated bulk_runs table', () => {
    // A v31 database: the current schema with v32's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig32-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 32; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;
      ALTER TABLE bulk_runs DROP COLUMN list_calls;
      ALTER TABLE bulk_runs DROP COLUMN list_page;
      ALTER TABLE bulk_runs DROP COLUMN list_state;
      ALTER TABLE bulk_runs DROP COLUMN list_source;
      INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase) VALUES ('r1', 'thread-1', 'h', 'http:shop.example.com', 'restorable', 'planned');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT id, list_source, list_state, list_page, list_calls, list_bytes FROM bulk_runs').get())
      .toEqual({ id: 'r1', list_source: null, list_state: null, list_page: 0, list_calls: 0, list_bytes: 0 });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v31 migration adds an empty planner to a populated bulk_runs table', () => {
    // A v30 database: the current schema with v31's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig31-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 31; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;
      ALTER TABLE bulk_runs DROP COLUMN list_calls;
      ALTER TABLE bulk_runs DROP COLUMN list_page;
      ALTER TABLE bulk_runs DROP COLUMN list_state;
      ALTER TABLE bulk_runs DROP COLUMN list_source;
      ALTER TABLE bulk_runs DROP COLUMN principal;
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;
      INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase) VALUES ('r1', 'thread-1', 'h', 'workspace', 'none', 'previewed');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT id, created_by, principal, mandate_id FROM bulk_runs').get())
      .toEqual({ id: 'r1', created_by: 'thread-1', principal: null, mandate_id: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v23 migration adds an empty created_by to a populated tasks table', () => {
    // A v22 database: the current schema with v23's column and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig23-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 23; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      INSERT INTO tasks (id, title) VALUES ('k1', 'kept');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    expect(e.getDb().prepare('SELECT id, title, created_by FROM tasks').get()).toEqual({ id: 'k1', title: 'kept', created_by: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v26 migration adds an empty escalation record to a populated triggers table', () => {
    // A v25 database: the current schema with v26's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig26-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 26; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE triggers DROP COLUMN last_escalation_at;
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;
      INSERT INTO triggers (id, title, source, effect, consent_reminded_at) VALUES ('t1', 'kept', 'cron', 'run_workflow', '2026-10-01T00:00:00.000Z');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const row = e.getDb().prepare('SELECT id, title, consent_reminded_at, last_escalation_at, last_escalation_outcome FROM triggers').get();
    expect(row).toEqual({ id: 't1', title: 'kept', consent_reminded_at: '2026-10-01T00:00:00.000Z', last_escalation_at: null, last_escalation_outcome: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v25 migration adds an empty consent_reminded_at to a populated triggers table', () => {
    // A v24 database: the current schema with v25's column and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig25-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 25; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      INSERT INTO triggers (id, title, source, effect) VALUES ('t1', 'kept', 'cron', 'run_agent');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const row = e.getDb().prepare('SELECT id, title, consent_reminded_at FROM triggers').get();
    expect(row).toEqual({ id: 't1', title: 'kept', consent_reminded_at: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v21 migration adds an empty model_tier to a populated triggers table', () => {
    // A v20 database: the current schema with v21's column and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig21-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 21; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;  -- v23
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      ALTER TABLE triggers DROP COLUMN model_tier;
      INSERT INTO triggers (id, title, source, effect) VALUES ('t1', 'kept', 'cron', 'run_agent');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const row = e.getDb().prepare('SELECT id, title, model_tier FROM triggers').get();
    expect(row).toEqual({ id: 't1', title: 'kept', model_tier: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v20 migration records the owner as the stamper of every schedule already stamped, and of no other', () => {
    // A v19 database: the current schema with v20's columns and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig20-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 20; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;  -- v23
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      ALTER TABLE triggers DROP COLUMN model_tier;  -- v21
      ALTER TABLE triggers DROP COLUMN created_by; ALTER TABLE triggers DROP COLUMN edited_by; ALTER TABLE triggers DROP COLUMN confirmed_by;
      INSERT INTO triggers (id, title, source, effect, confirmed_at) VALUES ('stamped', 'a', 'cron', 'run_agent', '2026-06-01T00:00:00.000Z');
      INSERT INTO triggers (id, title, source, effect) VALUES ('unstamped', 'b', 'cron', 'run_agent');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const rows = e.getDb().prepare('SELECT id, created_by, edited_by, confirmed_by FROM triggers ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'stamped', created_by: null, edited_by: null, confirmed_by: 'owner' },
      { id: 'unstamped', created_by: null, edited_by: null, confirmed_by: null },
    ]);
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v19 migration adds an empty created_untrusted to a populated triggers table', () => {
    // A v18 database: the current schema with v19's column and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig19-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 19; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;  -- v23
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      ALTER TABLE triggers DROP COLUMN model_tier;  -- v21
      ALTER TABLE triggers DROP COLUMN created_untrusted;
      ALTER TABLE triggers DROP COLUMN created_by; ALTER TABLE triggers DROP COLUMN edited_by; ALTER TABLE triggers DROP COLUMN confirmed_by;  -- v20
      INSERT INTO triggers (id, title, source, effect) VALUES ('t1', 'kept', 'cron', 'run_workflow');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const row = e.getDb().prepare('SELECT id, title, created_untrusted FROM triggers').get();
    expect(row).toEqual({ id: 't1', title: 'kept', created_untrusted: null });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v18 migration marks a target whose write failed or was redirected as one the write may have reached, and no other', () => {
    // A v17 database: the current schema with v18's column and version taken back out.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig18-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    new EngineDb(dbPath, '').close();
    const raw = new Database(dbPath);
    raw.exec(`
      DELETE FROM schema_version WHERE version >= 18; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;  -- v23
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      ALTER TABLE triggers DROP COLUMN model_tier;  -- v21
      ALTER TABLE bulk_targets DROP COLUMN write_sent;
      ALTER TABLE triggers DROP COLUMN created_untrusted;  -- v19
      ALTER TABLE triggers DROP COLUMN created_by; ALTER TABLE triggers DROP COLUMN edited_by; ALTER TABLE triggers DROP COLUMN confirmed_by;  -- v20
      INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase) VALUES ('r1', 'h', 'http:shop.example.com', 'restorable', 'done');
      INSERT INTO bulk_targets (run_id, seq, target_key, change, error) VALUES ('r1', 0, 'k0', 'update', 'write_failed');
      INSERT INTO bulk_targets (run_id, seq, target_key, change, error) VALUES ('r1', 1, 'k1', 'update', 'conflict');
      INSERT INTO bulk_targets (run_id, seq, target_key, change, applied_at) VALUES ('r1', 2, 'k2', 'update', '2026-10-06T00:00:00.000Z');
      INSERT INTO bulk_targets (run_id, seq, target_key, change, error) VALUES ('r1', 3, 'k3', 'update', 'redirect');
    `);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const rows = e.getDb().prepare('SELECT seq, write_sent FROM bulk_targets ORDER BY seq').all();
    expect(rows).toEqual([{ seq: 0, write_sent: 1 }, { seq: 1, write_sent: 0 }, { seq: 2, write_sent: 0 }, { seq: 3, write_sent: 1 }]);
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v7 migration adds subjects.merged_into (NULL) to existing rows without data loss', () => {
    // The additive redirect column (PR-C dedup). A pre-v7 engine.db carries real
    // subject rows; v7 must ALTER the table in place — existing rows survive with
    // merged_into defaulting NULL, never a corruption-recreate (the partial-fixture
    // trap the v3/v6 fixtures document). Build a v6 DB with a subject, open, assert.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig7-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (6);
      CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE memories (id TEXT PRIMARY KEY);   -- v8 ALTERs it (adds evidence columns)
    `);
    raw.prepare('INSERT INTO subjects (id, name) VALUES (?, ?)').run('s1', 'Dr. Ada Lovelace');
    topUpBaselineTables(raw);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const row = e.getDb().prepare('SELECT id, name, merged_into FROM subjects WHERE id = ?').get('s1') as
      { id: string; name: string; merged_into: string | null };
    expect(row).toEqual({ id: 's1', name: 'Dr. Ada Lovelace', merged_into: null });   // survived, column added NULL
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v8 migration adds the Wave-1 evidence columns to a POPULATED memories table without data loss (§6b GO-cond 3)', () => {
    // The GO-condition proof: exercise v7→v8 against a memories table that ALREADY HAS a
    // row (the prod fleet is populated), not just a fresh/empty one. The pre-existing row
    // must survive and take the v8 defaults (channel NULL, untrusted 0, embedding_model NULL).
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig8-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (7);
      CREATE TABLE subjects (id TEXT PRIMARY KEY, merged_into TEXT);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'agent_inferred'
      );
    `);
    raw.prepare('INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_type) VALUES (?, ?, ?, ?, ?, ?)')
      .run('m-old', 'a fact from before v8', 'knowledge', 'context', 'c1', 'user_asserted');
    topUpBaselineTables(raw);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const row = e.getDb()
      .prepare('SELECT text, source_type, source_channel, source_untrusted, embedding_model FROM memories WHERE id = ?')
      .get('m-old') as { text: string; source_type: string; source_channel: string | null; source_untrusted: number; embedding_model: string | null };
    expect(row).toEqual({
      text: 'a fact from before v8', source_type: 'user_asserted',
      source_channel: null, source_untrusted: 0, embedding_model: null,
    });
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('v9 migration creates the durable-knowledge tables on a POPULATED v8 DB + enforces the H6 pin CHECK', () => {
    // Upgrade proof: exercise v8→v9 against a DB that already has a subjects row (the prod
    // fleet is populated). The pre-existing row must survive and the two new tables land empty.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mig9-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (8);
      CREATE TABLE subjects (id TEXT PRIMARY KEY, kind TEXT, name TEXT, archived_at TEXT, parent_id TEXT, merged_into TEXT, updated_at TEXT DEFAULT '2024-01-01');
      -- v11's backfill predicate reads memories/subjects/knowledge_entries, so a v8 fixture
      -- must carry the v1 memories table or the migration THROWS and the open fails loud —
      -- engine-db.ts:740-748 runs migrations OUTSIDE the corruption catch precisely so a
      -- migration fault is never mistaken for corruption; the file stays intact, the engine
      -- boots with engineDb=null. (Same reason v7 needed the subjects table here: a
      -- hand-built fixture has to keep up with every later migration that reads a baseline
      -- table.)
      CREATE TABLE memories (id TEXT PRIMARY KEY, created_at TEXT);
      CREATE TABLE threads (id TEXT PRIMARY KEY);
    `);
    raw.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s-old','organization','ACME')").run();
    topUpBaselineTables(raw);
    raw.close();

    const e = new EngineDb(dbPath, '');
    const db = e.getDb();
    // Pre-existing subject survived the upgrade.
    expect((db.prepare("SELECT name FROM subjects WHERE id='s-old'").get() as { name: string }).name).toBe('ACME');
    // The two v9 tables exist and are empty.
    expect((db.prepare("SELECT COUNT(*) c FROM knowledge_entries").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM memory_blocks").get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);

    // H6 (pin is a store invariant): an active, trusted row MAY pin.
    expect(() =>
      db.prepare("INSERT INTO knowledge_entries (id, kind, text, pinned, status, source_type) VALUES ('k1','fact','x',1,'active','user_asserted')").run(),
    ).not.toThrow();
    // But a pinned=1 external_unverified / non-active row is REJECTED by the CHECK.
    expect(() =>
      db.prepare("INSERT INTO knowledge_entries (id, kind, text, pinned, status, source_type) VALUES ('k2','fact','x',1,'pending_review','external_unverified')").run(),
    ).toThrow();
    // memory_blocks is restricted to the two stored block ids.
    expect(() =>
      db.prepare("INSERT INTO memory_blocks (id, content, char_limit) VALUES ('focus','x',10)").run(),
    ).toThrow();
    e.close();
  });

  it('fails LOUD on a migration error — never wipes the file as if corrupt', () => {
    // A migration throw must propagate (refuse to boot, keep the file), NOT be
    // mistaken for corruption and routed to rename-aside + recreate — which would
    // silently destroy a reads-ON tenant's real subject-graph data while the engine
    // boots "healthy". Reproduce the exact non-idempotent fault: a v6-stamped DB
    // whose subjects table ALREADY carries v7's merged_into column, so v7's
    // `ALTER … ADD COLUMN merged_into` throws "duplicate column name".
    const dir = mkdtempSync(join(tmpdir(), 'lynox-migfail-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'engine.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (6);
      CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL, merged_into TEXT);
    `);
    raw.prepare('INSERT INTO subjects (id, name) VALUES (?, ?)').run('keep-me', 'Real Data');
    topUpBaselineTables(raw);
    raw.close();

    // The open THROWS (fail loud), rather than silently recreating.
    // The boot's option: the mode in which a mistaken corruption branch would wipe the file.
    expect(() => new EngineDb(dbPath, '', { onCorruption: 'recreate' })).toThrow(/duplicate column name: merged_into/i);
    // No .corrupt-* sidecar was minted — the original file was left in place…
    expect(readdirSync(dir).some(f => f.startsWith('engine.db.corrupt-'))).toBe(false);
    // …and the real row survives, still stamped v6 (the v7 txn rolled back).
    const check = new Database(dbPath);
    expect(check.prepare("SELECT name FROM subjects WHERE id = 'keep-me'").get()).toEqual({ name: 'Real Data' });
    expect((check.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(6);
    check.close();
  });

  it('sets a busy_timeout so a concurrent operator sweep waits instead of throwing SQLITE_BUSY', () => {
    const e = createEngineDb();
    expect(e.getDb().pragma('busy_timeout', { simple: true })).toBe(5000);
    e.close();
  });

  it('creates every baseline table', () => {
    const e = createEngineDb();
    const expected = [
      'subjects', 'people', 'organizations', 'engagements', 'products', 'services',
      'threads', 'thread_messages', 'pending_prompts',
      'memories', 'memory_subjects', 'subject_cooccurrences', 'supersedes', 'relationships',
      'connections', 'artifacts', 'workflows', 'triggers', 'tasks', 'conflicts',
    ];
    const rows = e.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const present = new Set(rows.map(r => r.name));
    for (const t of expected) {
      expect(present.has(t), `table ${t} should exist`).toBe(true);
    }
    e.close();
  });

  it('enforces the canonical-UNIQUE dedup guard (case-insensitive), scoped to non-archived', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1', 'organization', 'Acme Industries')").run();
    // Same lower(name)+kind+owner → rejected by the canonical UNIQUE index.
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s2', 'organization', 'acme industries')").run(),
    ).toThrow(/UNIQUE/i);
    // A different kind is allowed (the unique key is (lower(name), kind, owner)).
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s3', 'product', 'Acme Industries')").run();
    // The guard now also covers product/service (catalogue identity = name): a
    // second same-name product is rejected (case-insensitive).
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s5', 'product', 'acme industries')").run(),
    ).toThrow(/UNIQUE/i);
    // engagement identity is provider×client×period (not name) and 'other' is
    // unstructured, so the guard excludes them: two same-named engagements coexist.
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('e1', 'engagement', 'Website Redesign')").run();
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('e2', 'engagement', 'Website Redesign')").run(),
    ).not.toThrow();
    // Archiving s1 frees the slot (partial index: WHERE archived_at IS NULL).
    db.prepare("UPDATE subjects SET archived_at = datetime('now') WHERE id = 's1'").run();
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s4', 'organization', 'Acme Industries')").run(),
    ).not.toThrow();
    e.close();
  });

  it('cascades on subject delete and SET NULL on memory.subject_id', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('cust', 'organization', 'Globex')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('other', 'organization', 'Other')").run();
    db.prepare("INSERT INTO people (subject_id) VALUES ('cust')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, subject_id) VALUES ('m1','hi','knowledge','global','','cust')").run();
    db.prepare("INSERT INTO memory_subjects (memory_id, subject_id) VALUES ('m1','cust')").run();
    db.prepare("INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES ('r1','cust','other','customer_of')").run();

    db.prepare("DELETE FROM subjects WHERE id = 'cust'").run();

    // CASCADE: detail row, junction row, and edge are gone.
    expect(db.prepare("SELECT COUNT(*) c FROM people WHERE subject_id='cust'").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM memory_subjects WHERE subject_id='cust'").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM relationships WHERE id='r1'").get()).toMatchObject({ c: 0 });
    // SET NULL: the memory itself survives, detached.
    const mem = db.prepare("SELECT subject_id FROM memories WHERE id='m1'").get() as { subject_id: string | null };
    expect(mem.subject_id).toBeNull();
    e.close();
  });

  it('enforces real intra-file FKs (foreign_keys = ON)', () => {
    const e = createEngineDb();
    const db = e.getDb();
    expect(() =>
      db.prepare("INSERT INTO people (subject_id) VALUES ('ghost')").run(),
    ).toThrow(/FOREIGN KEY/i);
    e.close();
  });

  it('keeps source_run_id SOFT but enforces source_thread_id as a real FK', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s', 'person', 'X')").run();
    // source_run_id → history.db runs: permanently SOFT, arbitrary value accepted.
    expect(() =>
      db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_run_id) VALUES ('m1','t','knowledge','global','','run-does-not-exist')").run(),
    ).not.toThrow();
    // source_thread_id is now a REAL FK (the spine is in engine.db): a bad ref throws.
    expect(() =>
      db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_thread_id) VALUES ('m2','t','knowledge','global','','thread-does-not-exist')").run(),
    ).toThrow(/FOREIGN KEY/i);
    // A real thread satisfies it, and deleting that thread SET NULLs the memory's ref.
    db.prepare("INSERT INTO threads (id) VALUES ('th1')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, source_thread_id) VALUES ('m3','t','knowledge','global','','th1')").run();
    db.prepare("INSERT INTO artifacts (id, type, thread_id) VALUES ('a1','html','th1')").run();
    db.prepare("DELETE FROM threads WHERE id='th1'").run();
    expect((db.prepare("SELECT source_thread_id s FROM memories WHERE id='m3'").get() as { s: string | null }).s).toBeNull();
    expect((db.prepare("SELECT thread_id t FROM artifacts WHERE id='a1'").get() as { t: string | null }).t).toBeNull();
    e.close();
  });

  it('persists across reopen without re-migrating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    const e1 = new EngineDb(path, '');
    e1.getDb().prepare("INSERT INTO subjects (id, kind, name) VALUES ('keep', 'person', 'Keep')").run();
    e1.close();

    const e2 = new EngineDb(path, '');
    const row = e2.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(51); // no re-migration on reopen — stays at the latest applied
    expect(e2.getDb().prepare("SELECT name FROM subjects WHERE id='keep'").get()).toMatchObject({ name: 'Keep' });
    e2.close();
  });

  it('encrypts at rest when a vault key is present (D2 posture)', () => {
    const e = createEngineDb('test-vault-key-123');
    expect(e.isEncrypted).toBe(true);
    const cipher = e.enc('sensitive subject note');
    expect(cipher).toMatch(/^enc:/);
    expect(cipher).not.toContain('sensitive subject note');
    expect(e.dec(cipher)).toBe('sensitive subject note');
    e.close();
  });

  it('falls back to plaintext passthrough without a vault key', () => {
    const e = createEngineDb();
    expect(e.isEncrypted).toBe(false);
    expect(e.enc('plain')).toBe('plain');     // no key → stored as-is
    expect(e.dec('plain')).toBe('plain');     // non-prefixed → returned as-is
    e.close();
  });

  it('passes ciphertext through unchanged when the key is wrong (no throw, no leak)', () => {
    const a = createEngineDb('key-aaaaaaaaaaaaaaaa');
    const cipher = a.enc('secret');
    a.close();
    // A second instance with a DIFFERENT key cannot decrypt; it must return the
    // input unchanged (graceful), never throw and never surface plaintext.
    const b = createEngineDb('key-bbbbbbbbbbbbbbbb');
    expect(b.dec(cipher)).toBe(cipher);
    b.close();
  });

  it('cascades / SET NULLs across the verb layer, self-FKs and engagement parties', () => {
    const e = createEngineDb();
    const db = e.getDb();
    // subjects: a self-firm, a customer, an assignee, and a parent
    db.prepare("INSERT INTO subjects (id, kind, name, is_self) VALUES ('firm','organization','MyFirm',1)").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('client','organization','Client')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('assignee','person','Assignee')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('eng','engagement','Project')").run();
    db.prepare("INSERT INTO engagements (subject_id, provider_subject_id, client_subject_id) VALUES ('eng','firm','client')").run();
    // workflow → trigger → task chain
    db.prepare("INSERT INTO workflows (id, name, definition_json) VALUES ('wf','W','{}')").run();
    db.prepare("INSERT INTO triggers (id, title, target_workflow_id) VALUES ('tr','T','wf')").run();
    db.prepare("INSERT INTO tasks (id, title, assignee_subject_id, due_trigger_id) VALUES ('parent','P','assignee','tr')").run();
    db.prepare("INSERT INTO tasks (id, title, parent_task_id) VALUES ('child','C','parent')").run();

    // Deleting the workflow SET NULLs the trigger's target_workflow_id.
    db.prepare("DELETE FROM workflows WHERE id='wf'").run();
    expect((db.prepare("SELECT target_workflow_id t FROM triggers WHERE id='tr'").get() as { t: string | null }).t).toBeNull();
    // Deleting the trigger SET NULLs the task's due_trigger_id.
    db.prepare("DELETE FROM triggers WHERE id='tr'").run();
    expect((db.prepare("SELECT due_trigger_id t FROM tasks WHERE id='parent'").get() as { t: string | null }).t).toBeNull();
    // Deleting the assignee subject SET NULLs the task's assignee_subject_id.
    db.prepare("DELETE FROM subjects WHERE id='assignee'").run();
    expect((db.prepare("SELECT assignee_subject_id a FROM tasks WHERE id='parent'").get() as { a: string | null }).a).toBeNull();
    // Deleting the parent task SET NULLs the child's parent_task_id (self-FK).
    db.prepare("DELETE FROM tasks WHERE id='parent'").run();
    expect((db.prepare("SELECT parent_task_id p FROM tasks WHERE id='child'").get() as { p: string | null }).p).toBeNull();
    // Deleting the self-firm SET NULLs engagement.provider_subject_id (engagement survives).
    db.prepare("DELETE FROM subjects WHERE id='firm'").run();
    const eng = db.prepare("SELECT provider_subject_id pr, client_subject_id cl FROM engagements WHERE subject_id='eng'").get() as { pr: string | null; cl: string | null };
    expect(eng.pr).toBeNull();
    expect(eng.cl).toBe('client');
    e.close();
  });

  it('cascades supersedes / conflicts / cooccurrences on memory and subject delete', () => {
    const e = createEngineDb();
    const db = e.getDb();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('a','person','A')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('b','person','B')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('mNew','new','knowledge','global','')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id) VALUES ('mOld','old','knowledge','global','')").run();
    db.prepare("INSERT INTO supersedes (new_memory_id, old_memory_id, reason) VALUES ('mNew','mOld','update')").run();
    db.prepare("INSERT INTO conflicts (id, new_memory_id, old_memory_id, reason) VALUES ('c1','mNew','mOld','number_change')").run();
    db.prepare("INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id) VALUES ('a','b')").run();

    // Deleting the OLD memory cascades into supersedes + conflicts (FK children).
    db.prepare("DELETE FROM memories WHERE id='mOld'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM supersedes").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM conflicts").get()).toMatchObject({ c: 0 });
    // Deleting subject 'b' (the trailing co-occurrence column) cascades the pair.
    db.prepare("DELETE FROM subjects WHERE id='b'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM subject_cooccurrences").get()).toMatchObject({ c: 0 });
    e.close();
  });

  it('deleteAllData wipes every user table (GDPR Art. 17) but keeps the schema intact', () => {
    const e = createEngineDb('vault-key-for-wipe-test');
    const db = e.getDb();
    // Populate a representative slice spanning the FK graph: subjects + detail,
    // the thread spine, memories + junction + supersedes, edges, and the verb layer.
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','person','Alice')").run();
    db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s2','organization','Acme')").run();
    db.prepare(`INSERT INTO people (subject_id, email, phone) VALUES ('s1', ?, ?)`).run(e.enc('a@b.ch'), e.enc('+41'));
    db.prepare("INSERT INTO organizations (subject_id, domain) VALUES ('s2','acme.ch')").run();
    db.prepare("INSERT INTO threads (id, title) VALUES ('t1','Chat')").run();
    db.prepare("INSERT INTO thread_messages (thread_id, seq, role, content_json) VALUES ('t1',0,'user','{}')").run();
    db.prepare("INSERT INTO memories (id, text, namespace, scope_type, scope_id, subject_id, source_thread_id) VALUES ('m1',?,'knowledge','global','','s1','t1')").run(e.enc('secret note'));
    db.prepare("INSERT INTO memory_subjects (memory_id, subject_id) VALUES ('m1','s1')").run();
    db.prepare("INSERT INTO relationships (id, from_subject_id, to_subject_id, kind) VALUES ('r1','s1','s2','works_for')").run();
    db.prepare("INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id) VALUES ('s1','s2')").run();
    db.prepare("INSERT INTO workflows (id, name, definition_json) VALUES ('wf','W','{}')").run();
    db.prepare("INSERT INTO triggers (id, title, target_workflow_id) VALUES ('tr','T','wf')").run();
    db.prepare("INSERT INTO tasks (id, title, due_trigger_id) VALUES ('tk','Todo','tr')").run();
    db.prepare("INSERT INTO connections (id, kind, name) VALUES ('cn','api','API')").run();
    db.prepare("INSERT INTO artifacts (id, type, thread_id) VALUES ('ar','html','t1')").run();
    // The bulk-run ledger holds before-images — customer data — so it is in the slice.
    db.prepare("INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase) VALUES ('br','h','workspace','restorable','previewed')").run();
    db.prepare("INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before) VALUES ('br',0,?,'update','restorable',?)").run(e.enc('a.txt'), e.enc('{"absent":false,"value":"x"}'));

    // Sanity: the slice really populated rows, so "all empty after" is not vacuous
    // (a future no-op INSERT couldn't make the wipe assertion trivially green).
    expect((db.prepare("SELECT COUNT(*) c FROM bulk_targets").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM subjects").get() as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) c FROM relationships").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM memory_subjects").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c).toBe(1);

    // Where the owner's vault secrets may go is the owner's configuration and goes with the erasure;
    // the record that the one-time boot migration ran stays, so it does not bind again.
    db.prepare("INSERT INTO vault_name_bindings (name, endpoints, origin, bound_at) VALUES ('CRM_KEY', '[\"https://crm.example.com\"]', 'migration', '2026-10-18T00:00:00.000Z')").run();
    db.prepare("INSERT INTO vault_name_binding_migration (migrated_at) VALUES ('2026-10-18T00:00:00.000Z')").run();

    e.deleteAllData();

    // Every user table is empty — no PII left in any of them. schema_version,
    // verb_backfill_marker and vault_name_binding_migration are migration bookkeeping
    // (not user data) and are kept.
    const userTables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version', 'verb_backfill_marker', 'vault_name_binding_migration') AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]).map(r => r.name);
    expect(userTables.length).toBeGreaterThan(15);
    for (const t of userTables) {
      const { c } = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      expect(c, `table ${t} should be empty after wipe`).toBe(0);
    }
    // The backfill marker SURVIVES the wipe (GDPR erasure must NOT be undone by the
    // boot backfill re-populating from the still-present legacy history.db).
    expect((db.prepare('SELECT COUNT(*) c FROM verb_backfill_marker').get() as { c: number }).c).toBe(1);
    expect(userTables).toContain('vault_name_bindings');
    expect((db.prepare('SELECT COUNT(*) c FROM vault_name_binding_migration').get() as { c: number }).c).toBe(1);
    // The schema itself survives — version stays at the latest, no re-migration on next open.
    expect((db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    // And the DB is still usable (inserts work — the tables weren't dropped).
    expect(() =>
      db.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s3','person','Bob')").run(),
    ).not.toThrow();
    e.close();
  });

  it('v15 migration keeps a populated v14 bulk ledger, adds an empty after_actual and the probe table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    const at = new EngineDb(path, '');
    at.getDb().exec(`
      INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total) VALUES ('br','h','workspace','restorable','done',1);
      INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, applied_at, result)
        VALUES ('br',0,'k0','update','restorable','b0','a0','2026-09-30T00:00:00Z','written');
      ALTER TABLE bulk_targets DROP COLUMN after_actual;
      ALTER TABLE bulk_targets DROP COLUMN write_sent;  -- v18
      DROP TABLE bulk_host_probes;
      DELETE FROM schema_version WHERE version >= 15; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN read_connection_id; ALTER TABLE bulk_targets DROP COLUMN read_grant_id; ALTER TABLE bulk_targets DROP COLUMN write_connection_id; ALTER TABLE bulk_targets DROP COLUMN write_grant_id; ALTER TABLE bulk_runs DROP COLUMN first_connection_id; ALTER TABLE bulk_runs DROP COLUMN first_grant_id;  -- v43
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;  -- v23
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      ALTER TABLE triggers DROP COLUMN model_tier;  -- v21
      ALTER TABLE triggers DROP COLUMN lease_until; ALTER TABLE triggers DROP COLUMN lease_holder; ALTER TABLE triggers DROP COLUMN lease_since;  -- v16
      ALTER TABLE triggers DROP COLUMN created_untrusted;  -- v19
      ALTER TABLE triggers DROP COLUMN created_by; ALTER TABLE triggers DROP COLUMN edited_by; ALTER TABLE triggers DROP COLUMN confirmed_by;  -- v20
    `);
    at.close();

    const e = new EngineDb(path, '');
    const db = e.getDb();
    expect((db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    expect(db.prepare('SELECT seq, before, after_planned, result, after_actual FROM bulk_targets').all())
      .toEqual([{ seq: 0, before: 'b0', after_planned: 'a0', result: 'written', after_actual: null }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bulk_host_probes').get()).toEqual({ n: 0 });
    e.close();
  });

  it('v14 migration carries a POPULATED v13 bulk ledger over and admits undo-only `delete` targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    // Rewind to v13: the two bulk tables in their v13 shape (copied from MIGRATIONS[12]),
    // one dry run in them.
    const at = new EngineDb(path, '');
    at.getDb().exec(`
      DELETE FROM schema_version WHERE version >= 14; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;  -- v23
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      ALTER TABLE triggers DROP COLUMN model_tier;  -- v21
      ALTER TABLE triggers DROP COLUMN lease_until; ALTER TABLE triggers DROP COLUMN lease_holder; ALTER TABLE triggers DROP COLUMN lease_since;  -- v16
      ALTER TABLE triggers DROP COLUMN created_untrusted;  -- v19
      ALTER TABLE triggers DROP COLUMN created_by; ALTER TABLE triggers DROP COLUMN edited_by; ALTER TABLE triggers DROP COLUMN confirmed_by;  -- v20
      DROP TABLE bulk_targets; DROP TABLE bulk_runs; DROP TABLE bulk_host_probes;
      CREATE TABLE bulk_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), created_by TEXT,
        rule_hash TEXT NOT NULL, target_system TEXT NOT NULL,
        undo TEXT NOT NULL CHECK (undo IN ('restorable','compensatable','none','mixed')),
        phase TEXT NOT NULL CHECK (phase IN ('planned','previewed','approved','writing','done','aborted','undone')),
        contract_json TEXT, approved_by TEXT, approved_at TEXT, approval_checksum TEXT, max_targets INTEGER,
        expires_at TEXT, targets_total INTEGER NOT NULL DEFAULT 0, targets_applied INTEGER NOT NULL DEFAULT 0,
        targets_failed INTEGER NOT NULL DEFAULT 0, halt_reason TEXT);
      CREATE INDEX idx_bulk_runs_created ON bulk_runs(created_at);
      CREATE TABLE bulk_targets (
        run_id TEXT NOT NULL REFERENCES bulk_runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
        target_key TEXT NOT NULL,
        change TEXT NOT NULL CHECK (change IN ('update','create','unchanged','invalid')),
        undo TEXT CHECK (undo IN ('restorable','compensatable','none')),
        before TEXT, after_planned TEXT, applied_at TEXT, result TEXT, error TEXT, undone_at TEXT,
        PRIMARY KEY (run_id, seq));
      INSERT INTO bulk_runs (id, rule_hash, target_system, undo, phase, targets_total) VALUES ('br','h','workspace','restorable','previewed',2);
      INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned) VALUES ('br',0,'k0','update','restorable','b0','a0');
      INSERT INTO bulk_targets (run_id, seq, target_key, change, error) VALUES ('br',1,'k1','invalid','bad_key');
    `);
    at.close();

    const e = new EngineDb(path, '');
    const db = e.getDb();
    expect((db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    expect(db.prepare('SELECT id, phase, targets_total, atomic, kind, source_run_id, target_collection FROM bulk_runs').all())
      .toEqual([{ id: 'br', phase: 'previewed', targets_total: 2, atomic: 0, kind: 'apply', source_run_id: null, target_collection: null }]);
    expect(db.prepare('SELECT seq, target_key, change, before, after_planned, error, claimed_at, source_seq FROM bulk_targets ORDER BY seq').all())
      .toEqual([
        { seq: 0, target_key: 'k0', change: 'update', before: 'b0', after_planned: 'a0', error: null, claimed_at: null, source_seq: null },
        { seq: 1, target_key: 'k1', change: 'invalid', before: null, after_planned: null, error: 'bad_key', claimed_at: null, source_seq: null },
      ]);
    db.prepare("INSERT INTO bulk_targets (run_id, seq, target_key, change) VALUES ('br',2,'k2','delete')").run();
    expect(() => db.prepare("INSERT INTO bulk_targets (run_id, seq, target_key, change) VALUES ('br',3,'k3','bogus')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE bulk_runs SET atomic = 2 WHERE id = 'br'").run()).toThrow(/CHECK/);
    // The cascade survived the rebuild.
    db.prepare("DELETE FROM bulk_runs WHERE id = 'br'").run();
    expect((db.prepare('SELECT COUNT(*) c FROM bulk_targets').get() as { c: number }).c).toBe(0);
    e.close();
  });

  it('deleteAllData is idempotent on an already-empty database', () => {
    const e = createEngineDb();
    expect(() => { e.deleteAllData(); e.deleteAllData(); }).not.toThrow();
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });

  it('recovers from a corrupt database file by renaming it aside and recreating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-'));
    tmpDirs.push(dir);
    const path = join(dir, 'engine.db');
    // Not a valid SQLite file — integrity_check (or open) must fail.
    writeFileSync(path, 'this is not a sqlite database, it is garbage bytes');

    const e = new EngineDb(path, '', { onCorruption: 'recreate' }); // the boot's option; must not throw
    // A .corrupt-* sidecar of the original was created.
    expect(readdirSync(dir).some(f => f.startsWith('engine.db.corrupt-'))).toBe(true);
    // The fresh DB is usable and stamped at the latest schema version.
    expect((e.getDb().prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v).toBe(51);
    e.close();
  });
});

describe('EngineDb v17 — the bulk run family lookup has an index', () => {
  it('the family walk reads bulk_runs through idx_bulk_runs_source, not a scan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-engine-v17-'));
    const e = new EngineDb(join(dir, 'engine.db'), '');
    try {
      const plan = (e.getDb().prepare(`EXPLAIN QUERY PLAN ${OPEN_IN_FAMILY_SQL}`).all('root', null) as { detail: string }[])
        .map((r) => r.detail);
      // The recursive step joins on source_run_id (`r`): that is the lookup the index is for.
      // Without it SQLite builds an AUTOMATIC index over bulk_runs on every call. Only `r` is
      // checked: how the outer join (`b`) is planned is not this index's business, and changes
      // once ANALYZE statistics exist (nothing in src runs ANALYZE or `PRAGMA optimize` today).
      const onR = plan.filter((d) => /^(SCAN|SEARCH) r\b/.test(d));
      expect(onR).toEqual(['SEARCH r USING INDEX idx_bulk_runs_source (source_run_id=?)']);
    } finally {
      e.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('EngineDb v11 — onboarding backfill for pre-W1 instances', () => {
  const tmpDirs: string[] = [];
  const dbPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-onb-'));
    tmpDirs.push(dir);
    return join(dir, 'engine.db');
  };
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const flags = (e: EngineDb): Array<{ flag: string; value: string }> =>
    e.getDb().prepare("SELECT flag, value FROM onboarding_flags WHERE owner_user_id = 'system'").all() as Array<{ flag: string; value: string }>;

  /** Take a db to v10 exactly, then close it — the state every pre-W1 instance is in.
   *
   *  ⚠ Coupled to the ladder HEAD, and silently so before this guard existed. The
   *  migrator resumes from MAX(schema_version), so deleting only the v11 row while a
   *  v12 row remains leaves the head at 12 and re-runs NOTHING — every test in this
   *  describe then asserts against a database v11 never touched, and they fail with
   *  six unrelated-looking assertion errors instead of one clear one. Rewinding needs
   *  BOTH halves: drop the version rows AND undo what those migrations did, or the
   *  re-run hits an already-applied DDL (SQLite has no ADD COLUMN IF NOT EXISTS).
   *  ⚠ ADDING A MIGRATION ABOVE v11? UNDO ITS EFFECT HERE, AND NOTHING WILL REMIND YOU.
   *  Whether a lapse is loud depends entirely on the migration's SHAPE, so this is
   *  stated rather than guarded:
   *    · `ALTER TABLE … ADD COLUMN` or an unguarded `CREATE TABLE` → the re-run hits
   *      the already-applied statement and throws. Loud, in every test here.
   *    · `CREATE {TABLE,INDEX} IF NOT EXISTS`, or a guarded `INSERT … WHERE NOT
   *      EXISTS` — which is what v11 itself is — → the re-run is a silent no-op, the
   *      rewind never happened, and these tests quietly run against the wrong schema.
   *  An earlier draft asserted `MAX(version) === 10` and called it a positive control.
   *  It was a tautology: the DELETE above makes that true whether or not the undo was
   *  added. It was removed rather than kept, because a check that cannot fail reads as
   *  protection and is worse than an admitted gap. */
  const openAtV10 = (p: string): void => {
    const e = new EngineDb(p, '');
    e.getDb().exec(`
      DELETE FROM schema_version WHERE version >= 11; ALTER TABLE triggers DROP COLUMN stamp_connections; DROP TABLE connection_records; ALTER TABLE connections DROP COLUMN first_grant_id; DROP TABLE approval_entries; DROP INDEX idx_triggers_route_token; ALTER TABLE triggers DROP COLUMN route_token_hash; DROP TABLE inbound_events;  -- v47
      ALTER TABLE triggers DROP COLUMN created_mandate_id; ALTER TABLE triggers DROP COLUMN mandate_editor; ALTER TABLE triggers DROP COLUMN mandate_editor_id; ALTER TABLE triggers DROP COLUMN mandate_edited_at; ALTER TABLE workflows DROP COLUMN created_by; ALTER TABLE workflows DROP COLUMN created_mandate_id; ALTER TABLE workflows DROP COLUMN mandate_editor; ALTER TABLE workflows DROP COLUMN mandate_editor_id; ALTER TABLE workflows DROP COLUMN mandate_edited_at; ALTER TABLE bulk_runs DROP COLUMN unsent_tracked; ALTER TABLE bulk_targets DROP COLUMN found_unsent;  -- v44
      ALTER TABLE bulk_targets DROP COLUMN failed_once;  -- v39
      ALTER TABLE bulk_runs DROP COLUMN judge_rule; ALTER TABLE bulk_runs DROP COLUMN judge_rule_hash; ALTER TABLE bulk_runs DROP COLUMN judge_started_at; ALTER TABLE bulk_targets DROP COLUMN judged_at; ALTER TABLE bulk_targets DROP COLUMN judge_claimed_at; ALTER TABLE bulk_targets DROP COLUMN judge_claim_token;  -- v36
      ALTER TABLE bulk_runs DROP COLUMN cost_usd; ALTER TABLE bulk_runs DROP COLUMN cost_cap_usd;  -- v35
      ALTER TABLE audit_log DROP COLUMN recorded_at;  -- v34
      ALTER TABLE bulk_runs DROP COLUMN list_bytes;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_calls;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_page;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_state;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN list_source;  -- v32
      ALTER TABLE bulk_runs DROP COLUMN principal;  -- v31
      ALTER TABLE bulk_runs DROP COLUMN mandate_id;  -- v31
      ALTER TABLE knowledge_entries DROP COLUMN source_thread_deleted_at;  -- v28
      ALTER TABLE tasks DROP COLUMN created_by;  -- v23
      ALTER TABLE triggers DROP COLUMN consent_reminded_at;  -- v25
      ALTER TABLE triggers DROP COLUMN last_escalation_at;  -- v26
      ALTER TABLE triggers DROP COLUMN last_escalation_outcome;  -- v26
      ALTER TABLE triggers DROP COLUMN model_tier;  -- v21
      DELETE FROM onboarding_flags;
      ALTER TABLE triggers DROP COLUMN waiting_until;   -- v12
      DROP TABLE bulk_targets; DROP TABLE bulk_runs;    -- v13 (v14 alters these two)
      DROP TABLE bulk_host_probes;                      -- v15
      ALTER TABLE triggers DROP COLUMN lease_until; ALTER TABLE triggers DROP COLUMN lease_holder; ALTER TABLE triggers DROP COLUMN lease_since;  -- v16
      ALTER TABLE triggers DROP COLUMN created_untrusted;  -- v19
      ALTER TABLE triggers DROP COLUMN created_by; ALTER TABLE triggers DROP COLUMN edited_by; ALTER TABLE triggers DROP COLUMN confirmed_by;  -- v20
    `);
    e.close();
  };

  // THE case this migration exists for. MUTATION: drop the v11 entry → an instance that
  // has been in use for months is walked through a first-run onboarding.
  it('marks an instance that already holds content, so the stepper stays hidden', () => {
    const p = dbPath();
    openAtV10(p);
    const seed = new Database(p);
    seed.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1', 'organization', 'Acme')").run();
    seed.close();

    const e = new EngineDb(p, '');
    const rows = flags(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flag).toBe('skipped');
    e.close();
  });

  // The other half, and the one that would hurt a real customer. MUTATION: drop the
  // EXISTS(...) content guard → every brand-new instance is marked on first boot and NO
  // ONE ever sees the onboarding again.
  it('leaves a genuinely fresh instance alone, so it still gets its onboarding', () => {
    const e = new EngineDb(dbPath(), '');
    expect(flags(e)).toHaveLength(0);
    e.close();
  });

  // MUTATION: drop the `NOT EXISTS (SELECT 1 FROM onboarding_flags)` guard → a returning
  // operator who genuinely COMPLETED the flow gets a second, contradictory row.
  it('never touches an instance that already recorded its own onboarding state', () => {
    const p = dbPath();
    openAtV10(p);
    const seed = new Database(p);
    seed.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1', 'organization', 'Acme')").run();
    seed.prepare("INSERT INTO onboarding_flags (owner_user_id, flag, value) VALUES ('system','knowledge_done','th-42')").run();
    seed.close();

    const e = new EngineDb(p, '');
    const rows = flags(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flag).toBe('knowledge_done');
    expect(rows[0]?.value).toBe('th-42');
    e.close();
  });

  // The funnel must be able to tell a backfill from a real user skip. MUTATION: write a
  // bare timestamp like the UI does → the two become indistinguishable and every
  // pre-existing tenant is counted as an operator who chose to skip onboarding.
  it('records provenance in the value so the funnel can exclude it', () => {
    const p = dbPath();
    openAtV10(p);
    const seed = new Database(p);
    seed.prepare("INSERT INTO knowledge_entries (id, text) VALUES ('k1', 'x')").run();
    seed.close();

    const e = new EngineDb(p, '');
    expect(flags(e)[0]?.value).toMatch(/^backfill:pre-w1:\d{4}-\d{2}-\d{2}T/);
    e.close();
  });

  // THE state the refuter surfaced, and the one the fleet is actually in. Both
  // `subject_graph_enabled` and `durable_memory_enabled` default OFF, so subjects /
  // memories / knowledge_entries are EMPTY on an instance used for months — its real
  // content sits in agent-memory.db and history.db. Only the verb-graph tables are
  // written unconditionally. MUTATION: key the predicate on the three flag-gated tables
  // only → the migration becomes a no-op for exactly the instances it exists for and
  // fires solely on the flag-ON canaries.
  it('backfills a flag-default instance whose content is only in the verb tables', () => {
    const p = dbPath();
    openAtV10(p);
    const seed = new Database(p);
    seed.prepare("INSERT INTO triggers (id, title, source, effect) VALUES ('t1', 'Nightly backup', 'cron', 'backup')").run();
    seed.close();

    const e = new EngineDb(p, '');
    const rows = flags(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.flag).toBe('skipped');
    e.close();
  });

  // MUTATION: drop the `owner_user_id = 'system'` filter from the guard → a future second
  // owner's skip suppresses the system owner's backfill.
  it('is scoped to the owner it inserts for', () => {
    const p = dbPath();
    openAtV10(p);
    const seed = new Database(p);
    seed.prepare("INSERT INTO triggers (id, title, source, effect) VALUES ('t1', 'Nightly backup', 'cron', 'backup')").run();
    seed.prepare("INSERT INTO onboarding_flags (owner_user_id, flag, value) VALUES ('someone-else','skipped','x')").run();
    seed.close();

    const e = new EngineDb(p, '');
    // The system owner still gets its backfill; the other owner's row is untouched.
    const mine = flags(e);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.value).toMatch(/^backfill:pre-w1:/);
    const all = e.getDb().prepare('SELECT COUNT(*) c FROM onboarding_flags').get() as { c: number };
    expect(all.c).toBe(2);
    e.close();
  });

  // The window that actually exists today: W1 reached the canary, v11 has not. One app
  // open writes `first_session_at` — a render-ack, NOT a completion (the UI dismisses on
  // knowledgeDone || skipped only). MUTATION: guard on "no row at all" instead of the two
  // dismissing flags → that single ack blocks the backfill and the operator keeps a
  // first-run stepper forever.
  it('still backfills when only a render-ack row exists', () => {
    const p = dbPath();
    openAtV10(p);
    const seed = new Database(p);
    seed.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1', 'organization', 'Acme')").run();
    seed.prepare("INSERT INTO onboarding_flags (owner_user_id, flag, value) VALUES ('system','first_session_at','2026-07-27T10:00:00Z')").run();
    seed.close();

    const e = new EngineDb(p, '');
    const rows = flags(e);
    expect(rows.map(r => r.flag).sort()).toEqual(['first_session_at', 'skipped']);
    expect(rows.find(r => r.flag === 'skipped')?.value).toMatch(/^backfill:pre-w1:/);
    e.close();
  });

  // MUTATION: use INSERT (not the NOT EXISTS guard) → reopening throws on the PK.
  it('is idempotent across reopens', () => {
    const p = dbPath();
    openAtV10(p);
    const seed = new Database(p);
    seed.prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1', 'organization', 'Acme')").run();
    seed.close();

    for (let i = 0; i < 3; i += 1) {
      const e = new EngineDb(p, '');
      expect(flags(e)).toHaveLength(1);
      e.close();
    }
  });
});

describe('the store binding and the exact marker (v38)', () => {
  it('binds the token to the profile and the store under its own subkey, and only with a vault key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-bind-'));
    try {
      const keyed = new EngineDb(join(dir, 'a.db'), 'vault-key-for-binding-test');
      const d = keyed.storeBindingDigest('shop', 'https://acme.myshopify.com', 'tok');
      expect(d).toMatch(/^[0-9a-f]{64}$/);
      expect(keyed.storeBindingDigest('shop', 'https://acme.myshopify.com', 'tok')).toBe(d);
      // Each part counts.
      expect(keyed.storeBindingDigest('shop2', 'https://acme.myshopify.com', 'tok')).not.toBe(d);
      expect(keyed.storeBindingDigest('shop', 'https://other.myshopify.com', 'tok')).not.toBe(d);
      expect(keyed.storeBindingDigest('shop', 'https://acme.myshopify.com', 'tok2')).not.toBe(d);
      // Not the keyed hash of the same parts: its own subkey.
      expect(keyed.keyedHash(['shop', 'https://acme.myshopify.com', 'tok'])).not.toBe(d);
      // Another vault key, another binding.
      const other = new EngineDb(join(dir, 'b.db'), 'another-vault-key');
      expect(other.storeBindingDigest('shop', 'https://acme.myshopify.com', 'tok')).not.toBe(d);
      keyed.close();
      other.close();
      const unkeyed = new EngineDb(join(dir, 'c.db'), '');
      expect(unkeyed.storeBindingDigest('shop', 'https://acme.myshopify.com', 'tok')).toBeNull();
      unkeyed.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets the marker once, keeps the first stamp, and keeps it across a reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-marker-'));
    try {
      const path = join(dir, 'engine.db');
      let e = new EngineDb(path, 'k');
      expect(e.exactMarkerSet()).toBe(false);
      e.setExactMarker();
      // Backdated: two calls within one second would carry the same stamp either way.
      e.getDb().prepare("UPDATE exact_marker SET first_ok_at = '2026-01-01 00:00:00'").run();
      const first = '2026-01-01 00:00:00';
      e.setExactMarker();
      expect((e.getDb().prepare('SELECT COUNT(*) AS n FROM exact_marker').get() as { n: number }).n).toBe(1);
      expect((e.getDb().prepare('SELECT first_ok_at FROM exact_marker').get() as { first_ok_at: string }).first_ok_at).toBe(first);
      e.close();
      e = new EngineDb(path, 'k');
      expect(e.exactMarkerSet()).toBe(true);
      e.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
