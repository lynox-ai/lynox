import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { MemoryRow, ScoredMemoryRow } from './agent-memory-db.js';
import { blobToEmbed, cosineSimilarity } from './embedding.js';

/** The columns {@link MemoryGraphStore.getStub} reads back (test/inspection). */
export interface MemoryStubRow {
  id: string;
  subject_id: string | null;
  is_active: number;
  superseded_by: string | null;
}

/**
 * The at-rest ciphertext marker — mirrors `ENCRYPTED_PREFIX` in engine-db.ts.
 * `EngineDb.dec()` returns its input UNCHANGED when it can't decrypt (keyless /
 * browse-mode, or wrong key / corrupt), so a row whose decrypted text is
 * byte-identical to a still-prefixed ciphertext was NOT decryptable and must be
 * skipped on recall — never surface an `enc:` blob into agent context (S5b §6).
 */
const ENC_PREFIX = 'enc:';

/**
 * The exhaustive dedup scan cap — parity with `DEDUP_EXHAUSTIVE_SCAN_LIMIT` in
 * agent-memory-db.ts. The S5b'-a write-cutover's dedup read raises the pre-cosine
 * scan to this (vs the retrieval window) so an older near-duplicate deep in a
 * scope is still caught — else a re-stated fact is stored twice. Still capped (not
 * unbounded) to bound per-store() cost on a ceiling-less scope like `global`.
 */
const DEDUP_EXHAUSTIVE_SCAN_LIMIT = 5_000;

/**
 * The engine.db `memories` columns the S5b recall reads project — every field a
 * downstream {@link MemoryRow} carries EXCEPT the legacy-only `source_episode_id`
 * (engine.db tracks `source_thread_id`, not episodes; recall never reads it). Kept
 * as one list so the four recall SELECTs stay column-consistent.
 */
const RECALL_COLS =
  'id, text, namespace, scope_type, scope_id, source_run_id, provider, embedding, ' +
  'confidence, is_active, superseded_by, retrieval_count, confirmation_count, ' +
  'last_retrieved_at, created_at, updated_at, source_type, source_tool_name';

/** Same column list, `m.`-qualified for the graph-expand JOINs. */
const RECALL_COLS_M = RECALL_COLS.split(', ').map(c => `m.${c}`).join(', ');

