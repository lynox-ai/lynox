import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';

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
 * migration reconciles the two stores trivially. The stub carries NO embedding
 * (engine.db is not the retrieval store yet) and intentionally leaves
 * `source_thread_id` NULL — that column is a REAL FK to engine.db `threads`,
 * which the thread spine does not populate until S2; writing a live thread id
 * here would violate the FK.
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
  }): void {
    this.db.prepare(`
      INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id,
        source_run_id, source_type, source_tool_name, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        subject_id = COALESCE(excluded.subject_id, subject_id),
        updated_at = datetime('now')
    `).run(
      params.id, this.engine.enc(params.text), params.namespace, params.subjectId ?? null,
      params.scopeType, params.scopeId,
      params.sourceRunId ?? null,
      params.sourceType ?? 'agent_inferred',
      params.sourceToolName ?? null,
      params.provider ?? null,
    );
  }

  /**
   * Link a memory to the subjects it mentions (the `memory_subjects` junction,
   * the subject-graph successor to legacy `mentions`). Idempotent on
   * (memory_id, subject_id). The stub for `memoryId` must exist first (FK).
   */
  linkSubjects(memoryId: string, subjectIds: Iterable<string>, mentionType = 'direct'): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_subjects (memory_id, subject_id, mention_type)
      VALUES (?, ?, ?)
    `);
    for (const sid of subjectIds) stmt.run(memoryId, sid, mentionType);
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

  /** Read a stub (test/inspection helper). */
  getStub(id: string): { id: string; subject_id: string | null; is_active: number; superseded_by: string | null } | null {
    return this.db.prepare('SELECT id, subject_id, is_active, superseded_by FROM memories WHERE id = ?')
      .get(id) as { id: string; subject_id: string | null; is_active: number; superseded_by: string | null } | undefined ?? null;
  }

  /** Subjects linked to a memory (test/inspection helper). */
  getLinkedSubjectIds(memoryId: string): string[] {
    return (this.db.prepare('SELECT subject_id FROM memory_subjects WHERE memory_id = ?')
      .all(memoryId) as Array<{ subject_id: string }>).map(r => r.subject_id);
  }
}
