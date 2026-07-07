import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { EntityType } from '../types/index.js';

/**
 * SubjectStore — the S1 write/read layer over the engine.db subject graph
 * (Foundation Rework v2). It owns `subjects` + the person/organization detail
 * tables, and is the converged `findOrCreate` dedup entry point for that graph
 * (`idx_subjects_canonical` is the structural backstop). S1b uses it as the
 * target of an ADDITIVE mirror of the KnowledgeLayer extraction — the legacy
 * `agent-memory.db` inline find-or-create and the standalone `EntityResolver`
 * still run and stay AUTHORITATIVE; converging/retiring those two divergent
 * legacy dedup paths onto this one is deferred to the read-migration (S1d) +
 * the data migration (S2).
 *
 * Encryption boundary (S0 D2/D4): `subjects.name` stays PLAINTEXT — the canonical
 * dedup index is on `LOWER(name)`, so GCM ciphertext would defeat dedup. The
 * sensitive detail columns `people.email`/`people.phone` go through
 * `EngineDb.enc()`/`dec()` (a net-new at-rest protection — the legacy
 * agent-memory.db/datastore.db stores are plaintext today).
 *
 * S1a ships these classes UNWIRED — nothing calls them in the live path yet; the
 * flag-gated wiring lands in S1b.
 */

export const KNOWN_SUBJECT_KINDS = [
  'person', 'organization', 'engagement', 'product', 'service', 'other',
] as const;
export type SubjectKind = (typeof KNOWN_SUBJECT_KINDS)[number];

/**
 * The three faces of the DataStore ⇄ subject-graph bridge for a `subject`-typed
 * column (Record-on-spine). One cohesive dependency the engine injects:
 *  - `resolve` (WRITE)   — create-or-get: a row's name → a real `subject_id`, via
 *    the graph's converged `findOrCreate` dedup. Used on insert (R1).
 *  - `find`    (FILTER)  — get-ONLY: an existing `subject_id` for a name, or null.
 *    Translates a name filter operand → id WITHOUT minting a subject (R1.5).
 *  - `name`    (DISPLAY) — a `subject_id` → its display name, or null when purged.
 *    Hydrates query results back to names instead of raw UUIDs (R1.5).
 *
 * An arbitrary kind string is narrowed against {@link KNOWN_SUBJECT_KINDS} with a
 * defensive floor to `person` (the tool contract already restricts a column's
 * subjectKind to the name-deduped set). `resolve`/`find` share the graph's default
 * owner scope so the filter side finds exactly what the write side created.
 * Exported as a tiny factory so the wiring is unit-testable without booting the
 * engine; the engine only ever `setSubjectBridge(makeSubjectColumnBridge(store))`.
 */
export interface SubjectColumnBridge {
  resolve(name: string, kind: string): string | null;
  find(name: string, kind: string): string | null;
  name(id: string): string | null;
}

export function makeSubjectColumnBridge(subjectStore: SubjectStore): SubjectColumnBridge {
  const narrow = (kind: string): SubjectKind =>
    (KNOWN_SUBJECT_KINDS as readonly string[]).includes(kind) ? (kind as SubjectKind) : 'person';
  return {
    resolve: (name, kind) => subjectStore.findOrCreate({ kind: narrow(kind), name }).id,
    find: (name, kind) => {
      const k = narrow(kind);
      return (subjectStore.findCanonical(name, k) ?? subjectStore.findByAlias(name, k))?.id ?? null;
    },
    name: (id) => subjectStore.getSubject(id)?.name ?? null,
  };
}

/**
 * Map a legacy KG `entity_type` to a Subject kind, or `null` when the entity is
 * NOT a subject. The S1b extraction mirror uses this to decide which extracted
 * entities become subjects: a `concept`/`location`/`collection` is knowledge-graph
 * metadata (a topic, a place, a data table) — not an actor/record the user shapes
 * — so it is dropped. Defensive on unknown inputs (the extractor is the boundary):
 *   person → person · organization → organization ·
 *   project → engagement (a scoped piece of work) · product → product ·
 *   concept | location | collection | unknown → null
 * Note: no KG `entity_type` maps to `service`, so this mirror never mints a
 * `service` subject — service name-dedup (NAME_DEDUP_KINDS) is forward-ready for
 * other producers (e.g. CRM in S1c), not exercised by the extraction path.
 */
export function entityTypeToSubjectKind(entityType: string): SubjectKind | null {
  switch (entityType) {
    case 'person': return 'person';
    case 'organization': return 'organization';
    case 'project': return 'engagement';
    case 'product': return 'product';
    default: return null;
  }
}

/**
 * Reverse of {@link entityTypeToSubjectKind} for the S1d read path: map a Subject
 * kind back to the legacy KG `entity_type` the `EntityRecord` DTO expects, or `null`
 * when the kind has no KG equivalent (`service`/`other` were never knowledge-graph
 * entities). `engagement → project` inverts the forward `project → engagement`. The
 * return type is tied to `EntityType` so a rename of its members breaks here.
 */
export function subjectKindToEntityType(
  kind: string,
): Extract<EntityType, 'person' | 'organization' | 'project' | 'product'> | null {
  switch (kind) {
    case 'person': return 'person';
    case 'organization': return 'organization';
    case 'engagement': return 'project';
    case 'product': return 'product';
    default: return null;
  }
}

/**
 * The subject kinds that map back to a legacy KG `entity_type` — the S1d read
 * surface. DERIVED from {@link subjectKindToEntityType} (single source of truth) so
 * the count predicate in `stats()` can never drift from the list-path's null-filter.
 */
export const ENTITY_MAPPABLE_SUBJECT_KINDS: readonly SubjectKind[] =
  KNOWN_SUBJECT_KINDS.filter(k => subjectKindToEntityType(k) !== null);

/**
 * The kinds the canonical-UNIQUE dedup guard covers (per `idx_subjects_canonical`).
 * MUST stay in sync with the index DDL predicate (engine-db.ts) + findCanonical's
 * kind-IN list. `engagement` (identity = provider×client×period) and `other`
 * (unstructured) are deliberately excluded — they are not name-identified.
 *
 * This is ALSO the set of kinds a name-resolved carrier may use: a DataStore
 * `subject` column resolves rows BY NAME (Record-on-spine R1), so it can only
 * offer kinds that dedup by name — offering `engagement`/`other` would mint a
 * fresh subject on every insert of the same name (the "same name → same id"
 * promise silently breaks). `data_store_create` derives its allowed subjectKinds
 * from this array; keep it as the single runtime source of truth.
 */
export const NAME_DEDUPED_SUBJECT_KINDS = ['person', 'organization', 'product', 'service'] as const;
const NAME_DEDUP_KINDS: ReadonlySet<string> = new Set(NAME_DEDUPED_SUBJECT_KINDS);

