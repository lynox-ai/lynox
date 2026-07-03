import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';

/** The columns {@link MemoryGraphStore.getStub} reads back (test/inspection). */
export interface MemoryStubRow {
  id: string;
  subject_id: string | null;
  is_active: number;
  superseded_by: string | null;
}

/**
 * MemoryGraphStore — the S1b memory-provenance layer over engine.db: a
 * lightweight `memories` STUB + the `memory_subjects` mention junction + the
 * derived `subject_cooccurrences` counts. It anchors the subject-graph to the
 * evidence that produced it (which memory mentioned which subject, and each
 * memory's primary subject) WITHOUT moving the vector-retrieval substrate —
 * embeddings, dedup, and contradiction detection stay on agent-memory.db
 * through S1 (the memory-consolidation sprint moves those).
 *
 * id-PARITY: a stub shares the agent-memory.db memory id, so the S2 data
 * migration reconciles the two stores trivially. Since S5a the stub CARRIES the
 * embedding BLOB (the live mirror passes it; the backfill copies the legacy Buffer
 * byte-for-byte) so the S5b vector-recall cutover can retrieve over engine.db. It
 * intentionally leaves `source_thread_id` NULL — that column is a REAL FK to
 * engine.db `threads`, which the thread spine does not populate until S2; writing a
 * live thread id here would violate the FK.
 *
 * Written ADDITIVELY behind `subject_graph_enabled`; nothing reads engine.db
 * memories until the read-migration (S1d) + the memory sprint (S5).
 */
export class MemoryGraphStore {
  private readonly db: Database.Database;

  constructor(private readonly engine: EngineDb) {
    this.db = engine.getDb();
  }

  /**
   * Upsert a memory provenance stub. `id` is the SAME id as the legacy
   * agent-memory.db memory (id-parity). Idempotent on id — a re-store updates
   * the text and fills `subject_id` (never overwriting a set primary with NULL),
   * and never duplicates. `source_run_id` is a soft cross-file ref (history.db);
   * `source_thread_id` stays NULL by design (see class doc).
   *
   * `text` is encrypted at rest (the S0 boundary: memories.text is PII-bearing —
   * customer data flows through memory). Mixed-mode-safe: no key → plaintext.
   */
  upsertStub(params: {
    id: string;
    text: string;
    namespace: string;
    scopeType: string;
    scopeId: string;
    subjectId?: string | null | undefined;
    sourceRunId?: string | null | undefined;
    sourceType?: string | undefined;
    sourceToolName?: string | null | undefined;
    provider?: string | null | undefined;
    // S5a memory-consolidation additions. The live mirror passes `embedding` (so
    // engine.db carries the vector for the S5b recall cutover); the backfill also
    // carries is_active / superseded_by / confidence so a superseded or reweighted
    // legacy memory lands in the exact same lifecycle state. All optional — on a
    // FRESH insert an omitted field takes the column DEFAULT (embedding NULL,
    // is_active 1, superseded_by NULL, confidence 0.75); on a re-upsert an omitted
    // field is PRESERVED (never reset), so a bare re-store can't silently revive a
    // superseded stub or drop its vector. Existing S1b callers are unchanged.
    embedding?: Buffer | null | undefined;
    isActive?: number | undefined;
    supersededBy?: string | null | undefined;
    confidence?: number | undefined;
  }): void {
    // Preserve-on-omit for all four S5a fields (an omitted field keeps the stored
    // value on a re-upsert; a fresh insert takes the column default). `embedding`
    // and `superseded_by` are plain `?` in VALUES, so `excluded.*` faithfully
    // reflects NULL-on-omit and preserves like the adjacent `subject_id` line.
    // `is_active`/`confidence` COALESCE to their default in VALUES (so a fresh NULL
    // still satisfies NOT NULL), which makes `excluded.*` non-NULL — so those two,
    // and only those two, are re-bound raw in the ON CONFLICT to preserve on omit.
    this.db.prepare(`
      INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id,
        source_run_id, source_type, source_tool_name, provider,
        embedding, is_active, superseded_by, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, COALESCE(?, 0.75))
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        subject_id = COALESCE(excluded.subject_id, subject_id),
        embedding = COALESCE(excluded.embedding, embedding),
        is_active = COALESCE(?, is_active),
        superseded_by = COALESCE(excluded.superseded_by, superseded_by),
        confidence = COALESCE(?, confidence),
        updated_at = datetime('now')
    `).run(
      params.id, this.engine.enc(params.text), params.namespace, params.subjectId ?? null,
      params.scopeType, params.scopeId,
      params.sourceRunId ?? null,
      params.sourceType ?? 'agent_inferred',
      params.sourceToolName ?? null,
      params.provider ?? null,
      params.embedding ?? null,
      params.isActive ?? null,
      params.supersededBy ?? null,
      params.confidence ?? null,
      // ON CONFLICT re-binds — only the two COALESCE'd-in-VALUES columns need it:
      params.isActive ?? null,
      params.confidence ?? null,
    );
  }

