import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import { isMandateTag, isOwnerPrincipal, principalTag, type RequestPrincipal } from './request-principal.js';

/**
 * Escape LIKE metacharacters so a `%`/`_` in a (possibly client-supplied) id
 * cannot widen the prefix match to arbitrary rows. Mirrors the escape in
 * run-history-persistence `getPipelineRun`.
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

/**
 * Who made a workflow and which mandate changed it last (engine.db v45). A request writes it
 * through {@link WorkflowStore.upsert} and {@link WorkflowStore.rename}; nothing else does.
 */
export interface WorkflowAuthorship {
  /** The creating request's tag; null for the owner, the engine and rows from before v45. */
  createdBy: string | null;
  /** The grant id of the mandate in `createdBy`; only beside a mandate tag. */
  createdMandateId: string | null;
  /** The last mandate that changed the workflow, its grant id, and when. */
  mandateEditor: string | null;
  mandateEditorId: string | null;
  mandateEditedAt: string | null;
  createdAt: string;
  /** The marks the owner took over (`plan-takeover.ts`), as they stood; null when none. */
  coveredCreatedBy: string | null;
  coveredCreatedId: string | null;
  coveredCreatedAt: string | null;
  coveredEditedBy: string | null;
  coveredEditedId: string | null;
  coveredEditedAt: string | null;
}

/**
 * The columns a write by `author` sets. A mandate's write names the mandate with its grant id
 * from the same principal; the owner's and the engine's (`null`) name nobody, so they leave a
 * mandate's mark where it is.
 */
function authorColumns(author: RequestPrincipal | null): { tag: string | null; mandate: string | null; mandateId: string | null } {
  // The type forbids it; a caller the compiler does not see (a test double, plain JS) must not
  // turn a missing author into the owner.
  if ((author as RequestPrincipal | null | undefined) === undefined) throw new Error('workflow write without an author');
  if (author === null || isOwnerPrincipal(author)) return { tag: null, mandate: null, mandateId: null };
  const tag = principalTag(author);
  return author.kind === 'mandate'
    ? { tag, mandate: tag, mandateId: author.mandateId ?? null }
    : { tag, mandate: null, mandateId: null };
}

/** One accepted workflow grant, as `workflow_grants` holds it (engine.db v37). */
export interface WorkflowGrantRow {
  grantId: string;
  workflowId: string;
  /** The contract as the person was shown it. */
  contractJson: string;
  /** The auth origin of the accepting request (`ReviewedGrantStamp.by`). */
  by: string;
  name: string | null;
  at: string;
  checksum: string;
  binding: 'keyed' | 'unkeyed';
  triggerId: string;
  cron: string;
  boundParamsJson: string;
  afterUntrusted: boolean;
}

