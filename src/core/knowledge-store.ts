import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { SubjectStore, SubjectKind, SubjectRow } from './subject-store.js';
import { canSupersede, deriveProvenanceTier, provenanceRank } from './provenance.js';
import { subjectsDisagree } from './contradiction-detector.js';
import { maskSecretPatterns, matchesSecretPattern } from './secret-store.js';
import type { ProvenanceKind } from '../types/memory.js';
import type { SecretStoreLike } from '../types/security.js';
import {
  type KnowledgeEntry,
  type KnowledgeKind,
  type KnowledgeStatus,
  type MemoryBlockId,
  type MemoryBlockEditMode,
  MEMORY_BLOCK_CHAR_LIMITS,
  FOCUS_BLOCK_CHAR_LIMIT,
} from '../types/memory.js';

/** Max chars for a single durable knowledge entry — one concise fact. Bounds the at-rest
 *  write against a pathological / injected multi-KB `remember`. Long material belongs in a
 *  document / data_store. Enforced at the tool (friendly reject) AND the store (backstop). */
export const MAX_KNOWLEDGE_ENTRY_CHARS = 8000;

/** Union-coverage bar for write-path dedup: skip a new active write when ≥ this fraction of its
 *  CONTENT tokens are already covered by existing active entries (same subject or same run). 0.7
 *  catches restatements and combinations (whose only uncovered tokens are framing words) while
 *  leaving detail-adding and genuinely-different facts well below the bar. Coverage is measured
 *  over content tokens ONLY (see {@link DEDUP_FUNCTION_WORDS}): a VALUE CORRECTION ("X is in
 *  Winterthur" after "X is located in Zürich") shares the subject + filler words "is/in", which
 *  would inflate raw-token coverage to 0.75 and silently EAT the correction, leaving the stale
 *  fact. Over content tokens the new value ("winterthur") is uncovered → coverage 0.5 → the
 *  correction is written, not dropped. (Superseding the stale entry is the agent's `memory_retire`
 *  job, user-confirmed; dedup must only ever skip a true restatement, never a value change.) */
export const DEDUP_COVERAGE_THRESHOLD = 0.7;

/** Short function words that survive `tokenize` (length > 1, not in STOP_WORDS) but carry no
 *  meaning — they must NOT count toward dedup coverage, or a subject + filler overlap masks a
 *  changed value as a duplicate. Dedup-local (does not affect recall ranking). */
const DEDUP_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'is', 'in', 'on', 'at', 'to', 'of', 'as', 'by', 'or', 'be', 'an', 'its', 'it',
  'im', 'am', 'zu', 'an', 'er', 'es',
]);

/**
 * KnowledgeStore — the Durable Knowledge Substrate (DK.1).
 *
 * The user-owned Know pillar: agent-authored `memory_blocks` (profile/playbook, the
 * always-loaded working set) + an archival `knowledge_entries` store (durable, no
 * eviction). Shares the EngineDb connection (mirror of SubjectStore); reads/writes ONLY
 * when `durable_memory_enabled` is on — the v9 tables exist unconditionally but stay
 * untouched at flag-OFF (byte-identical).
 *
 * Load-bearing invariants (from the PRD gate chain, verified at source):
 *  - **Decoupled (req 2, D-2):** `write` is a DIRECT SQLite insert. It NEVER publishes
 *    `channels.memoryStore`, so the `engine-init.ts` subscription → `knowledgeLayer.store`
 *    → entity/**extraction** minting chain never sees these writes. Subject linking uses
 *    `findOrCreate` DELIBERATELY (H1) — the authored recording IS the salience signal; the
 *    ban is on the extraction *channel*, not on `findOrCreate`.
 *  - **Headless-safe routing (req 3, D-3, H4):** an untrusted turn ROUTES to
 *    `pending_review` (via `sourceUntrusted` → `deriveProvenanceTier` rule 1 →
 *    `external_unverified`), never blocks/drops. The write always lands, visibly, in the
 *    queue. `pending_review` links via `subject_hint` only — `findOrCreate` runs on
 *    approval (DK.2), so a rejected pending entry never leaves a minted empty subject.
 *  - **Trust (req 5, D-6):** `provenance.ts` is the single authority at write + read + the
 *    retire gate. `recall`/`focus` render only `status='active'`. H6: `pinned=1` is a STORE
 *    invariant (the v9 CHECK + the guard here) — only an active, non-`external_unverified`
 *    row may pin, so injected text can never ride into the every-turn `focus` block.
 *  - **Retrieval (D-4):** subject resolved deterministically first (name/alias +
 *    `getAncestors` walk-up), then ranked WITHIN by Unicode-aware token overlap — no cosine,
 *    no embedding index (`text` is enc()'d at rest; the measured 0.83 band adds noise).
 */
export class KnowledgeStore {
  private readonly db: Database.Database;

