import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import { sourceDeletedSql, sourceKeptSql } from './relation-source.js';

/**
 * RelationshipStore — the S1 write/read layer over `relationships`, the typed
 * edges between subjects (Foundation Rework v2). Replaces the legacy
 * `agent-memory.db` `relations` table. `description` is meant to be FILLED (the
 * legacy context-free `relations.description=''` gap is fixed forward here).
 *
 * No encryption: an edge's columns (kind, description, dates) are not PII in the
 * way person email/phone are; if a description ever needs at-rest protection it
 * routes through `EngineDb.enc()` like the SubjectStore detail columns.
 *
 * S1a ships this UNWIRED (the flag-gated wiring lands in S1b).
 *
 * Every read leaves out an edge whose source memory the user deleted
 * (`relation-source.ts`); only the export reads them, marked.
 */

export interface RelationshipRow {
  id: string;
  from_subject_id: string;
  to_subject_id: string;
  kind: string;
  description: string;
  source_memory_id: string | null;
  confidence: number;
  since: string | null;
  until: string | null;
  notes: string | null;
  created_at: string;
}

const KEPT = sourceKeptSql('r');

export class RelationshipStore {
  private readonly db: Database.Database;

  constructor(engine: EngineDb) {
    this.db = engine.getDb();
  }

  /**
   * Create an edge. Idempotent on the (from, kind, to) triple — re-asserting an
   * existing edge updates its description/confidence rather than duplicating it
   * (matches the legacy upsert-on-triple semantics + the conflict-detector's
   * "same triple twice" expectation).
   *
   * An edge keeps one source, and its description stays with that source, so
   * deleting the memory that wrote a description hides it:
   * - a re-assert from another memory takes the edge over, its description
   *   replacing the old one even when empty;
   * - an edge without a source (CRM, backfill) is not taken over by a memory, and
   *   its description stays as it was;
   * - a re-assert without a source (CRM) makes a sourced edge sourceless, with the
   *   re-assert's own description: the memory no longer decides whether it shows.
   *
   * `fillOnly` leaves an edge that already has a source untouched — for a backfill,
   * which carries no source and must not strip one from an edge written with it. A
   * sourceless edge it still updates as above, so its rows of one triple keep the
   * last filled description.
   */
  createRelationship(params: {
    id?: string | undefined;
    fromSubjectId: string;
    toSubjectId: string;
    kind: string;
    description?: string | undefined;
    sourceMemoryId?: string | undefined;
    confidence?: number | undefined;
    since?: string | undefined;
    until?: string | undefined;
    notes?: string | undefined;
    fillOnly?: boolean | undefined;
  }): string {
    const existing = this.db.prepare(`
      SELECT id, source_memory_id FROM relationships
      WHERE from_subject_id = ? AND to_subject_id = ? AND kind = ?
      LIMIT 1
    `).get(params.fromSubjectId, params.toSubjectId, params.kind) as
      { id: string; source_memory_id: string | null } | undefined;

    if (existing && params.fillOnly && existing.source_memory_id !== null) return existing.id;
    if (existing) {
      const prev = existing.source_memory_id;
      const next = params.sourceMemoryId ?? null;
      const given = params.description ?? '';
      // null keeps the stored description.
      let description: string | null;
      if (prev === null && next !== null) description = null;
      else if (prev !== next) description = given;
      else description = given === '' ? null : given;
      this.db.prepare(`
        UPDATE relationships
        SET description = COALESCE(?, description), source_memory_id = ?,
            confidence = COALESCE(?, confidence),
            since = COALESCE(?, since), until = COALESCE(?, until), notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(
        description, prev === null ? null : next, params.confidence ?? null,
        params.since ?? null, params.until ?? null, params.notes ?? null, existing.id,
      );
      return existing.id;
    }

    const id = params.id ?? randomUUID();
    this.db.prepare(`
      INSERT INTO relationships (id, from_subject_id, to_subject_id, kind, description,
        source_memory_id, confidence, since, until, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.fromSubjectId, params.toSubjectId, params.kind,
      params.description ?? '', params.sourceMemoryId ?? null,
      params.confidence ?? 1.0, params.since ?? null, params.until ?? null, params.notes ?? null,
    );
    return id;
  }

  /** Outgoing edges from a subject, optionally filtered by kind. */
  getRelationshipsFrom(subjectId: string, kind?: string | undefined): RelationshipRow[] {
    if (kind) {
      return this.db.prepare(`SELECT r.* FROM relationships r WHERE r.from_subject_id = ? AND r.kind = ? AND ${KEPT}`)
        .all(subjectId, kind) as RelationshipRow[];
    }
    return this.db.prepare(`SELECT r.* FROM relationships r WHERE r.from_subject_id = ? AND ${KEPT}`).all(subjectId) as RelationshipRow[];
  }

  /** Incoming edges to a subject, optionally filtered by kind. */
  getRelationshipsTo(subjectId: string, kind?: string | undefined): RelationshipRow[] {
    if (kind) {
      return this.db.prepare(`SELECT r.* FROM relationships r WHERE r.to_subject_id = ? AND r.kind = ? AND ${KEPT}`)
        .all(subjectId, kind) as RelationshipRow[];
    }
    return this.db.prepare(`SELECT r.* FROM relationships r WHERE r.to_subject_id = ? AND ${KEPT}`).all(subjectId) as RelationshipRow[];
  }

  /**
   * All edges touching a subject, either direction. With `limit`, returns the
   * newest `limit` edges (`ORDER BY created_at DESC LIMIT ?`) — matching the legacy
   * `agent-memory.db getEntityRelations` cap so the read-migration is result-faithful
   * and a hub entity can't materialize unbounded edges.
   */
  getRelationshipsForSubject(subjectId: string, limit?: number | undefined): RelationshipRow[] {
    if (limit !== undefined) {
      return this.db.prepare(
        `SELECT r.* FROM relationships r WHERE (r.from_subject_id = ? OR r.to_subject_id = ?) AND ${KEPT} ORDER BY r.created_at DESC LIMIT ?`,
      ).all(subjectId, subjectId, limit) as RelationshipRow[];
    }
    return this.db.prepare(`SELECT r.* FROM relationships r WHERE (r.from_subject_id = ? OR r.to_subject_id = ?) AND ${KEPT}`)
      .all(subjectId, subjectId) as RelationshipRow[];
  }

  /**
   * {@link getRelationshipsForSubject} for the data export: the edges of a deleted
   * source included and marked, since what is still stored belongs in the export
   * until the reap removes it.
   */
  getRelationshipsForSubjectForExport(subjectId: string, limit: number): Array<RelationshipRow & { source_deleted: 0 | 1 }> {
    return this.db.prepare(
      `SELECT r.*, CASE WHEN ${sourceDeletedSql('r')} THEN 1 ELSE 0 END AS source_deleted FROM relationships r
       WHERE r.from_subject_id = ? OR r.to_subject_id = ? ORDER BY r.created_at DESC LIMIT ?`,
    ).all(subjectId, subjectId, limit) as Array<RelationshipRow & { source_deleted: 0 | 1 }>;
  }

  /** The most-recently-created relationships, capped — the edge set for the graph subgraph. */
  listRecent(limit: number): RelationshipRow[] {
    return this.db.prepare(
      `SELECT r.* FROM relationships r WHERE ${KEPT} ORDER BY r.created_at DESC LIMIT ?`,
    ).all(limit) as RelationshipRow[];
  }

  /** Total edge count. */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM relationships r WHERE ${KEPT}`).get() as { n: number }).n;
  }
}
