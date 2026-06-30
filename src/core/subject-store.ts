import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';

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
 * The kinds the canonical-UNIQUE dedup guard covers (per `idx_subjects_canonical`).
 * MUST stay in sync with the index DDL predicate (engine-db.ts) + findCanonical's
 * kind-IN list. `engagement` (identity = provider×client×period) and `other`
 * (unstructured) are deliberately excluded — they are not name-identified.
 */
const NAME_DEDUP_KINDS: ReadonlySet<string> = new Set(['person', 'organization', 'product', 'service']);

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
      const existing = this.findCanonical(params.name, params.kind, owner)
        ?? this.findByAlias(params.name, params.kind, owner);
      if (existing) {
        // Fold the caller's surface forms into the existing subject's aliases
        // (case-insensitive — case-variants of an existing alias are no-ops).
        this._mergeAliases(existing, [params.name, ...(params.aliases ?? [])]);
        return { id: existing.id, created: false };
      }
    }
    return { id: this.createSubject(params), created: true };
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

  /** Soft-archive (queries default to active; cascades remain via FK ON DELETE on hard purge). */
  archiveSubject(id: string): void {
    this.db.prepare("UPDATE subjects SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL").run(id);
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