  /**
   * DK.2 `memory_focus`: a session-scoped subject override for the derived
   * focus block — in-memory only, no DB write; dies with the process. The store
   * is engine-scoped (single-tenant engine, one interactive session), which is
   * the same scope the toolContext itself has. `renderBlocks` uses it as the
   * default when the caller passes no explicit override.
   */
  private _focusOverrideSubjectId: string | null = null;

  constructor(
    private readonly engine: EngineDb,
    private readonly subjects: SubjectStore,
    private readonly secretStore: SecretStoreLike | null = null,
  ) {
    this.db = engine.getDb();
  }

  setFocusOverride(subjectId: string | null): void {
    this._focusOverrideSubjectId = subjectId;
  }

  // ── Tokenizer (H3: Unicode-aware; NOT tokeniseForSupersede's ASCII splitter) ──

  /**
   * Unicode-aware tokenizer for the archival token-overlap rank (H3). NFKD-folds so
   * accented forms match their base, lowercases, and splits on `\p{L}\p{N}` runs so German
   * ("Kündigung"), French, etc. tokenize whole instead of `["k","ndigung"]`. Distinct from
   * the ASCII `tokeniseForSupersede` (`memory.ts`, a supersede-dedup, English stop-words) —
   * this is a relevance ranker over multi-language business text.
   */
  static tokenize(text: string): string[] {
    const folded = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const matches = folded.match(/[\p{L}\p{N}]+/gu);
    if (!matches) return [];
    return matches.filter(t => t.length > 1 && !STOP_WORDS.has(t));
  }

  // ── Write path (req 2/3, D-2/D-3, H1/H4/H6) ──

  /**
   * Record a durable knowledge entry. A direct insert — never publishes
   * `channels.memoryStore`. Trusted turn → `active` (+ deliberate `findOrCreate` subject
   * link, H1); untrusted turn → `pending_review` (+ `subject_hint` only, H4). Pin is a
   * store invariant (H6). Returns the persisted row's routing outcome.
   */
  write(params: KnowledgeWriteParams): KnowledgeWriteResult {
    // Store-level size backstop (defense in depth; the `remember` tool bounds at a lower,
    // friendlier limit first). A single knowledge entry is one concise fact — refuse a
    // pathological / injected multi-KB write at rest rather than bloating engine.db.
    if (params.text.length > MAX_KNOWLEDGE_ENTRY_CHARS) {
      throw new Error(`knowledge entry text is ${params.text.length} chars, over the ${MAX_KNOWLEDGE_ENTRY_CHARS}-char store limit.`);
    }
    const tier = deriveProvenanceTier({
      sourceChannel: params.sourceChannel,
      sourceUntrusted: params.sourceUntrusted,
    });
    // Rule 1 of provenance.ts already maps sourceUntrusted → external_unverified; the routing
    // gate keys off the SAME signal, so an untrusted write is queued, never trusted-written.
    const status: KnowledgeStatus = params.sourceUntrusted === true ? 'pending_review' : 'active';

    let subjectId: string | null = null;
    let subjectHint: string | null = null;
    const name = params.subjectName?.trim();
    if (name) {
      if (status === 'active') {
        // H1: the deliberate authored recording IS the salience signal — findOrCreate, not
        // find-only. Decoupled from the extraction *channel*, not from findOrCreate itself.
        subjectId = this.subjects.findOrCreate({ kind: params.subjectKind ?? 'organization', name }).id;
      } else {
        // Pending-entry hygiene (acceptance §2): link by hint; findOrCreate on approval only,
        // so a rejected queue entry never leaves an empty minted subject behind.
        subjectHint = name;
      }
    }

    // A `subject`-null active write that clearly concerns ONE known subject (its name/alias is
    // mentioned in the text, and that subject already has active entries) is linked to it. The
    // model frequently restates a subjectful fact a second time WITHOUT the subject ("client
    // Ada runs AlphaClinic" after "Ada Fischer: businesses AlphaClinic, BetaStore"); resolving
    // the subject from the text both improves attribution AND lets the dedup below catch the
    // restatement (a cross-turn, subject-null duplicate that neither the subject nor the run
    // clause would otherwise reach). Conservative: only when EXACTLY ONE subject is mentioned.
    if (status === 'active' && !subjectId) {
      const mentioned = this._deriveFocusSubjects(params.text, null, null);
      if (mentioned.length === 1) subjectId = mentioned[0]!;
    }

    // Structural write-path dedup (only for ACTIVE-landing writes). The model, despite the
    // prompt, restates facts it already recorded this turn (a combined "operator has clients A
    // and B" after separate A/B entries) and writes both sides of a same-turn correction. Prompt
    // words did not fix it (measured across prompt v4-v6); this is the structural fix. Only ACTIVE
    // rows are candidates — an untrusted (pending) write is never in the set, so an injected write
    // can neither be a dedup target nor block a later legitimate write.
    if (status === 'active') {
      const dup = this._findActiveDuplicate(params.text, subjectId, params.sourceRunId);
      if (dup) {
        // Pin is a deliberate post-approval act, so a `pin:true` re-assert of an already-
        // stored fact must be able to pin the EXISTING row — otherwise a fact can only ever
        // be pinned on its first write (dedup early-returns before the pin path below, and no
        // other pin-update path exists). An active dup row is pin-eligible by H6; the incoming
        // write is trusted (we are in the status==='active' branch).
        let dupPinned = dup.pinned === 1;
        if (params.pin === true && !dupPinned && (dup.source_type as ProvenanceKind) !== 'external_unverified') {
          this.db.prepare('UPDATE knowledge_entries SET pinned = 1 WHERE id = ?').run(dup.id);
          dupPinned = true;
        }
        return { id: dup.id, status: 'active', tier: dup.source_type as ProvenanceKind, subjectId: dup.subject_id, pinned: dupPinned, deduped: true };
      }
    }

    // H6: pin is a store invariant. Only an active, non-external_unverified row may pin —
    // enforced here AND by the v9 CHECK (defense in depth). An injected `pin:true` on an
    // untrusted turn is silently downgraded to unpinned (the write still lands, in the queue).
    const pinned = params.pin === true && status === 'active' && tier !== 'external_unverified' ? 1 : 0;

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO knowledge_entries
        (id, subject_id, subject_hint, kind, text, pinned, importance, status,
         source_channel, source_untrusted, source_type, source_thread_id, source_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      subjectId,
      subjectHint,
      params.kind ?? 'fact',
      this.engine.enc(params.text),
      pinned,
      clampImportance(params.importance),
      status,
      params.sourceChannel ?? null,
      params.sourceUntrusted === true ? 1 : 0,
      tier,
      params.sourceThreadId ?? null,
      params.sourceRunId ?? null,
    );

    return { id, status, tier, subjectId, pinned: pinned === 1 };
  }