/** Leading generic project word (+ separator) stripped from an engagement name. */
const ENGAGEMENT_LEADING_GENERIC_RE = /^(?:projekt|project|projet)[\s:]+/iu;

/**
 * Canonicalize a subject name for dedup matching: trim, collapse internal
 * whitespace, strip trailing punctuation. For `engagement`, additionally strip a
 * leading generic project word so "Projekt Orion" and "Orion" resolve to the same
 * canonical (the original surface form is preserved separately as an alias). Pure
 * + deterministic; never returns empty (falls back to the trimmed input).
 */
export function normalizeSubjectName(kind: string, name: string): string {
  let n = name.trim().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/u, '').trim();
  if (kind === 'engagement') {
    const stripped = n.replace(ENGAGEMENT_LEADING_GENERIC_RE, '').trim();
    if (stripped) n = stripped;   // keep "Projekt" alone (→empty) as-is
  }
  return n || name.trim();
}

export interface SubjectRow {
  id: string;
  kind: string;
  name: string;
  aliases: string;          // JSON array
  is_self: number;
  parent_id: string | null;
  status: string | null;
  owner_user_id: string;
  embedding: Buffer | null;
  archived_at: string | null;
  merged_into: string | null;   // v7: redirect pointer set by mergeSubjects on the duplicate
  created_at: string;
  updated_at: string;
}

export interface PersonDetail {
  email?: string | undefined;
  phone?: string | undefined;
  role?: string | undefined;
  type?: string | undefined;   // customer | lead | partner | employee | contact | other
}

export interface OrganizationDetail {
  domain?: string | undefined;
  vat_id?: string | undefined;
  country?: string | undefined;
  type?: string | undefined;   // customer | lead | partner | vendor | other
}

const DEFAULT_OWNER = 'system';

/**
 * Display name of the reserved self-person subject (the operator themselves).
 * The self-IDENTITY is the `is_self` flag on a `kind='person'` row — NOT this name
 * — so the reverse read (`taskDbRowToRecord`) maps any `is_self` assignee back to
 * the legacy sentinel `'user'` regardless of what this reads. The name only ever
 * shows in a subject listing; it is deliberately generic. See {@link SubjectStore.findSelfPerson}.
 */
export const SELF_PERSON_NAME = 'Me';

/**
 * Reserved owner scope for the singleton self-person, DISTINCT from {@link DEFAULT_OWNER}.
 * The canonical-dedup index keys on `(LOWER(name), kind, owner_user_id)` and ignores
 * `is_self`, so a self-person sharing an owner with the user's people would (a) collide
 * on the UNIQUE index against a same-named person and (b) let a named assignee merge into
 * the operator. Isolating the self node in its own owner scope structurally prevents both:
 * a person the user names 'Me' (DEFAULT_OWNER) and the operator-self (`SELF_OWNER`) are
 * separate rows, and a task assigned to that named 'Me' reads back as its name, not 'user'.
 */
const SELF_OWNER = '__self__';

// ── Retroactive merge (PR-C dedup) ────────────────────────────────
//
// Every engine.db column that holds a PLAIN (non-PK) subject_id FK — the ones a
// merge repoints wholesale from the duplicate onto the canonical. The 1:1 detail
// tables (people/organizations/… where subject_id IS the PK) are handled separately
// (COALESCE-merge), as are the junction tables (memory_subjects / subject_cooccurrences,
// composite PKs) whose repoint can collide. Table + column names here are STATIC
// literals — never user input — so interpolating them into SQL is injection-safe.
interface RepointTarget { table: string; pkCol: string; column: string }
const REPOINT_TARGETS: readonly RepointTarget[] = [
  { table: 'memories',      pkCol: 'id',         column: 'subject_id' },
  { table: 'tasks',         pkCol: 'id',         column: 'subject_id' },
  { table: 'tasks',         pkCol: 'id',         column: 'assignee_subject_id' },
  { table: 'triggers',      pkCol: 'id',         column: 'subject_id' },
  { table: 'connections',   pkCol: 'id',         column: 'subject_id' },
  { table: 'artifacts',     pkCol: 'id',         column: 'subject_id' },
  { table: 'threads',       pkCol: 'id',         column: 'primary_subject_id' },
  { table: 'relationships', pkCol: 'id',         column: 'from_subject_id' },
  { table: 'relationships', pkCol: 'id',         column: 'to_subject_id' },
  { table: 'engagements',   pkCol: 'subject_id', column: 'provider_subject_id' },
  { table: 'engagements',   pkCol: 'subject_id', column: 'client_subject_id' },
  // subjects.parent_id is repointed too (children of the dup re-hang under canonical),
  // but the canonical's OWN parent_id === dup case is handled specially (self-parent
  // guard) via `canonicalParentWasDup`, so canonical is EXCLUDED from these pks.
  { table: 'subjects',      pkCol: 'id',         column: 'parent_id' },
];

/** The 1:1 detail table per kind (subject_id PK) + its non-PK columns for COALESCE-merge. */
const DETAIL_TABLE: Record<string, { table: string; cols: readonly string[] }> = {
  person:       { table: 'people',        cols: ['email', 'phone', 'role', 'type'] },
  organization: { table: 'organizations', cols: ['domain', 'vat_id', 'country', 'type'] },
  engagement:   { table: 'engagements',   cols: ['provider_subject_id', 'client_subject_id', 'started_at', 'ended_at', 'budget_cents', 'currency', 'billing_model'] },
  product:      { table: 'products',      cols: ['sku', 'price_cents', 'currency'] },
  service:      { table: 'services',      cols: ['hourly_rate_cents', 'currency'] },
};

/**
 * The complete before-image of ONE merge — enough to reverse it byte-for-byte.
 * Captured read-only by {@link SubjectStore.planMerge} BEFORE any mutation, so the
 * caller can persist it FIRST (same crash-safety discipline as the archive sweep:
 * a mutate-then-crash-before-persist would otherwise be irreversible).
 */
export interface MergeLedgerEntry {
  dupId: string;
  canonicalId: string;
  kind: string;
  ownerUserId: string;
  dupArchivedAtWas: string | null;
  dupMergedIntoWas: string | null;
  canonicalAliasesWas: string;                                  // exact JSON string, restored verbatim
  canonicalParentWasDup: boolean;                               // canonical.parent_id === dup (self-parent guard)
  repoints: Array<{ table: string; pkCol: string; column: string; pks: string[] }>;
  memorySubjects: {
    dupRows: Array<{ memory_id: string; mention_type: string; created_at: string }>;
    canonicalMemoryIdsBefore: string[];                          // to know which canonical links to DROP on rollback
  };
  cooccurrences: Array<{ a: string; b: string; count: number; last_seen_at: string }>;
  detail: { table: string; dupRow: Record<string, unknown> | null; canonicalRow: Record<string, unknown> | null } | null;
}