/** A stored binding, or a throw: a row that holds neither value is unreadable, not unkeyed. */
function bindingOf(raw: string): 'keyed' | 'unkeyed' {
  if (raw === 'keyed' || raw === 'unkeyed') return raw;
  throw new Error('workflow_grants: unreadable binding');
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
   *
   * `author` is the request that saves ({@link WorkflowAuthorship}); `null` only for a write
   * no request makes. It is required so that a new caller cannot leave it out: a missing
   * author would read as the owner. The creator is written by the INSERT alone. A re-save
   * leaves it, so a mandate that changes someone else's workflow becomes its editor and never
   * its creator; a mandate's re-save sets the editor, anyone else's leaves it.
   */
  upsert(row: WorkflowRow, author: RequestPrincipal | null, ts?: { createdAt?: string | undefined; updatedAt?: string | undefined }): void {
    const by = authorColumns(author);
    this.db.prepare(`
      INSERT INTO workflows (id, name, description, definition_json, is_template, source_run_id, status, created_at, updated_at,
                             created_by, created_mandate_id)
      VALUES (?, ?, ?, ?, ?, ?, 'active', COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        definition_json = excluded.definition_json,
        is_template = excluded.is_template,
        source_run_id = excluded.source_run_id,
        updated_at = excluded.updated_at,
        mandate_editor = COALESCE(?, workflows.mandate_editor),
        mandate_editor_id = CASE WHEN ? IS NULL THEN workflows.mandate_editor_id ELSE ? END,
        mandate_edited_at = CASE WHEN ? IS NULL THEN workflows.mandate_edited_at ELSE datetime('now') END,
        covered_edited_by = CASE WHEN ? IS NULL THEN workflows.covered_edited_by ELSE NULL END,
        covered_edited_id = CASE WHEN ? IS NULL THEN workflows.covered_edited_id ELSE NULL END,
        covered_edited_at = CASE WHEN ? IS NULL THEN workflows.covered_edited_at ELSE NULL END
    `).run(
      row.id,
      row.name,
      row.description ?? '',
      row.definitionJson,
      row.isTemplate ? 1 : 0,
      row.sourceRunId ?? null,
      ts?.createdAt ?? null,
      ts?.updatedAt ?? null,
      by.tag,
      by.mandateId,
      by.mandate,
      by.mandate, by.mandateId,
      by.mandate,
      by.mandate, by.mandate, by.mandate,
    );
  }

  /**
   * Save a copy of the workflow `sourceId` as {@link upsert} does, and give the copy the
   * source's latest mandate mark as its editor, in one transaction: the source's mandate
   * editor with its grant id and time, else its creator when that is a mandate, with the
   * grant id and `created_at`. The copy holds that mandate's steps, so it answers for them as
   * the source does; its creator is still `author`. A source without a mandate mark (or one
   * that is gone) leaves the copy's editor empty.
   *
   * The owner's takeover of that mark travels with it into the copy's editor columns: from the
   * source's editor cover, or its creator cover when the mark copied was the creator. Without it
   * the copy of a workflow the owner took over would carry the ended mandate as a member again.
   * Not a new edit, so the mark is not uncovered here.
   *
   * Only a path on which the server itself knows the source copies this way (`save_workflow` from
   * an existing workflow). A workflow that
   * comes back through the user's hands (`import_workflow` from an exported block, `save_workflow`
   * from what a session did) is saved by {@link upsert} and carries only its saver's mark: a source named in
   * pasted text can be edited or dropped by whoever pastes it, so a mark taken from there would
   * protect nothing. A copy that must carry another's mark needs a path on the server.
   */
  upsertCopy(row: WorkflowRow, author: RequestPrincipal | null, sourceId: string): void {
    this.db.transaction(() => {
      this.upsert(row, author);
      const src = this.authorship(sourceId);
      if (src === undefined) return;
      const mark = src.mandateEditor !== null
        ? { editor: src.mandateEditor, id: src.mandateEditorId, at: src.mandateEditedAt, cby: src.coveredEditedBy, cid: src.coveredEditedId, cat: src.coveredEditedAt }
        : isMandateTag(src.createdBy)
          ? { editor: src.createdBy, id: src.createdMandateId, at: src.createdAt, cby: src.coveredCreatedBy, cid: src.coveredCreatedId, cat: src.coveredCreatedAt }
          : null;
      if (mark === null) return;
      this.db.prepare('UPDATE workflows SET mandate_editor = ?, mandate_editor_id = ?, mandate_edited_at = ?, covered_edited_by = ?, covered_edited_id = ?, covered_edited_at = ? WHERE id = ?')
        .run(mark.editor, mark.id, mark.at, mark.cby, mark.cid, mark.cat, row.id);
    })();
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
   *
   * A rename is a change: a mandate's rename marks every row it renames with the mandate,
   * in the same statement, like {@link upsert}.
   */
  rename(id: string, name: string, author: RequestPrincipal | null): boolean {
    const target = this._resolveWriteId(id);
    if (target === null) return false;
    const by = authorColumns(author);
    const res = by.mandate === null
      ? this.db.prepare(
        "UPDATE workflows SET name = ?, definition_json = json_set(definition_json, '$.name', ?) WHERE id = ?",
      ).run(name, name, target)
      : this.db.prepare(
        "UPDATE workflows SET name = ?, definition_json = json_set(definition_json, '$.name', ?), mandate_editor = ?, mandate_editor_id = ?, mandate_edited_at = datetime('now'), covered_edited_by = NULL, covered_edited_id = NULL, covered_edited_at = NULL WHERE id = ?",
      ).run(name, name, by.mandate, by.mandateId, target);
    return res.changes > 0;
  }

  /** Who made the workflow with exactly this id and which mandate changed it last, or
   *  `undefined` when there is none. */
  authorship(id: string): WorkflowAuthorship | undefined {
    const r = this.db.prepare(
      `SELECT created_by, created_mandate_id, mandate_editor, mandate_editor_id, mandate_edited_at, created_at,
              covered_created_by, covered_created_id, covered_created_at, covered_edited_by, covered_edited_id, covered_edited_at
       FROM workflows WHERE id = ?`,
    ).get(id) as {
      created_by: string | null; created_mandate_id: string | null; mandate_editor: string | null;
      mandate_editor_id: string | null; mandate_edited_at: string | null; created_at: string;
      covered_created_by: string | null; covered_created_id: string | null; covered_created_at: string | null;
      covered_edited_by: string | null; covered_edited_id: string | null; covered_edited_at: string | null;
    } | undefined;
    if (r === undefined) return undefined;
    return {
      createdBy: r.created_by, createdMandateId: r.created_mandate_id, mandateEditor: r.mandate_editor,
      mandateEditorId: r.mandate_editor_id, mandateEditedAt: r.mandate_edited_at, createdAt: r.created_at,
      coveredCreatedBy: r.covered_created_by, coveredCreatedId: r.covered_created_id, coveredCreatedAt: r.covered_created_at,
      coveredEditedBy: r.covered_edited_by, coveredEditedId: r.covered_edited_id, coveredEditedAt: r.covered_edited_at,
    };
  }

  /** Stamp `definition_json.$.confirmedAt` (the human's first-run-confirm).
   *  Like {@link rename}, does NOT bump `updated_at` — the legacy
   *  `setWorkflowConfirmedAt` leaves `started_at` untouched (no list reorder). */
  setConfirmedAt(id: string, confirmedAt: string): boolean {
    const target = this._resolveWriteId(id);
    if (target === null) return false;
    const res = this.db.prepare(
      "UPDATE workflows SET definition_json = json_set(definition_json, '$.confirmedAt', ?) WHERE id = ?",
    ).run(confirmedAt, target);
    return res.changes > 0;
  }

  /**
   * Write a reviewed grant: the contract, its stamp and the first-run-confirm, in ONE
   * statement, so no reader sees a stamp without its contract or a confirm without
   * either. Exact id only, not even an unambiguous prefix like the writers above: this one
   * must land on exactly the row its caller read. Does not bump `updated_at` (same as {@link setConfirmedAt}).
   * A concurrent edit between the caller's read and this write is not lost silently: the
   * stamp's checksum covers the steps, so the run check refuses the mismatch.
   */
  setReviewedGrant(id: string, contractJson: string, stampJson: string, confirmedAt: string): boolean {
    if (id === '') return false;
    const res = this.db.prepare(
      "UPDATE workflows SET definition_json = json_set(definition_json, '$.capabilityContract', json(?), '$.reviewedGrant', json(?), '$.confirmedAt', ?) WHERE id = ?",
    ).run(contractJson, stampJson, confirmedAt, id);
    return res.changes === 1;
  }

  /**
   * Accept a reviewed grant: insert its `workflow_grants` row and write contract, stamp and
   * confirm onto the workflow, in ONE transaction. Neither half commits without the other — no
   * stamp naming a row that was never written, no row written for a workflow the stamp could
   * not reach. Later the row outlives the stamp on purpose (a new acceptance, an edit that drops
   * the grant, deleting the workflow): it is the record, and is never changed.
   * `setReviewedGrant` reports a missing workflow by returning `false`, not by throwing, and a
   * transaction commits whatever did not throw, so the `false` is turned into a throw inside
   * it: otherwise the row would commit for a workflow deleted between the caller's read and
   * this write. Returns `false` in that case, after the rollback; any other failure throws.
   */
  acceptReviewedGrant(row: WorkflowGrantRow, stampJson: string, confirmedAt: string): boolean {
    const missing = new Error('workflow-grant: the workflow is gone');
    try {
      this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO workflow_grants (id, workflow_id, contract_json, accepted_by, name, accepted_at, checksum, binding, trigger_id, cron, bound_params_json, after_untrusted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.grantId, row.workflowId, row.contractJson, row.by, row.name, row.at,
          row.checksum, row.binding, row.triggerId, row.cron, row.boundParamsJson, row.afterUntrusted ? 1 : 0,
        );
        if (!this.setReviewedGrant(row.workflowId, row.contractJson, stampJson, confirmedAt)) throw missing;
      })();
    } catch (err) {
      if (err === missing) return false;
      throw err;
    }
    return true;
  }

  /** The `workflow_grants` row with this id, or `undefined` when there is none. Never changes a row. */
  getGrant(grantId: string): WorkflowGrantRow | undefined {
    const r = this.db.prepare('SELECT * FROM workflow_grants WHERE id = ?').get(grantId) as {
      id: string; workflow_id: string; contract_json: string; accepted_by: string; name: string | null;
      accepted_at: string; checksum: string; binding: string; trigger_id: string; cron: string;
      bound_params_json: string; after_untrusted: number;
    } | undefined;
    if (r === undefined) return undefined;
    return {
      grantId: r.id, workflowId: r.workflow_id, contractJson: r.contract_json, by: r.accepted_by,
      name: r.name, at: r.accepted_at, checksum: r.checksum, binding: bindingOf(r.binding),
      triggerId: r.trigger_id, cron: r.cron, boundParamsJson: r.bound_params_json, afterUntrusted: r.after_untrusted === 1,
    };
  }

  /** Delete one workflow, named by its id or an unambiguous prefix of it ({@link _resolveWriteId}). */
  remove(id: string): boolean {
    const target = this._resolveWriteId(id);
    if (target === null) return false;
    return this.db.prepare('DELETE FROM workflows WHERE id = ?').run(target).changes > 0;
  }

  /**
   * The one row a write names: the exact id, else the only id that starts with it, else none.
   * A write never lands on every row an id is a prefix of: confirming, renaming or deleting
   * `wf-a` must leave `wf-ab`, possibly another mandate's, alone. Same rule as
   * `TriggerStore._resolveTargetWorkflowId`.
   */
  private _resolveWriteId(id: string): string | null {
    if (id === '') return null; // likePrefix('') is a bare '%', which would match every row
    const exact = this.db.prepare('SELECT id FROM workflows WHERE id = ?').get(id) as { id: string } | undefined;
    if (exact) return exact.id;
    const hits = this.db.prepare("SELECT id FROM workflows WHERE id LIKE ? ESCAPE '\\' LIMIT 2")
      .all(likePrefix(id)) as Array<{ id: string }>;
    return hits.length === 1 ? hits[0]!.id : null;
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

  /** Read a single workflow definition (prefix-matched; the exact id first, as in {@link getPlanned}). */
  get(id: string): StoredWorkflow | undefined {
    if (id === '') return undefined; // empty id → likePrefix '%' would match ALL rows
    const row = this.db.prepare(
      "SELECT id, name, description, definition_json, is_template, created_at FROM workflows WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY id = ? DESC LIMIT 1",
    ).get(id, likePrefix(id), id) as {
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
    // The exact id first: a longer id that only starts with it must not answer for it, or a schedule
    // checked and bound to that answer would target another workflow than the one named.
    const row = this.db.prepare(
      "SELECT id, definition_json FROM workflows WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY id = ? DESC LIMIT 1",
    ).get(id, likePrefix(id), id) as { id: string; definition_json: string } | undefined;
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