  /**
   * Find an existing ACTIVE entry that the new text merely restates. Criterion = UNION coverage:
   * skip only when (nearly) every token of the NEW text is already covered by the union of
   * candidate entries. This catches an exact duplicate, a combined restatement of two facts
   * already recorded (a superset of one, its remainder covered by the other), and both sides of a
   * same-turn correction — WITHOUT deduping a genuine fact that ADDS detail (its new tokens are
   * not covered → coverage falls below the bar). Candidates are scoped to the same subject (a
   * cross-turn duplicate) OR the same run (a same-turn restatement, incl. a `subject`-null combined
   * one). Returns the single most-overlapping row (the "already recorded" anchor), or null.
   */
  private _findActiveDuplicate(text: string, subjectId: string | null, sourceRunId: string | undefined): KnowledgeRow | null {
    // Coverage is measured over CONTENT tokens only — filler like "is/in/of" would otherwise let a
    // shared subject + framing mask a changed VALUE (a correction) as a duplicate, silently
    // dropping the correction and keeping the stale fact (validated bug, 2026-07-17).
    const contentTokens = (t: string): string[] => KnowledgeStore.tokenize(t).filter(w => !DEDUP_FUNCTION_WORDS.has(w));
    const newTokens = new Set(contentTokens(text));
    if (newTokens.size < 2) return null; // too little content to judge a duplicate
    const clauses: string[] = [];
    const args: string[] = [];
    if (subjectId) { clauses.push('subject_id = ?'); args.push(subjectId); }
    if (sourceRunId) { clauses.push('source_run_id = ?'); args.push(sourceRunId); }
    if (clauses.length === 0) return null;
    const rows = this.db.prepare(
      `SELECT * FROM knowledge_entries WHERE status = 'active' AND (${clauses.join(' OR ')}) ORDER BY created_at DESC LIMIT 50`,
    ).all(...args) as KnowledgeRow[];

    const covered = new Set<string>();
    let anchor: KnowledgeRow | null = null;
    let anchorShared = 0;
    for (const row of rows) {
      const rowText = this.engine.dec(row.text);
      // Subject-safety: a candidate pulled in by the SAME-RUN clause can name a DIFFERENT
      // subject — two structurally-parallel facts written in one turn ("AlphaClinic uses
      // Slack and Notion" then "BetaStore uses Slack and Notion"). Deduping across them
      // silently drops the second subject's fact and mis-attributes its id. Skip a candidate
      // whose subject differs — by explicit subject_id (the structured case), or by proper-noun
      // divergence in the text (the subject-null combined-write case; the same guard the
      // recall-layer sibling applies). A genuine combined restatement shares its subjects.
      if (subjectId && row.subject_id && row.subject_id !== subjectId) continue;
      if (subjectsDisagree(text, rowText)) continue;
      let sharedHere = 0;
      for (const t of contentTokens(rowText)) {
        if (newTokens.has(t)) { covered.add(t); sharedHere += 1; }
      }
      if (sharedHere > anchorShared) { anchorShared = sharedHere; anchor = row; }
    }
    return covered.size / newTokens.size >= DEDUP_COVERAGE_THRESHOLD ? anchor : null;
  }

  // ── Recall (D-4: deterministic subject resolution + token-overlap rank) ──