export type MergeResult =
  | { ok: true; entry: MergeLedgerEntry }
  | { ok: false; reason: string };

/**
 * Title tokens stripped before a person-name subset comparison, so "Dr. Ada
 * Lovelace" ⊃ "Ada". Dotless (punctuation is replaced with spaces first).
 */
const PERSON_TITLE_TOKENS: ReadonlySet<string> = new Set([
  'dr', 'herr', 'frau', 'mr', 'ms', 'mrs', 'miss', 'prof', 'dipl', 'ing', 'mag', 'herrn',
]);

/** Lowercase content tokens of a person name (titles + punctuation stripped). */
export function personNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[.,;:!?"'()]/gu, ' ')
    .split(/\s+/u)
    .map(t => t.trim())
    .filter(t => t.length > 0 && !PERSON_TITLE_TOKENS.has(t));
}

/** True when `sub` is a STRICT token subset of `sup` (every token present AND sup has more). */
export function isProperTokenSubset(sub: readonly string[], sup: readonly string[]): boolean {
  if (sub.length === 0 || sup.length <= sub.length) return false;
  const supSet = new Set(sup);
  return sub.every(t => supSet.has(t));
}

export class SubjectStore {
  private readonly db: Database.Database;

  constructor(private readonly engine: EngineDb) {
    this.db = engine.getDb();
  }

  // ── Dedup-converged write ─────────────────────────────────────

  /**
   * The single converged find-or-create. For the identity-by-name kinds
   * (person/organization/product/service) it resolves an existing subject by
   * canonical name (case-insensitive, per-kind, per-owner) then by alias, and
   * inserts only when neither matches (the `idx_subjects_canonical` UNIQUE index is
   * the structural backstop). `engagement` (identity = provider×client×period) and
   * `other` (unstructured) are NOT name-deduped — the lookup is skipped and every
   * call inserts a new subject.
   */
  findOrCreate(params: {
    kind: SubjectKind;
    name: string;
    aliases?: string[] | undefined;
    ownerUserId?: string | undefined;
    isSelf?: boolean | undefined;
    parentId?: string | undefined;
    status?: string | undefined;
    embedding?: Buffer | undefined;
  }): { id: string; created: boolean } {
    const owner = params.ownerUserId ?? DEFAULT_OWNER;
    if (NAME_DEDUP_KINDS.has(params.kind)) {
      // Exact canonical/alias hit first; then a normalized fallback so a punctuated /
      // doubled-whitespace variant converges onto an already-stored CLEAN name (e.g.
      // "Meridian AG." finds a prior "Meridian AG"). One-directional: it matches the
      // normalized query against stored raw names, so the clean form must have been
      // stored first — full symmetry would need a stored normalized-name column.
      const normalized = normalizeSubjectName(params.kind, params.name);
      const existing = this.findCanonical(params.name, params.kind, owner)
        ?? this.findByAlias(params.name, params.kind, owner)
        ?? (normalized !== params.name ? this.findCanonical(normalized, params.kind, owner) : null);
      if (existing) {
        // Fold the caller's surface forms into the existing subject's aliases
        // (case-insensitive — case-variants of an existing alias are no-ops).
        this._mergeAliases(existing, [params.name, ...(params.aliases ?? [])]);
        return { id: existing.id, created: false };
      }
    }
    return { id: this.createSubject(params), created: true };
  }

  /**
   * Resolve or create an ENGAGEMENT (project) by `(normalized-name, parent)`. This
   * is the single engagement resolver — the extraction path and the
   * `set_thread_context` tool both route through it, so they converge on ONE row
   * per real project instead of minting duplicates.
   *
   * Engagements are NOT name-deduped in {@link findOrCreate} (identity is
   * provider×client×period, not name): two clients can each have a "Website" project
   * and they MUST stay distinct rows. So the key is the composite `(name, parent)`,
   * matched on the NORMALIZED name ("Projekt Orion" ≡ "Orion") with the original
   * surface form preserved as an alias. Never merges across parents — the isolation
   * guard. Orphan-adopt: a same-named project not yet filed under any client is
   * adopted under the given parent (the pre-anchor extraction created it unparented).
   */
  findOrCreateEngagement(
    name: string,
    parentId: string | null,
    opts?: {
      ownerUserId?: string | undefined;
      aliases?: string[] | undefined;
      // When no parent is given AND no unparented match exists, may we reuse a
      // same-named project that lives under SOME client? That is a GUESS at the
      // client — safe ONLY when a human confirms it (the set_thread_context handler
      // names the resolved client back to the user). The extraction path has no such
      // gate, so it must NOT silently attribute a memory to an arbitrary client;
      // it leaves this false and gets a fresh unparented row instead.
      allowParentedReuseOnNullParent?: boolean | undefined;
    },
  ): { id: string; created: boolean } {
    const owner = opts?.ownerUserId ?? DEFAULT_OWNER;
    const canonical = normalizeSubjectName('engagement', name);
    const wanted = canonical.toLowerCase();
    const surfaceForms = [canonical, name, ...(opts?.aliases ?? [])];
    const matches = this.listSubjects({ kind: 'engagement', ownerUserId: owner })
      .filter(s => normalizeSubjectName('engagement', s.name).toLowerCase() === wanted);

    const reuse = (row: SubjectRow): { id: string; created: boolean } => {
      this._mergeAliases(row, surfaceForms);
      return { id: row.id, created: false };
    };
    const create = (parent: string | null): { id: string; created: boolean } => ({
      id: this.createSubject({ kind: 'engagement', name: canonical, aliases: surfaceForms, parentId: parent ?? undefined, ownerUserId: owner }),
      created: true,
    });

    if (parentId) {
      const underParent = matches.find(s => s.parent_id === parentId);
      if (underParent) return reuse(underParent);
      // A same-named project not yet filed under any client → adopt it here.
      const orphan = matches.find(s => s.parent_id === null);
      if (orphan) { this.setParent(orphan.id, parentId); return reuse(orphan); }
      // Only matches under OTHER clients exist → this is a distinct project.
      return create(parentId);
    }
    // No client given → prefer a client-agnostic (unparented) same-named project.
    const orphan = matches.find(s => s.parent_id === null);
    if (orphan) return reuse(orphan);
    // No unparented match. Reusing a client-parented row here guesses the client —
    // only the human-confirmed tool path opts in (listSubjects is updated_at DESC, so
    // matches[0] is the most-recent). Extraction gets a fresh unparented row so a bare
    // mention is never silently attributed to an arbitrary client (isolation guard).
    if (opts?.allowParentedReuseOnNullParent && matches[0]) return reuse(matches[0]);
    return create(null);
  }