  /**
   * Link a memory to the subjects it mentions (the `memory_subjects` junction,
   * the subject-graph successor to legacy `mentions`). Idempotent on
   * (memory_id, subject_id). The stub for `memoryId` must exist first (FK).
   */
  linkSubjects(memoryId: string, subjectIds: Iterable<string>): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_subjects (memory_id, subject_id)
      VALUES (?, ?)
    `);
    for (const sid of subjectIds) stmt.run(memoryId, sid);
  }

  /**
   * Bump pairwise co-occurrence counts for every subject co-mentioned in one
   * memory. Canonical (a < b) ordering collapses (X,Y)/(Y,X) onto one row,
   * matching legacy `updateCooccurrencesBatch`. De-dups the input first.
   */
  bumpCooccurrences(subjectIds: string[]): void {
    const unique = [...new Set(subjectIds)];
    if (unique.length < 2) return;
    const stmt = this.db.prepare(`
      INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id, count, last_seen_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(subject_a_id, subject_b_id)
      DO UPDATE SET count = count + 1, last_seen_at = datetime('now')
    `);
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [a, b] = unique[i]! < unique[j]! ? [unique[i]!, unique[j]!] : [unique[j]!, unique[i]!];
        stmt.run(a, b);
      }
    }
  }

  /**
   * Mirror a supersession marker — the new memory replaces the old. A plain
   * UPDATE: it no-ops harmlessly when the old memory has no stub (e.g. it was
   * first stored before the flag was on), so it can never reference a missing
   * row. The `supersedes` provenance junction is intentionally NOT mirrored in
   * S1b (its FK needs both stubs present); S2 recomputes it authoritatively.
   */
  markSuperseded(memoryId: string, supersededById: string): void {
    this.db.prepare(`
      UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(supersededById, memoryId);
  }

  /**
   * Record a supersession provenance edge (the `supersedes` junction, the S2/S5
   * successor to legacy `supersedes`). Idempotent on the (new, old) pair. Both
   * memory stubs must exist — the guarded INSERT skips a pair whose endpoints are
   * missing rather than tripping the FK (a legacy junction row can outlive a GC'd
   * memory). Used by the S5a backfill AFTER every stub is written. Returns the
   * rows actually inserted (0 when an endpoint is missing or the pair already
   * exists), so the caller counts only genuinely-replayed edges.
   */
  recordSupersedes(newMemoryId: string, oldMemoryId: string, reason: string): number {
    return this.db.prepare(`
      INSERT OR IGNORE INTO supersedes (new_memory_id, old_memory_id, reason)
      SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?)
        AND EXISTS (SELECT 1 FROM memories WHERE id = ?)
    `).run(newMemoryId, oldMemoryId, reason, newMemoryId, oldMemoryId).changes;
  }

  /**
   * Rebuild `subject_cooccurrences` DETERMINISTICALLY from the `memory_subjects`
   * junction — a full DELETE + re-aggregate, NOT the per-memory increment
   * ({@link bumpCooccurrences}). subject_cooccurrences is a DERIVED materialization
   * (its only writer is the co-mention count), so a rebuild is authoritative and,
   * crucially, IDEMPOTENT: the S5a backfill can re-run without doubling counts the
   * way a replayed increment would. The (a < b) join key keeps the canonical
   * ordering the increment path uses. Call once at the end of the memory backfill.
   */
  rebuildCooccurrences(): void {
    this.db.prepare('DELETE FROM subject_cooccurrences').run();
    this.db.prepare(`
      INSERT INTO subject_cooccurrences (subject_a_id, subject_b_id, count, last_seen_at)
      SELECT ms1.subject_id, ms2.subject_id, COUNT(*), datetime('now')
      FROM memory_subjects ms1
      JOIN memory_subjects ms2
        ON ms1.memory_id = ms2.memory_id AND ms1.subject_id < ms2.subject_id
      GROUP BY ms1.subject_id, ms2.subject_id
    `).run();
  }

  /** Read a stub (test/inspection helper). */
  getStub(id: string): MemoryStubRow | null {
    return this.db.prepare('SELECT id, subject_id, is_active, superseded_by FROM memories WHERE id = ?')
      .get(id) as MemoryStubRow | undefined ?? null;
  }

  /** Subjects linked to a memory (test/inspection helper). */
  getLinkedSubjectIds(memoryId: string): string[] {
    return (this.db.prepare('SELECT subject_id FROM memory_subjects WHERE memory_id = ?')
      .all(memoryId) as Array<{ subject_id: string }>).map(r => r.subject_id);
  }
}