  /**
   * On-demand retrieval. Resolves the subject deterministically (explicit `subjectName`, else
   * a name/alias scan of the query against subjects that HAVE authored entries), walks up the
   * ancestor chain (a project query sees client-level entries), then ranks WITHIN by token
   * overlap. Renders only `status='active'`; `external_unverified` never appears (it is always
   * pending/rejected). Higher-trust wins ties. Returns decrypted entries, budget-capped.
   */
  recall(params: { query: string; subjectName?: string | undefined; limit?: number | undefined; tokenBudget?: number | undefined }): KnowledgeEntry[] {
    const limit = params.limit ?? 8;
    const tokenBudget = params.tokenBudget ?? 4000;

    const scopeIds = this._resolveRecallScope(params.query, params.subjectName);
    const rows = scopeIds === null
      ? this._selectActiveGlobal()
      : this._selectActiveForSubjects(scopeIds);

    const queryTokens = new Set(KnowledgeStore.tokenize(params.query));
    const scored = rows.map(row => {
      const overlap = this._overlap(queryTokens, KnowledgeStore.tokenize(this.engine.dec(row.text)));
      return { row, overlap };
    });
    // Rank: pinned DESC, importance DESC, overlap DESC, trust DESC, created_at DESC.
    scored.sort((a, b) =>
      (b.row.pinned - a.row.pinned)
      || (b.row.importance - a.row.importance)
      || (b.overlap - a.overlap)
      || (provenanceRank(b.row.source_type as ProvenanceKind) - provenanceRank(a.row.source_type as ProvenanceKind))
      || b.row.created_at.localeCompare(a.row.created_at),
    );

    const out: KnowledgeEntry[] = [];
    let charBudget = tokenBudget * 4; // ~4 chars/token
    for (const { row } of scored) {
      if (out.length >= limit) break;
      const entry = this._rowToEntry(row);
      charBudget -= entry.text.length;
      if (charBudget < 0 && out.length > 0) break;
      out.push(entry);
    }
    return out;
  }

  // ── Always-load blocks + derived focus (req 4, D-5, H2/H7) ──

  /**
   * Render the always-loaded blocks for THIS turn: `profile` + `playbook` (stored) + a
   * `focus` block DERIVED per turn (never persisted). Focus is H2-gated — only subjects that
   * have `active` authored entries are candidates, so the dirty ghost graph renders nothing.
   * Secrets are masked on render (H7). Returns the composed markdown (empty string = no block).
   */
  renderBlocks(params: { turnText: string; threadAnchorSubjectId?: string | null | undefined; focusOverrideSubjectId?: string | null | undefined }): string {
    const sections: string[] = [];

    const profile = this.getBlock('profile');
    if (profile && profile.content.trim().length > 0) {
      sections.push(`## Your profile\n${profile.content.trim()}`);
    }
    const playbook = this.getBlock('playbook');
    if (playbook && playbook.content.trim().length > 0) {
      sections.push(`## Operating playbook\n${playbook.content.trim()}`);
    }

    const focus = this._renderFocus(params.turnText, params.threadAnchorSubjectId ?? null, params.focusOverrideSubjectId ?? this._focusOverrideSubjectId);
    if (focus) sections.push(focus);

    if (sections.length === 0) return '';
    const composed = sections.join('\n\n');
    // H7: mask secrets on the always-loaded render, defense in depth. Two layers: tenant-KNOWN
    // secret values (maskSecrets) AND secret-SHAPED tokens (maskSecretPatterns — API keys, JWTs,
    // Bearer). `remember`d entries already passed the write-side shape reject, but the
    // profile/playbook blocks are edited via memory_block_edit (no write-side shape scan), so a
    // shaped credential pasted into a rule would otherwise render unmasked every turn.
    return this._maskText(composed);
  }

  /** The stored block (profile/playbook), decrypted content + its char bound. */
  getBlock(id: MemoryBlockId): { content: string; charLimit: number } | null {
    const row = this.db.prepare('SELECT content, char_limit FROM memory_blocks WHERE id = ?').get(id) as
      | { content: string; char_limit: number }
      | undefined;
    if (!row) return null;
    return { content: this.engine.dec(row.content), charLimit: row.char_limit };
  }

  /** Overwrite a block's content. Throws {@link BlockOverLimitError} if over the char bound —
   *  a LOUD error (the anti-`trimMemoryContent` stance), never a silent trim. */
  setBlockContent(id: MemoryBlockId, content: string): void {
    const limit = MEMORY_BLOCK_CHAR_LIMITS[id];
    if (content.length > limit) throw new BlockOverLimitError(id, content.length, limit);
    this.db.prepare(`
      INSERT INTO memory_blocks (id, content, char_limit, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
    `).run(id, this.engine.enc(content), limit);
  }