/** Raw engine.db memory row (text still enc'd) — decrypted by {@link MemoryGraphStore._decRow}. */
interface EngineMemoryRaw {
  id: string;
  text: string;
  namespace: string;
  scope_type: string;
  scope_id: string;
  source_run_id: string | null;
  provider: string | null;
  embedding: Buffer | null;
  confidence: number;
  is_active: number;
  superseded_by: string | null;
  retrieval_count: number;
  confirmation_count: number;
  last_retrieved_at: string | null;
  created_at: string;
  updated_at: string;
  source_type: string;
  source_tool_name: string | null;
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
    // S5b recall-parity additions. RECALL scoring reads `created_at` (time-decay)
    // and `confirmation_count` (confirmed memories score higher), so a stub that
    // took the write-time default for these would re-rank recall — badly for the
    // BACKFILL, which would otherwise reset every historical memory to backfill-time
    // + zero confirmations. `createdAt` is IMMUTABLE (creation time, never rewritten
    // on a re-upsert); `confirmationCount` preserves-on-omit like confidence. On a
    // fresh insert an omitted `createdAt` takes datetime('now') and an omitted
    // `confirmationCount` takes 0.
    createdAt?: string | undefined;
    confirmationCount?: number | undefined;
  }): void {
    // Preserve-on-omit for all four S5a fields (an omitted field keeps the stored
    // value on a re-upsert; a fresh insert takes the column default). `embedding`
    // and `superseded_by` are plain `?` in VALUES, so `excluded.*` faithfully
    // reflects NULL-on-omit and preserves like the adjacent `subject_id` line.
    // `is_active`/`confidence` COALESCE to their default in VALUES (so a fresh NULL
    // still satisfies NOT NULL), which makes `excluded.*` non-NULL — so those two,
    // and only those two, are re-bound raw in the ON CONFLICT to preserve on omit.
    // `created_at` is intentionally ABSENT from the ON CONFLICT SET list — creation
    // time is immutable, so a re-upsert preserves it without a re-bind. The other
    // COALESCE'd-in-VALUES columns (is_active/confidence/confirmation_count) re-bind
    // raw in ON CONFLICT to preserve-on-omit.
    this.db.prepare(`
      INSERT INTO memories (id, text, namespace, subject_id, scope_type, scope_id,
        source_run_id, source_type, source_tool_name, provider,
        embedding, is_active, superseded_by, confidence, confirmation_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1), ?, COALESCE(?, 0.75),
        COALESCE(?, 0), COALESCE(?, datetime('now')))
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        subject_id = COALESCE(excluded.subject_id, subject_id),
        embedding = COALESCE(excluded.embedding, embedding),
        is_active = COALESCE(?, is_active),
        superseded_by = COALESCE(excluded.superseded_by, superseded_by),
        confidence = COALESCE(?, confidence),
        confirmation_count = COALESCE(?, confirmation_count),
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
      params.confirmationCount ?? null,
      params.createdAt ?? null,
      // ON CONFLICT re-binds — only the COALESCE'd-in-VALUES columns need it:
      params.isActive ?? null,
      params.confidence ?? null,
      params.confirmationCount ?? null,
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
   * Mirror a dedup/feedback CONFIRMATION — bumps confirmation_count + confidence
   * exactly like legacy {@link AgentMemoryDb.confirmMemory} (+1 / +0.05 capped at 1).
   * A plain UPDATE that no-ops when the memory has no stub (created before the mirror
   * was on, or not yet backfilled). RECALL scores by both fields, so without this
   * mirror a re-confirmed memory would rank LOWER on the engine.db path than on legacy
   * — breaking S5b recall equivalence. Fires on the MIRROR gate (dual-write), so the
   * confirmation history is present by the time reads flip on.
   */
  bumpConfirmation(memoryId: string): void {
    this.db.prepare(`
      UPDATE memories
      SET confirmation_count = confirmation_count + 1,
          confidence = MIN(confidence + 0.05, 1.0),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(memoryId);
  }

  /**
   * Mirror a negative-feedback PENALTY — drops confidence like legacy
   * {@link AgentMemoryDb.penalizeMemory} (−0.1, floored at 0.1). Same recall-parity
   * rationale + no-op-on-missing-stub behaviour as {@link bumpConfirmation}.
   */
  penalizeConfidence(memoryId: string): void {
    this.db.prepare(`
      UPDATE memories
      SET confidence = MAX(confidence - 0.1, 0.1),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(memoryId);
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

  // ── S5b'-c lifecycle (engine.db) ──────────────────────────────
  // The DELETE side of the memory cutover. Under the mirror flag the engine.db stub
  // store is the authoritative RECALL source, so a thread-purge (privacy) and a
  // dead-stub GC must reap it too — else purged/superseded content lingers in the
  // recall store. Both delete `memories` rows ONLY; the schema's ON DELETE CASCADE
  // reaps memory_subjects + supersedes + conflicts, and relationships.source_memory_id
  // SET-NULLs — a cross-thread SUBJECT is never touched (the cascade runs
  // memory→junction, not junction→subject), so durable subjects survive. A subject
  // left with no memory is NOT reaped here: subjects are durable substrate referenced
  // across the verb layer (tasks/triggers/connections/threads/artifacts), so an
  // orphan-subject sweep is a deferred slice gated on the subject-lifecycle design,
  // not a mechanical port of the legacy orphan-entity delete.

  /**
   * Delete memory stubs by id — the S5b'-c thread-purge via id-parity (a stub shares
   * the legacy memory id). The caller passes the thread's ids read from the legacy
   * store (which owns `source_thread_id`; engine.db's column is NULL-by-design until
   * the S5b'-d thread-spine cutover). Chunked under SQLite's 999-variable limit; one
   * transaction (atomic per purge). Returns the number of stubs deleted.
   */
  purgeMemories(ids: string[]): number {
    if (ids.length === 0) return 0;
    return this.db.transaction(() => {
      let deleted = 0;
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        deleted += this.db.prepare(
          `DELETE FROM memories WHERE id IN (${placeholders})`,
        ).run(...chunk).changes;
      }
      return deleted;
    })();
  }

  /**
   * Delete superseded/inactive stubs (`is_active = 0`) — the engine.db port of the
   * legacy {@link AgentMemoryDb.gc} memory sweep. Cascades reap the children.
   * Returns the number of stubs deleted.
   */
  gcInactiveStubs(): number {
    return this.db.prepare('DELETE FROM memories WHERE is_active = 0').run().changes;
  }

  // ── S5b recall reads (engine.db) ──────────────────────────────
  // The READ side of the memory cutover: these mirror the legacy AgentMemoryDb
  // recall queries (findSimilarMemories / listActiveMemories / graph-expand) over
  // engine.db `memories` + `memory_subjects` + `relationships`, returning the SAME
  // MemoryRow / ScoredMemoryRow shapes so RetrievalEngine's scoring/MMR pipeline is
  // unchanged. Gated behind `memory_graph_reads` at the call site; the WRITE path
  // (dual-write) stays legacy through S5b'. `text` is decrypted per row; `embedding`
  // is a raw BLOB (never enc'd), passed through untouched for the caller's
  // blobToEmbed. Legacy `getMemoriesMentioningEntity`/`getRelatedMemoriesViaEntities`
  // become `...Subject`/`...Subjects` (memory↔entity → memory↔subject).

  /**
   * Decrypt a raw row's text and shape it into a legacy {@link MemoryRow}. Returns
   * null when the ciphertext could NOT be decrypted (keyless store or wrong key) so
   * the caller drops it — recall must never surface an `enc:` blob into agent context.
   * On a KEYED store a successfully decrypted plaintext differs from its ciphertext
   * even when it also starts with `enc:`, so a legitimate memory is never dropped.
   * Trade-off: on a KEYLESS store, a plaintext literally starting with `enc:` (which,
   * keyless, was stored verbatim) is indistinguishable from orphaned ciphertext and is
   * dropped — a security-first choice (never leak ciphertext) over recalling one
   * pathological browse-mode string. In a real keyed deployment this case cannot arise.
   */
  private _decRow(raw: EngineMemoryRaw): MemoryRow | null {
    const text = this.engine.dec(raw.text);
    if (raw.text.startsWith(ENC_PREFIX) && text === raw.text) return null;
    return {
      id: raw.id, text, namespace: raw.namespace,
      scope_type: raw.scope_type, scope_id: raw.scope_id,
      source_run_id: raw.source_run_id,
      source_episode_id: null,
      provider: raw.provider, embedding: raw.embedding,
      confidence: raw.confidence, is_active: raw.is_active,
      superseded_by: raw.superseded_by, retrieval_count: raw.retrieval_count,
      confirmation_count: raw.confirmation_count,
      last_retrieved_at: raw.last_retrieved_at,
      created_at: raw.created_at, updated_at: raw.updated_at,
      source_type: raw.source_type, source_tool_name: raw.source_tool_name,
    };
  }

  /**
   * Cosine-similarity recall over engine.db memory embeddings — the port of
   * {@link AgentMemoryDb.findSimilarMemories}. SAME scan-cap, SAME filters, SAME
   * min-heap top-K prune. Embeddings are scored FIRST (no decrypt); only the top-K
   * survivors are decrypted, and any undecryptable survivor is dropped. With
   * `exhaustive: true` (the S5b'-a dedup path) the pre-cosine scan cap rises to
   * {@link DEDUP_EXHAUSTIVE_SCAN_LIMIT} — parity with legacy dedup — so an older
   * near-duplicate past the retrieval window is still found.
   */
  findSimilarRecall(
    embedding: number[],
    dim: number,
    topK: number,
    threshold: number,
    filters?: {
      namespace?: string | undefined;
      scopeTypes?: string[] | undefined;
      scopeIds?: string[] | undefined;
      activeOnly?: boolean | undefined;
      exhaustive?: boolean | undefined;
    },
  ): ScoredMemoryRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters?.activeOnly !== false) clauses.push('is_active = 1');
    if (filters?.namespace) {
      clauses.push('namespace = ?');
      params.push(filters.namespace);
    }
    if (filters?.scopeTypes && filters.scopeTypes.length > 0) {
      clauses.push(`scope_type IN (${filters.scopeTypes.map(() => '?').join(',')})`);
      params.push(...filters.scopeTypes);
    }
    if (filters?.scopeIds && filters.scopeIds.length > 0) {
      clauses.push(`scope_id IN (${filters.scopeIds.map(() => '?').join(',')})`);
      params.push(...filters.scopeIds);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Scan-cap PARITY with legacy: the retrieval window `min(max(topK*10,100),500)`
    // newest-by-created_at, OR the raised dedup ceiling when exhaustive (so an older
    // near-duplicate deep in the scope is still caught on the write path).
    const sqlLimit = filters?.exhaustive === true
      ? DEDUP_EXHAUSTIVE_SCAN_LIMIT
      : Math.min(Math.max(topK * 10, 100), 500);
    params.push(sqlLimit);
    // Secondary `id DESC` tie-break: among same-`created_at` rows the LIMIT window
    // boundary would otherwise resolve by each DB's differing rowid/insert order, so
    // a scope with timestamp collisions at the cap could window a DIFFERENT candidate
    // set on engine.db vs legacy — breaking dedup/contradiction equivalence. ids are
    // parity across the two stores, so ordering by id makes the boundary deterministic
    // and identical (must match legacy findSimilarMemories, which tie-breaks the same).
    const rows = this.db.prepare(
      `SELECT ${RECALL_COLS} FROM memories ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...params) as EngineMemoryRaw[];

    const expectedBlobLen = dim * 8;
    const scoredRaw: Array<{ raw: EngineMemoryRaw; sim: number }> = [];
    let minScore = threshold;
    for (const raw of rows) {
      if (!raw.embedding || raw.embedding.length !== expectedBlobLen) continue;
      const memEmb = blobToEmbed(raw.embedding, dim);
      const sim = cosineSimilarity(embedding, memEmb);
      if (sim < minScore) continue;
      scoredRaw.push({ raw, sim });
      if (scoredRaw.length > topK * 2) {
        scoredRaw.sort((a, b) => b.sim - a.sim);
        scoredRaw.length = topK;
        minScore = scoredRaw[scoredRaw.length - 1]!.sim;
      }
    }
    scoredRaw.sort((a, b) => b.sim - a.sim);

    const out: ScoredMemoryRow[] = [];
    for (const { raw, sim } of scoredRaw.slice(0, topK)) {
      const row = this._decRow(raw);
      if (!row) continue;
      (row as ScoredMemoryRow)._similarity = sim;
      out.push(row as ScoredMemoryRow);
    }
    return out;
  }

  /**
   * The no-query recency list — port of {@link AgentMemoryDb.listActiveMemories}
   * (is_active=1, namespace, scope-pair OR, newest-first, bounded limit).
   */
  listRecentActiveRecall(
    namespace: string,
    scopes: Array<{ type: string; id: string }>,
    limit = 50,
  ): MemoryRow[] {
    if (scopes.length === 0) return [];
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.floor(limit), 1), 500)
      : 50;
    const scopeClauses = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    const params: unknown[] = [namespace];
    for (const s of scopes) { params.push(s.type, s.id); }
    params.push(safeLimit);
    const rows = this.db.prepare(
      `SELECT ${RECALL_COLS} FROM memories
       WHERE is_active = 1 AND namespace = ? AND (${scopeClauses})
       ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as EngineMemoryRaw[];
    return this._decRows(rows);
  }

  /**
   * Memories directly mentioning a subject — port of
   * {@link AgentMemoryDb.getMemoriesMentioningEntity} over the `memory_subjects`
   * junction (idx_memory_subjects_subject).
   */
  memoriesMentioningSubject(subjectId: string, activeOnly = true, limit = 10): MemoryRow[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const activeClause = activeOnly ? 'AND m.is_active = 1' : '';
    const rows = this.db.prepare(`
      SELECT ${RECALL_COLS_M} FROM memories m
      JOIN memory_subjects ms ON m.id = ms.memory_id
      WHERE ms.subject_id = ? ${activeClause}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(subjectId, safeLimit) as EngineMemoryRaw[];
    return this._decRows(rows);
  }

  /**
   * Memories related to a subject via ONE relationship hop — port of
   * {@link AgentMemoryDb.getRelatedMemoriesViaEntities} (2-hop) over `relationships`
   * (idx_rel_from/idx_rel_to). Subject-dedup (two legacy entities collapsed to one
   * subject) may surface a strict superset of the legacy per-entity expand — more
   * complete, not a regression.
   */
  relatedMemoriesViaSubjects(subjectId: string, activeOnly = true, limit = 5): MemoryRow[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const activeClause = activeOnly ? 'AND m.is_active = 1' : '';
    const rows = this.db.prepare(`
      SELECT DISTINCT ${RECALL_COLS_M} FROM memories m
      JOIN memory_subjects ms ON m.id = ms.memory_id
      JOIN relationships r ON (ms.subject_id = r.from_subject_id OR ms.subject_id = r.to_subject_id)
      WHERE (r.from_subject_id = ? OR r.to_subject_id = ?)
        AND ms.subject_id != ?
        ${activeClause}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(subjectId, subjectId, subjectId, safeLimit) as EngineMemoryRaw[];
    return this._decRows(rows);
  }

  /** Decrypt a batch, dropping undecryptable rows (see {@link _decRow}). */
  private _decRows(rows: EngineMemoryRaw[]): MemoryRow[] {
    const out: MemoryRow[] = [];
    for (const raw of rows) {
      const row = this._decRow(raw);
      if (row) out.push(row);
    }
    return out;
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
