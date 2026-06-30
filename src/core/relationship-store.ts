import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';

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
  }): string {
    const existing = this.db.prepare(`
      SELECT id FROM relationships
      WHERE from_subject_id = ? AND to_subject_id = ? AND kind = ?
      LIMIT 1
    `).get(params.fromSubjectId, params.toSubjectId, params.kind) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE relationships
        SET description = COALESCE(NULLIF(?, ''), description),
            confidence = ?, source_memory_id = COALESCE(?, source_memory_id),
            since = COALESCE(?, since), until = COALESCE(?, until), notes = COALESCE(?, notes)
        WHERE id = ?
      `).run(
        params.description ?? '', params.confidence ?? 1.0,
        params.sourceMemoryId ?? null, params.since ?? null, params.until ?? null,
        params.notes ?? null, existing.id,
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
      return this.db.prepare('SELECT * FROM relationships WHERE from_subject_id = ? AND kind = ?')
        .all(subjectId, kind) as RelationshipRow[];
    }
    return this.db.prepare('SELECT * FROM relationships WHERE from_subject_id = ?').all(subjectId) as RelationshipRow[];
  }

  /** Incoming edges to a subject, optionally filtered by kind. */
  getRelationshipsTo(subjectId: string, kind?: string | undefined): RelationshipRow[] {
    if (kind) {
      return this.db.prepare('SELECT * FROM relationships WHERE to_subject_id = ? AND kind = ?')
        .all(subjectId, kind) as RelationshipRow[];
    }
    return this.db.prepare('SELECT * FROM relationships WHERE to_subject_id = ?').all(subjectId) as RelationshipRow[];
  }

  /** All edges touching a subject, either direction. */
  getRelationshipsForSubject(subjectId: string): RelationshipRow[] {
    return this.db.prepare('SELECT * FROM relationships WHERE from_subject_id = ? OR to_subject_id = ?')
      .all(subjectId, subjectId) as RelationshipRow[];
  }
}