  /**
   * Apply an exact-substring edit to a block. `replace`/`remove` operate on `oldText`
   * (an empty `oldText` is refused — the guard mirrors `memory.ts:459-476`); `append` adds
   * `newText` on a new line. Over-limit throws {@link BlockOverLimitError}. Pure store
   * mutation — the trust gating (untrusted-refuse, autonomous-refuse) lives in the tool.
   */
  editBlock(id: MemoryBlockId, mode: MemoryBlockEditMode, oldText: string | undefined, newText: string | undefined): void {
    const current = this.getBlock(id)?.content ?? '';
    let next: string;
    if (mode === 'append') {
      const add = (newText ?? '').trim();
      if (!add) throw new BlockEditError('append needs non-empty new_text.');
      next = current.length > 0 ? `${current}\n${add}` : add;
    } else if (mode === 'replace') {
      const from = oldText ?? '';
      if (from.trim().length === 0) throw new BlockEditError('replace needs a non-empty old_text (an empty match would rewrite the whole block).');
      if (!current.includes(from)) throw new BlockEditError(`old_text not found in the ${id} block.`);
      next = current.split(from).join(newText ?? '');
    } else {
      const from = oldText ?? '';
      if (from.trim().length === 0) throw new BlockEditError('remove needs a non-empty old_text.');
      if (!current.includes(from)) throw new BlockEditError(`old_text not found in the ${id} block.`);
      next = current.split(from).join('');
    }
    this.setBlockContent(id, next);
  }

  // ── Queue / read helpers (used by DK.2 UI; internal reads here) ──

  getEntry(id: string): KnowledgeEntry | null {
    const row = this.db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as KnowledgeRow | undefined;
    return row ? this._rowToEntry(row) : null;
  }

