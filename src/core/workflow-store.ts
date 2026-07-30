import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';

/**
 * Escape LIKE metacharacters so a `%`/`_` in a (possibly client-supplied) id
 * cannot widen the prefix match to arbitrary rows. Mirrors the escape in
 * run-history-persistence `getPipelineRun`. NOTE: the legacy workflow-def
 * statements (renamePlannedPipeline/deletePlannedPipeline/…) still use a bare
 * `LIKE '${id}%'` — a shared pre-existing over-delete footgun tracked as a
 * follow-up; the mirror is written correctly here rather than replicating it.
 */
function likePrefix(id: string): string {
  return `${id.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * WorkflowStore — the S3a write/read layer over the engine.db `workflows` table
 * (Foundation Rework v2, verb layer). It promotes the legacy workflow DEFINITION
 * — a `pipeline_runs` row with `status='planned'` and a `manifest_json.template`
 * flag (history.db) — to a first-class engine.db table with a real `is_template`
 * column and FK-able `id` (referenced by `triggers.target_workflow_id`).
 *
 * S3f write-cutover makes this the SOLE authority for workflow definitions: every
 * `insertPlannedPipeline`/`rename`/`delete`/`setWorkflowConfirmedAt`/
 * `markPipelineExecuted` writes here directly, and every read comes from here.
 * The legacy history.db `pipeline_runs status='planned'/'executed'` def rows are
 * retired (purged in mig v44); `pipeline_runs` stays the run SPINE only. This
 * began as an additive dual-write mirror (S3a, gated on a now-removed flag) with
 * legacy authoritative; S3d backfilled, S3e cut reads over, S3f cut writes over.
 *
 * `definition_json` is stored PLAINTEXT — a faithful 1:1 relocation of the legacy
 * `pipeline_runs.manifest_json`, which is also plaintext. This lets the patch ops
 * (rename/setConfirmedAt) use surgical SQL `json_set` exactly like the legacy
 * path (no read-modify-write, no encrypt/re-encrypt divergence). At-rest
 * encryption of verb-definition free-text is a real hardening but belongs in a
 * deliberate slice (legacy manifest_json parity + a key-loss-safe read path) —
 * NOT smuggled into the relocation, where an encrypted blob + json patch would
 * corrupt on a key rotation.
 */
export interface WorkflowRow {
  id: string;
  name: string;
  description?: string | undefined;
  /** The full serialized PlannedPipeline (plaintext). */
  definitionJson: string;
  isTemplate: boolean;
  /** Soft ref → the history.db run this was captured from. Nullable. */
  sourceRunId?: string | null | undefined;
}

export interface StoredWorkflow {
  id: string;
  name: string;
  description: string;
  /** The full serialized PlannedPipeline. */
  definitionJson: string;
  isTemplate: boolean;
  createdAt: string;
}

/** Result of a content-schema migration pass (Move 1, PRD §4.1). */
export interface ContentMigrationCounts {
  /** Rows examined. */
  scanned: number;
  /** Rows whose blob was forward-migrated and rewritten. */
  migrated: number;
}

export class WorkflowStore {
  private readonly db: Database.Database;

  constructor(engine: EngineDb) {
    this.db = engine.getDb();
  }

  /**
   * Upsert a workflow definition (INSERT-or-update by id). Uses
   * `ON CONFLICT DO UPDATE` — NOT `INSERT OR REPLACE` — so a re-save (a) preserves
   * `created_at` and (b) does not delete+reinsert the row (which would trip the
   * `triggers.target_workflow_id` ON DELETE SET NULL on any child trigger).
   * `updated_at` bumps so {@link list} floats a re-saved workflow to the top,
   * matching the legacy `pipeline_runs.started_at` that INSERT OR REPLACE resets.
   *
   * `ts` (S3d backfill only) preserves the legacy timestamps so a backfilled
   * pre-existing workflow keeps its true creation order (post-read-cutover the
   * library list would otherwise float every backfilled row to "now"). The live
   * mirror omits `ts` → both columns resolve to `datetime('now')` via COALESCE,
   * byte-for-byte the prior behaviour (verified: no-ts INSERT = DDL default now,
   * no-ts conflict-update `updated_at` = now).
   */
  upsert(row: WorkflowRow, ts?: { createdAt?: string | undefined; updatedAt?: string | undefined }): void {
    this.db.prepare(`
      INSERT INTO workflows (id, name, description, definition_json, is_template, source_run_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        definition_json = excluded.definition_json,
        is_template = excluded.is_template,
        source_run_id = excluded.source_run_id,
        updated_at = excluded.updated_at
    `).run(
      row.id,
      row.name,
      row.description ?? '',
      row.definitionJson,
      row.isTemplate ? 1 : 0,
      row.sourceRunId ?? null,
      ts?.createdAt ?? null,
      ts?.updatedAt ?? null,
    );
  }

  /**
   * Rename — patches both the `name` column AND the serialized
   * `definition_json.$.name` (a read-cutover consumer deserializes definition_json)
   * via a surgical SQL `json_set`, mirroring the legacy `renamePlannedPipeline`
   * across EVERY prefix match. Returns false if no row matched.
   *
   * Deliberately does NOT bump `updated_at`: the legacy `renamePlannedPipeline`
   * leaves `pipeline_runs.started_at` untouched, so a rename must NOT reorder the
   * library list — else the S3d read-cutover would visibly float renamed
   * workflows to the top (a non-transparent behavior change). `updated_at` tracks
   * full saves only (insert/re-save via {@link upsert}), matching started_at.
   */
  rename(id: string, name: string): boolean {
    if (id === '') return false; // empty id → likePrefix '%' would match ALL rows
    const res = this.db.prepare(
      "UPDATE workflows SET name = ?, definition_json = json_set(definition_json, '$.name', ?) WHERE id = ? OR id LIKE ? ESCAPE '\\'",
    ).run(name, name, id, likePrefix(id));
    return res.changes > 0;
  }

  /** Stamp `definition_json.$.confirmedAt` (the human's first-run-confirm).
   *  Like {@link rename}, does NOT bump `updated_at` — the legacy
   *  `setWorkflowConfirmedAt` leaves `started_at` untouched (no list reorder). */
  setConfirmedAt(id: string, confirmedAt: string): boolean {
    if (id === '') return false; // empty id → likePrefix '%' would match ALL rows
    const res = this.db.prepare(
      "UPDATE workflows SET definition_json = json_set(definition_json, '$.confirmedAt', ?) WHERE id = ? OR id LIKE ? ESCAPE '\\'",
    ).run(confirmedAt, id, likePrefix(id));
    return res.changes > 0;
  }

  /** Prefix-matched delete (mirrors legacy `deletePlannedPipeline`). */
  remove(id: string): boolean {
    if (id === '') return false; // empty id → likePrefix '%' would match ALL rows
    const res = this.db.prepare(
      "DELETE FROM workflows WHERE id = ? OR id LIKE ? ESCAPE '\\'",
    ).run(id, likePrefix(id));
    return res.changes > 0;
  }

  /**
   * Exact-id delete for the one-shot-executed transition. A non-template
   * planned pipeline that runs leaves the DEFINITION set (in history.db it flips
   * `status='planned'→'executed'`, becoming a Run record; the Run spine stays in
   * history.db). Templates never reach this path (`markPipelineExecuted` fires
   * only for `!isTemplate`), so this never removes a library template.
   */
  dropExecuted(id: string): boolean {
    const res = this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return res.changes > 0;
  }

  /**
   * Content-schema migration (Move 1, PRD §4.1). Walks EVERY stored definition
   * and forward-migrates its `definition_json` blob to the current content
   * version via the injected pure `transform`. Per-row + version-gated (the gate
   * lives inside `transform`), which makes it:
   *   - idempotent — a re-run migrates 0 (transform returns null for a current blob);
   *   - crash-safe + resumable — each UPDATE auto-commits on its own and stamps
   *     the new version INSIDE the blob, so the write and its idempotency marker
   *     are the SAME atomic write (no separate marker to desync); a crash after
   *     row K leaves 1..K migrated and the next boot resumes at K+1;
   *   - forward-only — `transform` never downgrades.
   *
   * Preserves `updated_at` (like {@link rename}/{@link setConfirmedAt}): a
   * migration is NOT a user re-save and must not reorder the library list.
   * `transform` returns the re-serialized blob when it changed, or `null` to skip
   * (already-current OR malformed — a row we can't parse is left untouched).
   */
  migrateContentSchema(transform: (raw: string) => string | null): ContentMigrationCounts {
    const rows = this.db.prepare('SELECT id, definition_json FROM workflows').all() as Array<{ id: string; definition_json: string }>;
    const update = this.db.prepare('UPDATE workflows SET definition_json = ? WHERE id = ?');
    let migrated = 0;
    for (const row of rows) {
      const next = transform(row.definition_json);
      if (next === null) continue;
      update.run(next, row.id);
      migrated++;
    }
    return { scanned: rows.length, migrated };
  }

  /** Read a single workflow definition (prefix-matched). */
  get(id: string): StoredWorkflow | undefined {
    if (id === '') return undefined; // empty id → likePrefix '%' would match ALL rows
    const row = this.db.prepare(
      "SELECT id, name, description, definition_json, is_template, created_at FROM workflows WHERE id = ? OR id LIKE ? ESCAPE '\\' LIMIT 1",
    ).get(id, likePrefix(id)) as {
      id: string; name: string; description: string; definition_json: string;
      is_template: number; created_at: string;
    } | undefined;
    if (!row) return undefined;
    return this._map(row);
  }

  /**
   * List workflow definitions, most-recently-SAVED first. Orders by `updated_at`,
   * which the store bumps only on a full save (insert/re-save via {@link upsert}),
   * NOT on rename/setConfirmedAt — so it matches the legacy `getPlannedPipelines`
   * `ORDER BY started_at DESC` (started_at is likewise reset only on re-save).
   */
  list(limit = 100): StoredWorkflow[] {
    const rows = this.db.prepare(
      'SELECT id, name, description, definition_json, is_template, created_at FROM workflows ORDER BY updated_at DESC LIMIT ?',
    ).all(limit) as Array<{
      id: string; name: string; description: string; definition_json: string;
      is_template: number; created_at: string;
    }>;
    return rows.map(r => this._map(r));
  }

  /**
   * S3e read-cutover: the by-id workflow-def read that backs the legacy
   * `getPlannedPipeline` (`{id, manifest_json}`). `definition_json` IS the legacy
   * `manifest_json` (relocated verbatim in S3a), so a consumer parses it
   * identically. Prefix-matched (escaped) like {@link get}; empty id → undefined.
   * No `status='planned'` filter: the engine.db `workflows` table holds ONLY
   * definitions (executed one-shots are dropped via {@link dropExecuted}), so it
   * IS the legacy planned set.
   */
  getPlanned(id: string): { id: string; manifest_json: string } | undefined {
    if (id === '') return undefined;
    const row = this.db.prepare(
      "SELECT id, definition_json FROM workflows WHERE id = ? OR id LIKE ? ESCAPE '\\' LIMIT 1",
    ).get(id, likePrefix(id)) as { id: string; definition_json: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, manifest_json: row.definition_json };
  }

  /**
   * S3e read-cutover: the library-list read backing the legacy
   * `getPlannedPipelines` (`{id, manifest_name, manifest_json, step_count,
   * started_at}`). Returns ALL definitions (templates AND non-template plans) —
   * the `template === true` filter is the caller's app-layer step (http-api
   * `/api/workflows/library`), matching legacy exactly. `started_at ← updated_at`
   * (legacy `pipeline_runs.started_at` is reset on each INSERT-OR-REPLACE re-save,
   * which the mirror tracks via `updated_at`), so `ORDER BY updated_at DESC` ==
   * legacy `ORDER BY started_at DESC`. `step_count` is derived from the blob (the
   * http-api mapper prefers `parsed.steps.length` anyway).
   */
  listPlanned(limit = 100): Array<{
    id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
  }> {
    return this.db.prepare(
      `SELECT id,
              name AS manifest_name,
              definition_json AS manifest_json,
              COALESCE(json_array_length(definition_json, '$.steps'), 0) AS step_count,
              updated_at AS started_at
       FROM workflows ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as Array<{
      id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
    }>;
  }

  private _map(row: {
    id: string; name: string; description: string; definition_json: string;
    is_template: number; created_at: string;
  }): StoredWorkflow {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      definitionJson: row.definition_json,
      isTemplate: row.is_template === 1,
      createdAt: row.created_at,
    };
  }
}