  /** Raw insert (no dedup) — callers should prefer {@link findOrCreate}. */
  createSubject(params: {
    id?: string | undefined;
    kind: SubjectKind;
    name: string;
    aliases?: string[] | undefined;
    ownerUserId?: string | undefined;
    isSelf?: boolean | undefined;
    parentId?: string | undefined;
    status?: string | undefined;
    embedding?: Buffer | undefined;
  }): string {
    const id = params.id ?? randomUUID();
    const aliases = params.aliases ?? [params.name];
    this.db.prepare(`
      INSERT INTO subjects (id, kind, name, aliases, is_self, parent_id, status, owner_user_id, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.kind, params.name, JSON.stringify(aliases),
      params.isSelf ? 1 : 0, params.parentId ?? null, params.status ?? null,
      params.ownerUserId ?? DEFAULT_OWNER, params.embedding ?? null,
    );
    return id;
  }

  /**
   * Canonical lookup against the `idx_subjects_canonical` index. Meaningful only
   * for the identity-by-name kinds (person/organization/product/service) — the
   * other kinds carry no name-uniqueness and this returns null for them.
   *
   * The WHERE is shaped to make the planner USE the partial expression index
   * (verified via EXPLAIN QUERY PLAN — a naive `name = ? COLLATE NOCASE AND kind = ?`
   * full-scans): `LOWER(name)` matches the `LOWER(name)` expression index, and the
   * literal kind-IN list matches the index's partial predicate (a bound `kind = ?`
   * alone cannot satisfy it). The trailing `kind = ?` still selects the specific
   * kind. This IN list MUST stay in sync with `NAME_DEDUP_KINDS` + the index DDL.
   */
  findCanonical(name: string, kind: string, ownerUserId = DEFAULT_OWNER): SubjectRow | null {
    return this.db.prepare(`
      SELECT * FROM subjects
      WHERE LOWER(name) = LOWER(?) AND kind IN ('person','organization','product','service') AND kind = ?
        AND owner_user_id = ? AND archived_at IS NULL
      LIMIT 1
    `).get(name, kind, ownerUserId) as SubjectRow | undefined ?? null;
  }

  /** Alias lookup (JSON-array contains, case-insensitive), scoped to kind + owner + active. */
  findByAlias(alias: string, kind: string, ownerUserId = DEFAULT_OWNER): SubjectRow | null {
    const escaped = alias.replace(/[%_\\]/g, c => `\\${c}`);
    const rows = this.db.prepare(`
      SELECT * FROM subjects
      WHERE kind = ? AND owner_user_id = ? AND archived_at IS NULL AND aliases LIKE ? ESCAPE '\\'
    `).all(kind, ownerUserId, `%"${escaped}"%`) as SubjectRow[];
    // LIKE is case-sensitive on the JSON; confirm a real case-insensitive alias hit.
    const lower = alias.toLowerCase();
    for (const r of rows) {
      const list = this._parseAliases(r.aliases);
      if (list.some(a => a.toLowerCase() === lower)) return r;
    }
    return null;
  }

  // ── Self-person + assignee resolution (S4a task-cutover) ──────

  /**
   * The operator's reserved self-person subject (`is_self=1`, `kind='person'`), in
   * the {@link SELF_OWNER} scope. The person-level analog of an `is_self` FIRM: both
   * flag "the operator's OWN side of the graph" vs an external counterparty. A global
   * singleton — {@link findOrCreateSelfPerson} enforces it. Oldest-first so a
   * duplicate (never expected) resolves deterministically.
   */
  findSelfPerson(): SubjectRow | null {
    return this.db.prepare(`
      SELECT * FROM subjects
      WHERE is_self = 1 AND kind = 'person' AND owner_user_id = ? AND archived_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    `).get(SELF_OWNER) as SubjectRow | undefined ?? null;
  }

  /**
   * Find-or-seed the reserved self-person (idempotent singleton, {@link SELF_OWNER}
   * scope). Created via {@link createSubject} — NOT {@link findOrCreate} — and in its
   * OWN owner scope, so the seed can neither collide on the canonical UNIQUE index
   * nor merge into a same-named user person (self-identity is the flag + the reserved
   * scope, not the name). This lazy seed IS the S4a self-subject bootstrap — the first
   * 'user'-assigned task (live write or backfill) mints it, and nothing mints it
   * otherwise (anti-manie: no self-person until a task needs one).
   */
  findOrCreateSelfPerson(): string {
    const existing = this.findSelfPerson();
    if (existing) return existing.id;
    return this.createSubject({ kind: 'person', name: SELF_PERSON_NAME, isSelf: true, ownerUserId: SELF_OWNER });
  }

  /**
   * WRITE-path resolution of a task's free-text `assignee` to an `assignee_subject_id`:
   *   null/'' → null · 'user' → the reserved self-person · else → a person subject
   *   (canonical-deduped via {@link findOrCreate}).
   * ('lynox' never reaches here — an assignee='lynox' row is a TRIGGER, not a task,
   * split off at `task-manager.ts` `willBeTrigger`.) MAY create subjects (self-person
   * / a named person) — the caller gates this on `subject_graph_enabled` so a flag-OFF
   * engine.db stays subject-free.
   */
  resolveAssigneeToSubjectId(assignee: string | null | undefined, ownerUserId = DEFAULT_OWNER): string | null {
    const a = assignee?.trim();
    if (!a) return null;
    if (a === 'user') return this.findOrCreateSelfPerson();
    return this.findOrCreate({ kind: 'person', name: a, ownerUserId }).id;
  }

  /**
   * READ-FILTER resolution of an assignee value to a subject id WITHOUT creating
   * (a read must never write): 'user' → the existing self-person (null if unseeded),
   * else → the canonical/alias person match (null if none). A null result means the
   * caller returns NO rows — faithful to the legacy string-exact filter, which also
   * matched nothing for an assignee no task carries.
   *
   * DELIBERATE divergence from the legacy string-exact filter: because names dedupe to
   * ONE subject case-/alias-insensitively on write, a filter on any surface form of a
   * person (`'Bob'`/`'bob'`/an alias) resolves to that one subject and returns ALL of
   * their tasks — identity-based, not string-literal. This is the intended, more
   * correct behaviour (they are the same person); it never crosses the scope filter.
   */
  resolveAssigneeFilter(assignee: string, ownerUserId = DEFAULT_OWNER): string | null {
    const a = assignee.trim();
    if (!a) return null;
    if (a === 'user') return this.findSelfPerson()?.id ?? null;
    return (this.findCanonical(a, 'person', ownerUserId) ?? this.findByAlias(a, 'person', ownerUserId))?.id ?? null;
  }

  // ── Reads ─────────────────────────────────────────────────────

  getSubject(id: string): SubjectRow | null {
    return this.db.prepare('SELECT * FROM subjects WHERE id = ?').get(id) as SubjectRow | undefined ?? null;
  }

  listSubjects(opts?: { kind?: string | undefined; ownerUserId?: string | undefined; includeArchived?: boolean | undefined }): SubjectRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.kind) { where.push('kind = ?'); args.push(opts.kind); }
    if (opts?.ownerUserId) { where.push('owner_user_id = ?'); args.push(opts.ownerUserId); }
    if (!opts?.includeArchived) where.push('archived_at IS NULL');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM subjects ${clause} ORDER BY updated_at DESC`).all(...args) as SubjectRow[];
  }