  /** Count of queued (`pending_review`) entries — the queue badge / canary inflow metric (H4). */
  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM knowledge_entries WHERE status = 'pending_review'").get() as { n: number };
    return row.n;
  }

  /** The review queue (DK.2 UI): queued entries oldest-first, decrypted. */
  listPending(limit = 100): KnowledgeEntry[] {
    const capped = Math.max(1, Math.min(limit, 500));
    const rows = this.db.prepare(
      "SELECT * FROM knowledge_entries WHERE status = 'pending_review' ORDER BY created_at ASC LIMIT ?",
    ).all(capped) as KnowledgeRow[];
    return rows.map(r => this._rowToEntry(r));
  }

  /**
   * Active knowledge for the read-surface (the "Wissen" browse tab, DK-UX). Unlike
   * {@link recall} this is NOT query-ranked — a stable browse list: pinned first, then
   * newest. A dedicated query (not `_selectActiveGlobal`, which is recall's 200-cap and
   * would drop a pinned entry older than the 200 newest). Secrets are MASKED — the browse
   * is a display surface, unlike the review queue ({@link listPending}) which shows raw
   * text for human judgement. `limit` bounds the row count (1..500).
   */
  listActive(limit = 200): Array<KnowledgeEntry & { subjectName: string | null }> {
    const capped = Math.max(1, Math.min(limit, 500));
    const rows = this.db.prepare(
      "SELECT * FROM knowledge_entries WHERE status = 'active' ORDER BY pinned DESC, created_at DESC LIMIT ?",
    ).all(capped) as KnowledgeRow[];
    return rows.map(r => {
      const e = this._rowToEntry(r);
      // Active rows link via `subject_id` (`subject_hint` is NULL post-approval — H4/reviewEntry),
      // so resolve the canonical subject NAME for the browse surface: which client/subject the
      // entry belongs to. `resolveActiveSubject` follows merges to the live canonical id.
      const subjectName = e.subjectId
        ? this.subjects.getSubject(this.subjects.resolveActiveSubject(e.subjectId))?.name ?? null
        : null;
      return { ...e, text: this._maskText(e.text), subjectName };
    });
  }

  /** The always-loaded blocks (profile + playbook) for the read-surface, decrypted AND
   *  masked for display (the same two-layer masking as {@link renderBlocks}). */
  readSurfaceBlocks(): { profile: string; playbook: string } {
    return {
      profile: this._maskText(this.getBlock('profile')?.content ?? ''),
      playbook: this._maskText(this.getBlock('playbook')?.content ?? ''),
    };
  }

  /**
   * Resolve a queued entry (DK.2 review). Approval is the HUMAN trust event:
   * status → `active`, tier → `user_asserted` (the ui/user channel —
   * `provenance.ts` rule 2), and the deliberate subject link runs NOW via
   * `findOrCreate` from the stored `subject_hint` (pending-entry hygiene: a
   * rejected entry never mints a subject). `edit_approve` replaces the text
   * with the reviewer's wording first. Pin is NEVER inherited through approval
   * — H6 stays a deliberate post-approval act. Rejection keeps the row (audit
   * trail: `reviewed_at` + `review_action`), it never deletes.
   * Returns the updated entry, or null when the id is not a queued entry.
   */
  reviewEntry(id: string, action: 'approve' | 'edit_approve' | 'reject', editedText?: string): KnowledgeEntry | null {
    const row = this.db.prepare(
      "SELECT * FROM knowledge_entries WHERE id = ? AND status = 'pending_review'",
    ).get(id) as KnowledgeRow | undefined;
    if (!row) return null;

    if (action === 'reject') {
      this.db.prepare(`
        UPDATE knowledge_entries
        SET status = 'rejected', reviewed_at = datetime('now'), review_action = 'reject', updated_at = datetime('now')
        WHERE id = ?
      `).run(id);
      return this.getEntry(id);
    }

    const text = action === 'edit_approve' ? (editedText ?? '').trim() : this.engine.dec(row.text);
    if (!text) throw new BlockEditError('the entry to approve has no text.');
    if (text.length > MAX_KNOWLEDGE_ENTRY_CHARS) {
      throw new Error(`edited text is ${text.length} chars, over the ${MAX_KNOWLEDGE_ENTRY_CHARS}-char store limit.`);
    }
    // Secret-shape scan at the promotion choke point — mirrors `remember`'s write-path guard
    // (matchesSecretPattern + containsSecret). Approval makes the text agent-readable via
    // `recall`; the `remember` scan can miss a value that became a vault secret AFTER queueing,
    // and `edit_approve` introduces brand-new reviewer text. Reject, never store a credential.
    if (matchesSecretPattern(text) || this.secretStore?.containsSecret(text) === true) {
      throw new BlockEditError('This entry looks like it contains a secret or credential and cannot be approved into memory. Store secrets in the vault, not in a memory entry.');
    }

    let subjectId: string | null = row.subject_id;
    const hint = row.subject_hint?.trim();
    if (!subjectId && hint) {
      subjectId = this.subjects.findOrCreate({ kind: 'organization', name: hint }).id;
    }

    // Only rewrite the ciphertext when the reviewer actually EDITED the text — a plain approve
    // leaves it unchanged, and re-encrypting produces a fresh (IV-randomised) ciphertext for no
    // reason. edit_approve → write the new text; approve → keep the stored ciphertext.
    if (action === 'edit_approve') {
      this.db.prepare(`
        UPDATE knowledge_entries
        SET status = 'active', source_type = 'user_asserted', text = ?, subject_id = ?, subject_hint = NULL,
            reviewed_at = datetime('now'), review_action = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(this.engine.enc(text), subjectId, action, id);
      return this.getEntry(id);
    }
    this.db.prepare(`
      UPDATE knowledge_entries
      SET status = 'active', source_type = 'user_asserted', subject_id = ?, subject_hint = NULL,
          reviewed_at = datetime('now'), review_action = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(subjectId, action, id);
    return this.getEntry(id);
  }

  /**
   * Resolve an ACTIVE entry by full id or a unique hex-id prefix (≥8 chars —
   * what `recall` shows the agent). Returns null on no match; throws on an
   * AMBIGUOUS prefix so the caller asks for a longer one instead of retiring
   * the wrong fact.
   */
  findActiveByIdPrefix(idOrPrefix: string): KnowledgeEntry | null {
    const p = idOrPrefix.trim().toLowerCase();
    if (!/^[0-9a-f-]{8,36}$/.test(p)) return null;
    const rows = this.db.prepare(
      "SELECT * FROM knowledge_entries WHERE status = 'active' AND id LIKE ? LIMIT 2",
    ).all(`${p}%`) as KnowledgeRow[];
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new Error(`id prefix "${p}" is ambiguous — pass more characters.`);
    return this._rowToEntry(rows[0]!);
  }

  /**
   * Retire an active entry (DK.2 `memory_retire`): status → `superseded`,
   * optionally pointing at the successor entry. Gated by `canSupersede`
   * (`provenance.ts`): the retiring actor's tier must be equal-or-higher than
   * the entry's — an agent (acting at `agent_inferred`) can retire its own
   * inferences and unverified material but NEVER a `user_asserted` or
   * `tool_verified` fact; those need the human (the UI / a user-channel act).
   * Returns the retired entry, or throws with the refusal reason.
   */
  retireEntry(id: string, retiringTier: ProvenanceKind, supersededBy?: string): KnowledgeEntry {
    const entry = this.findActiveByIdPrefix(id);
    if (!entry) throw new Error('No active entry with this id.');
    if (!canSupersede(retiringTier, entry.sourceType)) {
      throw new Error(
        `Refused: this fact is ${entry.sourceType} and outranks the ${retiringTier} channel. Ask the user to retire or correct it.`,
      );
    }
    this.db.prepare(`
      UPDATE knowledge_entries
      SET status = 'superseded', superseded_by = ?, pinned = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(supersededBy ?? null, entry.id);
    return this.getEntry(entry.id)!;
  }

  // ── Focus derivation (H2-gated) ──

  private _renderFocus(turnText: string, threadAnchorSubjectId: string | null, focusOverrideSubjectId: string | null): string | null {
    const subjectIds = this._deriveFocusSubjects(turnText, threadAnchorSubjectId, focusOverrideSubjectId);
    if (subjectIds.length === 0) return null; // fail-quiet (recall still available; self-corrects next turn)

    const cards: string[] = [];
    let budget = FOCUS_BLOCK_CHAR_LIMIT;
    for (const sid of subjectIds.slice(0, 2)) {
      const card = this._renderSubjectCard(sid, budget);
      if (card) {
        cards.push(card);
        budget -= card.length;
        if (budget <= 0) break;
      }
    }
    if (cards.length === 0) return null;
    return `## In focus\n${cards.join('\n\n')}`;
  }

  /**
   * The subjects in play this turn — H2-gated to subjects that HAVE `active` authored entries
   * (a ghost with none renders nothing). Union of: a deterministic name/alias scan of the turn
   * text; the thread anchor; a session focus override (DK.2). Redirects chased to canonical.
   * Ordered most-recently-updated first; ambiguity self-corrects next turn (nothing persists).
   */
  private _deriveFocusSubjects(turnText: string, threadAnchorSubjectId: string | null, focusOverrideSubjectId: string | null): string[] {
    // H2: candidate set = subjects with at least one active entry (chases merge redirects).
    const candidateRows = this.db.prepare(
      "SELECT DISTINCT subject_id FROM knowledge_entries WHERE status = 'active' AND subject_id IS NOT NULL",
    ).all() as Array<{ subject_id: string }>;
    const candidates = new Set<string>();
    for (const { subject_id } of candidateRows) candidates.add(this.subjects.resolveActiveSubject(subject_id));
    if (candidates.size === 0) return [];

    const hay = turnText.toLowerCase();
    const matched = new Map<string, string>(); // id → updated_at (for ordering)
    for (const id of candidates) {
      const subj = this.subjects.getSubject(id);
      if (!subj || subj.archived_at) continue;
      if (this._mentions(hay, subj)) matched.set(id, subj.updated_at);
    }
    // ∪ the explicit thread anchor + session override — but ONLY if they too carry active
    // entries (H2), so an anchored ghost still renders nothing.
    for (const explicit of [threadAnchorSubjectId, focusOverrideSubjectId]) {
      if (!explicit) continue;
      const resolved = this.subjects.resolveActiveSubject(explicit);
      if (candidates.has(resolved) && !matched.has(resolved)) {
        matched.set(resolved, this.subjects.getSubject(resolved)?.updated_at ?? '');
      }
    }
    return [...matched.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
  }

  /** Whole-ish match of a subject's name or any alias in the (already-lowercased) turn text. */
  private _mentions(hayLower: string, subj: SubjectRow): boolean {
    const names = [subj.name, ...this._aliases(subj.aliases)];
    for (const n of names) {
      const needle = n.trim().toLowerCase();
      if (needle.length < 2) continue;
      let from = 0;
      // Bounded occurrence: the match must not be flanked by a letter/digit on either side,
      // so "AG" does not fire inside "AGENCY" but "Meridian AG" fires in a sentence.
      for (;;) {
        const at = hayLower.indexOf(needle, from);
        if (at === -1) break;
        const before = at === 0 ? '' : hayLower[at - 1]!;
        const after = at + needle.length >= hayLower.length ? '' : hayLower[at + needle.length]!;
        if (!isAlnum(before) && !isAlnum(after)) return true;
        from = at + needle.length;
      }
    }
    return false;
  }

  private _renderSubjectCard(subjectId: string, charBudget: number): string | null {
    const subj = this.subjects.getSubject(subjectId);
    if (!subj) return null;
    const pinned = this.db.prepare(`
      SELECT * FROM knowledge_entries
      WHERE subject_id = ? AND status = 'active' AND pinned = 1
      ORDER BY created_at DESC
    `).all(subjectId) as KnowledgeRow[];

    const header = subj.status ? `### ${subj.name} (${subj.kind}, ${subj.status})` : `### ${subj.name} (${subj.kind})`;
    const lines = [header];
    const ancestors = this.subjects.getAncestors(subjectId);
    if (ancestors.length > 0) lines.push(`Part of: ${ancestors.map(a => a.name).join(' › ')}`);

    let used = lines.join('\n').length;
    for (const row of pinned) {
      const text = this.engine.dec(row.text).trim();
      const line = `- ${text}`;
      if (used + line.length + 1 > charBudget) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  // ── Recall scope resolution ──

  private _resolveRecallScope(query: string, subjectName: string | undefined): string[] | null {
    const explicit = subjectName?.trim();
    if (explicit) {
      const hit = this.subjects.findCanonical(explicit, 'organization')
        ?? this.subjects.findByAlias(explicit, 'organization')
        ?? this.subjects.findCanonical(explicit, 'person')
        ?? this.subjects.findByAlias(explicit, 'person');
      // Named an explicit subject we don't know → return an EMPTY scope, NOT a global scan.
      // A scoped query that fell back to global would surface OTHER clients' facts — the exact
      // cross-client bleed the substrate exists to prevent (§1). No match ⇒ no results.
      if (!hit) return [];
      return this._withAncestors(this.subjects.resolveActiveSubject(hit.id));
    }
    // No explicit subject: reuse the focus name-scan over subjects-with-entries.
    const derived = this._deriveFocusSubjects(query, null, null);
    if (derived.length === 0) return null; // nothing resolved → global scan
    const all = new Set<string>();
    for (const id of derived) for (const a of this._withAncestors(id)) all.add(a);
    return [...all];
  }

  private _withAncestors(subjectId: string): string[] {
    return [subjectId, ...this.subjects.getAncestors(subjectId).map(a => a.id)];
  }

  private _selectActiveForSubjects(subjectIds: string[]): KnowledgeRow[] {
    if (subjectIds.length === 0) return [];
    const placeholders = subjectIds.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM knowledge_entries WHERE status = 'active' AND subject_id IN (${placeholders})`,
    ).all(...subjectIds) as KnowledgeRow[];
  }

  private _selectActiveGlobal(): KnowledgeRow[] {
    // Bounded so a large corpus doesn't rank-scan unboundedly; newest-first pre-cut.
    return this.db.prepare(
      "SELECT * FROM knowledge_entries WHERE status = 'active' ORDER BY created_at DESC LIMIT 200",
    ).all() as KnowledgeRow[];
  }

  // ── Small helpers ──

  /** Two-layer secret masking for display surfaces (H7): tenant-known secret VALUES
   *  (`maskSecrets`) then secret-SHAPED tokens (`maskSecretPatterns` — API keys, JWTs,
   *  Bearer). Shared by {@link renderBlocks} and the read-surface reads. */
  private _maskText(text: string): string {
    const tenantMasked = this.secretStore ? this.secretStore.maskSecrets(text) : text;
    return maskSecretPatterns(tenantMasked);
  }

  private _overlap(queryTokens: Set<string>, docTokens: string[]): number {
    if (queryTokens.size === 0) return 0;
    let n = 0;
    const seen = new Set<string>();
    for (const t of docTokens) {
      if (!seen.has(t) && queryTokens.has(t)) { n++; seen.add(t); }
    }
    return n;
  }

  private _aliases(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
    } catch {
      return [];
    }
  }

  private _rowToEntry(row: KnowledgeRow): KnowledgeEntry {
    return {
      id: row.id,
      subjectId: row.subject_id,
      subjectHint: row.subject_hint,
      kind: row.kind as KnowledgeKind,
      text: this.engine.dec(row.text),
      pinned: row.pinned === 1,
      importance: row.importance,
      status: row.status as KnowledgeStatus,
      sourceChannel: row.source_channel,
      sourceUntrusted: row.source_untrusted === 1,
      sourceType: row.source_type as ProvenanceKind,
      sourceThreadId: row.source_thread_id,
      sourceRunId: row.source_run_id,
      supersededBy: row.superseded_by,
      reviewedAt: row.reviewed_at,
      reviewAction: row.review_action,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── Types + module helpers ──

export interface KnowledgeWriteParams {
  text: string;
  subjectName?: string | undefined;
  subjectKind?: SubjectKind | undefined;
  kind?: KnowledgeKind | undefined;
  pin?: boolean | undefined;
  importance?: number | undefined;
  /** The write CHANNEL (provenance evidence). `agent` for a `remember` tool call. */
  sourceChannel: string;
  /** True when this turn read untrusted external content → routes to pending_review. */
  sourceUntrusted: boolean;
  sourceThreadId?: string | undefined;
  sourceRunId?: string | undefined;
}

export interface KnowledgeWriteResult {
  id: string;
  status: KnowledgeStatus;
  tier: ProvenanceKind;
  subjectId: string | null;
  pinned: boolean;
  /** True when the write was a near-duplicate of an existing active entry and was NOT inserted;
   *  `id` then points at that existing entry. */
  deduped?: boolean;
}

/** The raw v9 `knowledge_entries` row (text still enc()'d). */
interface KnowledgeRow {
  id: string;
  subject_id: string | null;
  subject_hint: string | null;
  kind: string;
  text: string;
  pinned: number;
  importance: number;
  status: string;
  source_channel: string | null;
  source_untrusted: number;
  source_type: string;
  source_thread_id: string | null;
  source_run_id: string | null;
  superseded_by: string | null;
  reviewed_at: string | null;
  review_action: string | null;
  created_at: string;
  updated_at: string;
}

/** Thrown when a block edit would exceed the char bound — surfaced as a loud tool error. */
export class BlockOverLimitError extends Error {
  constructor(public readonly block: MemoryBlockId, public readonly length: number, public readonly limit: number) {
    super(`The ${block} block would be ${length} chars, over its ${limit}-char limit. Move detail into \`remember\` instead of growing the block.`);
    this.name = 'BlockOverLimitError';
  }
}

/** Thrown for a malformed block edit (empty match, substring not found). */
export class BlockEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockEditError';
  }
}

function clampImportance(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(2, Math.trunc(v)));
}

function isAlnum(ch: string): boolean {
  return ch.length > 0 && /[\p{L}\p{N}]/u.test(ch);
}

/** A small multilingual stop-word set for the token-overlap rank (DE + EN function words). */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'are', 'has', 'have', 'not',
  'der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'den', 'dem', 'des', 'mit', 'für', 'von',
  'auf', 'ich', 'sie', 'wir', 'nicht', 'auch', 'aber', 'wie', 'was',
]);