  /** Count subjects, optionally restricted to a set of kinds. Active only unless `includeArchived`. */
  count(opts?: { kinds?: readonly string[] | undefined; includeArchived?: boolean | undefined }): number {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.kinds && opts.kinds.length > 0) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      args.push(...opts.kinds);
    }
    if (!opts?.includeArchived) where.push('archived_at IS NULL');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM subjects ${clause}`).get(...args) as { n: number }).n;
  }

  /** Soft-archive (queries default to active; cascades remain via FK ON DELETE on hard purge). */
  archiveSubject(id: string): void {
    this.db.prepare("UPDATE subjects SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL").run(id);
  }

  /**
   * Set (string) or clear (null) a subject's parent — the hierarchy edge the
   * context-scoping walk-up ascends (Projekt→Kunde→…). `findOrCreate`/`createSubject`
   * accept `parentId` at insert; this is the only mutator for an EXISTING subject.
   * Rejects the 1-cycle (self-parent); deeper cycle-safety is the walk-up's job
   * ({@link getAncestors}'s visited-set/depth cap — a cycle can form across several
   * setParent calls, so it is caught on the read side, not here).
   */
  setParent(subjectId: string, parentId: string | null): void {
    if (parentId === subjectId) {
      throw new Error(`setParent: a subject cannot be its own parent (${subjectId})`);
    }
    this.db.prepare(
      "UPDATE subjects SET parent_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(parentId, subjectId);
  }

  /**
   * Walk the `parent_id` chain UP from `subjectId` to the root, returning the STRICT
   * ancestors nearest-first (parent, grandparent, …) — the subject itself is excluded.
   * This is the context-scoping walk-up (Slice C): a thread anchored to a project
   * ascends Projekt→Kunde→… so recall can weight the whole hierarchy.
   *
   * Cycle-safe by construction — the deferred safety {@link setParent} names. An
   * iterative walk with an EXPLICIT visited-set terminates a `parent_id` loop (which
   * can form across several setParent calls — the 1-cycle guard alone cannot prevent
   * it), and a hard `maxDepth` cap bounds a pathological chain. Chosen over a bare
   * `WITH RECURSIVE` (getScopeTree-style): SQLite's recursive CTE cannot carry a
   * visited-set cheaply, so a cyclic edge would re-enumerate to the cap; the chain is
   * short (Kunde→Projekt = depth 1-2), so the per-hop PK lookups are negligible and
   * page-cached. A dangling `parent_id` (soft cross-ref to a purged subject) simply
   * ends the walk. Archived ancestors ARE included — the hierarchy edge is structural,
   * independent of a soft-archive.
   */
  getAncestors(subjectId: string, maxDepth = 32): SubjectRow[] {
    const out: SubjectRow[] = [];
    const visited = new Set<string>([subjectId]);
    let current = this.getSubject(subjectId);
    let depth = 0;
    while (current?.parent_id && depth < maxDepth) {
      if (visited.has(current.parent_id)) break; // cycle guard
      const parent = this.getSubject(current.parent_id);
      if (!parent) break; // dangling parent ref (purged ancestor)
      out.push(parent);
      visited.add(parent.id);
      current = parent;
      depth++;
    }
    return out;
  }

  // ── Detail tables (enc boundary lives here) ───────────────────

  /**
   * Upsert person detail — MERGE semantics: an omitted field preserves the
   * stored value (a later `{role}` call does not wipe a prior `{email}`). To set
   * a field, pass it. email/phone are encrypted at rest; name stays on `subjects`
   * (plaintext).
   */
  setPersonDetail(subjectId: string, d: PersonDetail): void {
    // `type` re-binds the raw param in DO UPDATE (NOT excluded.type) — the VALUES
    // COALESCE(?, 'contact') defaults a fresh insert, but that default would leak
    // through excluded.type and clobber a stored value on a bare update.
    this.db.prepare(`
      INSERT INTO people (subject_id, email, phone, role, type)
      VALUES (?, ?, ?, ?, COALESCE(?, 'contact'))
      ON CONFLICT(subject_id) DO UPDATE SET
        email = COALESCE(excluded.email, email),
        phone = COALESCE(excluded.phone, phone),
        role  = COALESCE(excluded.role, role),
        type  = COALESCE(?, type)
    `).run(
      subjectId,
      d.email ? this.engine.enc(d.email) : null,
      d.phone ? this.engine.enc(d.phone) : null,
      d.role ?? null,
      d.type ?? null,
      d.type ?? null,
    );
  }

  getPersonDetail(subjectId: string): (PersonDetail & { subject_id: string }) | null {
    const row = this.db.prepare('SELECT * FROM people WHERE subject_id = ?').get(subjectId) as
      { subject_id: string; email: string | null; phone: string | null; role: string | null; type: string } | undefined;
    if (!row) return null;
    return {
      subject_id: row.subject_id,
      email: row.email ? this.engine.dec(row.email) : undefined,
      phone: row.phone ? this.engine.dec(row.phone) : undefined,
      role: row.role ?? undefined,
      type: row.type,
    };
  }

  /**
   * Upsert organization detail — MERGE semantics (see {@link setPersonDetail}).
   * `vat_id` is a tax identifier (PII for sole proprietors) → encrypted at rest;
   * `domain` stays plaintext (often public + a future lookup key). Neither is
   * indexed, so encrypting vat_id breaks no query.
   */
  setOrganizationDetail(subjectId: string, d: OrganizationDetail): void {
    this.db.prepare(`
      INSERT INTO organizations (subject_id, domain, vat_id, country, type)
      VALUES (?, ?, ?, ?, COALESCE(?, 'other'))
      ON CONFLICT(subject_id) DO UPDATE SET
        domain  = COALESCE(excluded.domain, domain),
        vat_id  = COALESCE(excluded.vat_id, vat_id),
        country = COALESCE(excluded.country, country),
        type    = COALESCE(?, type)
    `).run(
      subjectId,
      d.domain ?? null,
      d.vat_id ? this.engine.enc(d.vat_id) : null,
      d.country ?? null,
      d.type ?? null,
      d.type ?? null,
    );
  }

  getOrganizationDetail(subjectId: string): (OrganizationDetail & { subject_id: string }) | null {
    const row = this.db.prepare('SELECT * FROM organizations WHERE subject_id = ?').get(subjectId) as
      { subject_id: string; domain: string | null; vat_id: string | null; country: string | null; type: string } | undefined;
    if (!row) return null;
    return {
      subject_id: row.subject_id,
      domain: row.domain ?? undefined,
      vat_id: row.vat_id ? this.engine.dec(row.vat_id) : undefined,
      country: row.country ?? undefined,
      type: row.type,
    };
  }

  // ── Retroactive merge + redirect (PR-C dedup) ─────────────────

  /**
   * Chase the `merged_into` redirect chain from `id` to its TERMINAL (the canonical a
   * duplicate was folded into). Returns `id` unchanged when it was never merged. Any stale
   * id still held somewhere (a soft cross-file ref, a cached UI id, a DataStore cell not yet
   * repointed) resolves forward through this instead of dangling on an archived stub.
   * NOTE: the terminal is normally active, but this only follows `merged_into` — it does NOT
   * assert liveness, so a canonical archived AFTER the merge yields an archived terminal; a
   * caller that needs an active subject must check `archived_at` itself. Cycle-safe
   * (visited-set + hop cap, like {@link getAncestors}); a dangling redirect ends the walk at
   * the last known id.
   */
  resolveActiveSubject(id: string, maxHops = 16): string {
    const seen = new Set<string>([id]);
    let current = this.getSubject(id);
    let hops = 0;
    while (current?.merged_into && hops < maxHops) {
      if (seen.has(current.merged_into)) break;      // cycle guard
      const next = this.getSubject(current.merged_into);
      if (!next) break;                              // dangling redirect → last known id
      seen.add(next.id);
      current = next;
      hops++;
    }
    return current?.id ?? id;
  }

  /**
   * Person-only WRITE-time subset resolver (the "Ada ⊂ Dr. Ada Lovelace" dedup
   * at the source). Tries, in order: exact canonical → alias → an UNAMBIGUOUS token
   * subset of exactly ONE active person in the owner scope (titles stripped) — folding
   * the surface form in as an ALIAS of that person rather than minting a duplicate.
   * Ambiguous (0 or ≥2 supersets — e.g. "Alan" under both "Alan Turing" and
   * "Alan Kay") falls through to a fresh subject: aliasing a mention is safe,
   * GUESSING which of two people is not. Person-only + name-cased by design (same
   * conservatism as the extractor person-shape gate).
   */
  resolvePersonSubject(
    name: string,
    opts?: { aliases?: string[] | undefined; ownerUserId?: string | undefined },
  ): { id: string; created: boolean; resolved: 'canonical' | 'alias' | 'subset' | 'created' } {
    const owner = opts?.ownerUserId ?? DEFAULT_OWNER;
    const surfaceForms = [name, ...(opts?.aliases ?? [])];
    const canonical = this.findCanonical(name, 'person', owner);
    if (canonical) { this._mergeAliases(canonical, surfaceForms); return { id: canonical.id, created: false, resolved: 'canonical' }; }
    const alias = this.findByAlias(name, 'person', owner);
    if (alias) { this._mergeAliases(alias, surfaceForms); return { id: alias.id, created: false, resolved: 'alias' }; }
    // Normalized fallback (mirrors findOrCreate): a punctuation/collapsed-whitespace variant
    // of an already-stored clean name converges — token-equal forms differ only by trailing
    // "." or doubled spaces, which findCanonical misses and the subset scan (STRICT superset)
    // won't catch, so without this a "Ada Lovelace." would mint a duplicate of "Ada Lovelace".
    const normalized = normalizeSubjectName('person', name);
    if (normalized !== name) {
      const normHit = this.findCanonical(normalized, 'person', owner);
      if (normHit) { this._mergeAliases(normHit, surfaceForms); return { id: normHit.id, created: false, resolved: 'canonical' }; }
    }

    const tokens = personNameTokens(name);
    if (tokens.length > 0) {
      // Projected id+name only (NOT listSubjects, which SELECT *s the embedding BLOB +
      // filesorts): this is the write path once wired (PR-C2), one scan per new person
      // surface form. No sort needed — we only test each candidate's token superset.
      const rows = this.db.prepare(
        "SELECT id, name FROM subjects WHERE kind = 'person' AND owner_user_id = ? AND archived_at IS NULL",
      ).all(owner) as Array<{ id: string; name: string }>;
      const supersets = rows.filter(s => isProperTokenSubset(tokens, personNameTokens(s.name)));
      if (supersets.length === 1) {
        const target = this.getSubject(supersets[0]!.id)!;
        this._mergeAliases(target, surfaceForms);
        return { id: target.id, created: false, resolved: 'subset' };
      }
      // 0 or ≥2 supersets → ambiguous → mint a fresh subject (never guess).
    }
    const id = this.createSubject({ kind: 'person', name, aliases: surfaceForms, ownerUserId: owner });
    return { id, created: true, resolved: 'created' };
  }

  /**
   * Validate a merge + capture its complete before-image, READ-ONLY (no mutation).
   * The caller persists the returned entry BEFORE calling {@link executeMerge} — a
   * merge repoints/deletes rows the ledger is the only record of, so a
   * mutate-then-crash-before-persist would be irreversible (the archive-sweep lesson).
   *
   * Refuses (returns `{ok:false}`, never throws) on: unknown id, same subject, a KIND
   * mismatch, an OWNER mismatch (NEVER crosses `owner_user_id`), either side being the
   * operator self, or either side already merged / the canonical archived. `dup` MAY be
   * already archived (a swept junk row folded into a real one) — its archive state is
   * captured + restored on rollback.
   */
  planMerge(dupId: string, canonicalId: string): MergeResult {
    const dup = this.getSubject(dupId);
    const canonical = this.getSubject(canonicalId);
    if (!dup) return { ok: false, reason: `dup subject not found: ${dupId}` };
    if (!canonical) return { ok: false, reason: `canonical subject not found: ${canonicalId}` };
    if (dup.id === canonical.id) return { ok: false, reason: 'cannot merge a subject into itself' };
    if (dup.kind !== canonical.kind) return { ok: false, reason: `kind mismatch: ${dup.kind} ≠ ${canonical.kind}` };
    if (dup.owner_user_id !== canonical.owner_user_id) return { ok: false, reason: 'owner_user_id mismatch — a merge never crosses owners' };
    if (dup.is_self === 1 || canonical.is_self === 1) return { ok: false, reason: 'cannot merge the operator self-subject' };
    if (dup.merged_into) return { ok: false, reason: `dup already merged into ${dup.merged_into}` };
    if (canonical.merged_into) return { ok: false, reason: `canonical is itself merged into ${canonical.merged_into}` };
    if (canonical.archived_at) return { ok: false, reason: 'canonical is archived' };

    const db = this.db;
    const repoints: MergeLedgerEntry['repoints'] = [];
    for (const t of REPOINT_TARGETS) {
      const rows = db.prepare(`SELECT "${t.pkCol}" AS pk FROM "${t.table}" WHERE "${t.column}" = ?`).all(dupId) as Array<{ pk: string }>;
      let pks = rows.map(r => r.pk);
      // subjects.parent_id: exclude the canonical itself (self-parent handled separately).
      if (t.table === 'subjects' && t.column === 'parent_id') pks = pks.filter(pk => pk !== canonicalId);
      if (pks.length > 0) repoints.push({ table: t.table, pkCol: t.pkCol, column: t.column, pks });
    }

    const dupMs = db.prepare('SELECT memory_id, mention_type, created_at FROM memory_subjects WHERE subject_id = ?')
      .all(dupId) as Array<{ memory_id: string; mention_type: string; created_at: string }>;
    const canonicalMs = db.prepare('SELECT memory_id FROM memory_subjects WHERE subject_id = ?')
      .all(canonicalId) as Array<{ memory_id: string }>;

    const cooccurrences = db.prepare(
      'SELECT subject_a_id AS a, subject_b_id AS b, count, last_seen_at FROM subject_cooccurrences WHERE subject_a_id = ? OR subject_b_id = ?',
    ).all(dupId, dupId) as MergeLedgerEntry['cooccurrences'];

    const detailDef = DETAIL_TABLE[dup.kind];
    const detail = detailDef
      ? {
          table: detailDef.table,
          dupRow: (db.prepare(`SELECT * FROM "${detailDef.table}" WHERE subject_id = ?`).get(dupId) as Record<string, unknown> | undefined) ?? null,
          canonicalRow: (db.prepare(`SELECT * FROM "${detailDef.table}" WHERE subject_id = ?`).get(canonicalId) as Record<string, unknown> | undefined) ?? null,
        }
      : null;

    return {
      ok: true,
      entry: {
        dupId, canonicalId, kind: dup.kind, ownerUserId: dup.owner_user_id,
        dupArchivedAtWas: dup.archived_at,
        dupMergedIntoWas: dup.merged_into,
        canonicalAliasesWas: canonical.aliases,
        canonicalParentWasDup: canonical.parent_id === dupId,
        repoints,
        memorySubjects: { dupRows: dupMs, canonicalMemoryIdsBefore: canonicalMs.map(r => r.memory_id) },
        cooccurrences,
        detail,
      },
    };
  }

  /**
   * Apply a merge from its {@link planMerge} entry, in ONE atomic transaction:
   * repoint every plain FK dup→canonical, collision-safe-repoint memory_subjects,
   * drop the dup's derived co-occurrence rows, COALESCE-merge the 1:1 detail row
   * (canonical wins, dup fills its nulls), union the dup's name+aliases onto canonical,
   * then soft-archive the dup + stamp `merged_into`. A resulting relationship self-loop
   * (canonical↔canonical, only if the two were directly related) is left as harmless
   * noise — reads skip self-loops; deleting it would break the pure-repoint symmetry
   * the rollback relies on.
   */
  executeMerge(entry: MergeLedgerEntry): void {
    const db = this.db;
    const { dupId, canonicalId } = entry;
    // Defense-in-depth: executeMerge is public (the planMerge→persist→executeMerge split
    // is what makes the ledger crash-safe), so re-assert the boundary planMerge checked —
    // a stale or hand-built entry must NEVER repoint across owner_user_id or kind.
    const dupNow = this.getSubject(dupId);
    const canonNow = this.getSubject(canonicalId);
    if (!dupNow || !canonNow) throw new Error(`executeMerge: subject vanished (${dupId} / ${canonicalId})`);
    if (dupNow.owner_user_id !== canonNow.owner_user_id) throw new Error('executeMerge: owner_user_id mismatch — a merge never crosses owners');
    if (dupNow.kind !== canonNow.kind) throw new Error(`executeMerge: kind mismatch (${dupNow.kind} ≠ ${canonNow.kind})`);
    db.transaction(() => {
      // 1. Plain FK repoints (drive off the live column; the pks are the rollback record).
      for (const t of entry.repoints) {
        if (t.table === 'subjects' && t.column === 'parent_id') {
          // Only the captured children (canonical already excluded in planMerge).
          const stmt = db.prepare("UPDATE subjects SET parent_id = ?, updated_at = datetime('now') WHERE id = ? AND parent_id = ?");
          for (const pk of t.pks) stmt.run(canonicalId, pk, dupId);
        } else {
          db.prepare(`UPDATE "${t.table}" SET "${t.column}" = ? WHERE "${t.column}" = ?`).run(canonicalId, dupId);
        }
      }
      // Self-parent guard: canonical.parent_id was the dup → the dup is gone, so drop it.
      if (entry.canonicalParentWasDup) {
        db.prepare("UPDATE subjects SET parent_id = NULL, updated_at = datetime('now') WHERE id = ?").run(canonicalId);
      }

      // 2. memory_subjects: collision-safe (a memory mentioning BOTH already has the
      //    canonical link) — INSERT OR IGNORE the canonical link, then drop dup's.
      const insMs = db.prepare('INSERT OR IGNORE INTO memory_subjects (memory_id, subject_id, mention_type, created_at) VALUES (?, ?, ?, ?)');
      for (const r of entry.memorySubjects.dupRows) insMs.run(r.memory_id, canonicalId, r.mention_type, r.created_at);
      db.prepare('DELETE FROM memory_subjects WHERE subject_id = ?').run(dupId);

      // 3. co-occurrences are a DERIVED materialization — just drop the dup's; they
      //    recompute on the next co-mention (repointing risks PK collisions + self-pairs).
      db.prepare('DELETE FROM subject_cooccurrences WHERE subject_a_id = ? OR subject_b_id = ?').run(dupId, dupId);

      // 4. detail COALESCE-merge (values are raw/ciphertext bags — never decrypted here).
      if (entry.detail) {
        const def = DETAIL_TABLE[entry.kind]!;
        if (entry.detail.dupRow && !entry.detail.canonicalRow) {
          db.prepare(`UPDATE "${def.table}" SET subject_id = ? WHERE subject_id = ?`).run(canonicalId, dupId);
        } else if (entry.detail.dupRow && entry.detail.canonicalRow) {
          const sets = def.cols.map(c => `"${c}" = COALESCE("${c}", ?)`).join(', ');
          const vals = def.cols.map(c => (entry.detail!.dupRow as Record<string, unknown>)[c] ?? null);
          db.prepare(`UPDATE "${def.table}" SET ${sets} WHERE subject_id = ?`).run(...vals, canonicalId);
          db.prepare(`DELETE FROM "${def.table}" WHERE subject_id = ?`).run(dupId);
        }
      }

      // 5. union dup's name + aliases onto canonical; 6. soft-archive dup + redirect.
      const canonicalRow = this.getSubject(canonicalId);
      const dupRow = this.getSubject(dupId);
      if (canonicalRow && dupRow) this._mergeAliases(canonicalRow, [dupRow.name, ...this._parseAliases(dupRow.aliases)]);
      db.prepare("UPDATE subjects SET merged_into = ?, archived_at = COALESCE(archived_at, datetime('now')), updated_at = datetime('now') WHERE id = ?")
        .run(canonicalId, dupId);
    })();
  }

  /**
   * Convenience: {@link planMerge} then {@link executeMerge} with no crash window
   * between (for tests + callers that persist the ledger from the returned entry
   * AFTER the fact is acceptable — the operator/agent surfaces persist BEFORE via the
   * split planMerge/executeMerge pair). Returns the same {@link MergeResult}.
   */
  mergeSubjects(dupId: string, canonicalId: string): MergeResult {
    const plan = this.planMerge(dupId, canonicalId);
    if (!plan.ok) return plan;
    this.executeMerge(plan.entry);
    return plan;
  }

  /**
   * Reverse a merge from its ledger entry, in ONE atomic transaction: un-archive +
   * un-redirect the dup (restoring its captured archive state), restore canonical's
   * exact aliases, restore the 1:1 detail rows, re-insert the derived co-occurrences,
   * split the memory_subjects links back, and repoint every captured FK back to the
   * dup. Un-archiving a name-deduped dup can (near-never — the two carried DIFFERENT
   * name forms, else they'd have auto-deduped) collide on the partial UNIQUE index. That
   * collision ABORTS the whole rollback (the transaction rolls back → the state stays
   * MERGED, never a half-reversed inconsistency) and returns `{ok:false}` — the caller
   * can leave it merged or resolve the colliding row and retry.
   */
  rollbackMerge(entry: MergeLedgerEntry): { ok: boolean; reason?: string } {
    const db = this.db;
    const { dupId, canonicalId } = entry;
    try {
      db.transaction(() => {
      // 1. restore dup archive/redirect state. A UNIQUE-index collision here THROWS →
      //    the transaction rolls back atomically (no partial reversal).
      db.prepare("UPDATE subjects SET merged_into = ?, archived_at = ?, updated_at = datetime('now') WHERE id = ?")
        .run(entry.dupMergedIntoWas, entry.dupArchivedAtWas, dupId);

      // 2. restore canonical aliases + self-parent.
      db.prepare("UPDATE subjects SET aliases = ?, updated_at = datetime('now') WHERE id = ?").run(entry.canonicalAliasesWas, canonicalId);
      if (entry.canonicalParentWasDup) db.prepare("UPDATE subjects SET parent_id = ? WHERE id = ?").run(dupId, canonicalId);

      // 3. detail rollback (inverse of the COALESCE-merge).
      if (entry.detail) {
        const def = DETAIL_TABLE[entry.kind]!;
        const cols = def.cols;
        if (entry.detail.dupRow && !entry.detail.canonicalRow) {
          // was a repoint → move it back to the dup.
          db.prepare(`UPDATE "${def.table}" SET subject_id = ? WHERE subject_id = ?`).run(dupId, canonicalId);
        } else if (entry.detail.dupRow && entry.detail.canonicalRow) {
          // was a COALESCE+delete → restore canonical's exact columns + re-insert dup's row.
          const setC = cols.map(c => `"${c}" = ?`).join(', ');
          db.prepare(`UPDATE "${def.table}" SET ${setC} WHERE subject_id = ?`)
            .run(...cols.map(c => (entry.detail!.canonicalRow as Record<string, unknown>)[c] ?? null), canonicalId);
          const insCols = ['subject_id', ...cols];
          db.prepare(`INSERT OR REPLACE INTO "${def.table}" (${insCols.map(c => `"${c}"`).join(', ')}) VALUES (${insCols.map(() => '?').join(', ')})`)
            .run(dupId, ...cols.map(c => (entry.detail!.dupRow as Record<string, unknown>)[c] ?? null));
        }
      }

      // 4. re-insert derived co-occurrences.
      const insCo = db.prepare('INSERT OR IGNORE INTO subject_cooccurrences (subject_a_id, subject_b_id, count, last_seen_at) VALUES (?, ?, ?, ?)');
      for (const c of entry.cooccurrences) insCo.run(c.a, c.b, c.count, c.last_seen_at);

      // 5. memory_subjects: re-attach dup links; drop the canonical links the merge ADDED
      //    (those in dup's set that canonical did NOT already carry before the merge).
      const canonicalBefore = new Set(entry.memorySubjects.canonicalMemoryIdsBefore);
      const insMs = db.prepare('INSERT OR IGNORE INTO memory_subjects (memory_id, subject_id, mention_type, created_at) VALUES (?, ?, ?, ?)');
      const delMs = db.prepare('DELETE FROM memory_subjects WHERE memory_id = ? AND subject_id = ?');
      for (const r of entry.memorySubjects.dupRows) {
        insMs.run(r.memory_id, dupId, r.mention_type, r.created_at);
        if (!canonicalBefore.has(r.memory_id)) delMs.run(r.memory_id, canonicalId);
      }

      // 6. plain FK repoints back to the dup (guard on still-pointing-at-canonical so a
      //    row re-assigned meanwhile is not clobbered).
      for (const t of entry.repoints) {
        const stmt = db.prepare(`UPDATE "${t.table}" SET "${t.column}" = ? WHERE "${t.pkCol}" = ? AND "${t.column}" = ?`);
        for (const pk of t.pks) stmt.run(dupId, pk, canonicalId);
      }
      })();
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true };
  }

  // ── internals ─────────────────────────────────────────────────

  private _parseAliases(raw: string): string[] {
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private _mergeAliases(row: SubjectRow, forms: string[]): void {
    const list = this._parseAliases(row.aliases);
    const seen = new Set(list.map(a => a.toLowerCase()));
    let changed = false;
    for (const f of forms) {
      const key = f.toLowerCase();
      if (!f || seen.has(key)) continue;
      list.push(f);
      seen.add(key);
      changed = true;
    }
    if (changed) {
      this.db.prepare("UPDATE subjects SET aliases = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(list), row.id);
    }
  }
}
