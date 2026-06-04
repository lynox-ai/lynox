/**
 * ArtifactStore — persistent storage for agent-generated artifacts.
 *
 * Artifacts are interactive creations (dashboards, diagrams, reports) that
 * the user wants to keep beyond the chat session. Stored as JSON index +
 * individual content files in ~/.lynox/artifacts/.
 */
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getLynoxDir } from './config.js';

const SAFE_ID = /^[a-f0-9-]{8}$/;

/** How many prior versions to retain per artifact. A small ring — enough to
 *  recover from an accidental clobber (the "v2 → v7 wrong-name" case) without
 *  growing the store unbounded. Oldest beyond this are pruned on each save. */
const MAX_VERSIONS = 10;

/** `csv`/`tsv`/`json`/`text` are downloadable data files — they render in the
 *  chat as a code preview with a download button, not as an HTML iframe. */
export type ArtifactType = 'html' | 'mermaid' | 'svg' | 'markdown' | 'csv' | 'tsv' | 'json' | 'text';

export interface ArtifactMeta {
  id: string;
  title: string;
  description: string;
  type: ArtifactType;
  createdAt: string;
  updatedAt: string;
  threadId: string;
  /** Bumped on every save AND on every external edit (file tools / bash)
   *  detected by reconcile(). Legacy entries without it normalize to 1. */
  version: number;
}

export interface Artifact extends ArtifactMeta {
  content: string;
  /** Populated ONLY when save() overwrote an existing artifact. Lets the
   *  caller surface the overwrite (and a recovery path) instead of silently
   *  replacing good content — the "v2 → v7 wrong-name clobber" failure mode
   *  (rafael 2026-06-04, lynox Marktanalyse). Absent on create. */
  overwrite?: ArtifactOverwrite;
}

export interface ArtifactOverwrite {
  previousVersion: number;
  previousBytes: number;
  newBytes: number;
  /** The prior content, snapshotted into the version history before the
   *  overwrite (a `versions/<id>.v<n>.html` file) — recover with read_file or
   *  artifact_restore. Up to MAX_VERSIONS steps are kept. */
  backupPath: string;
  /** Large replacement (content shrank to <50% of the previous size) — a
   *  likely accidental full-rewrite worth a second look. */
  significant: boolean;
}

export class ArtifactStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private index: ArtifactMeta[] = [];

  constructor(dir?: string) {
    this.dir = dir ?? join(getLynoxDir(), 'artifacts');
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, 'index.json');
    this.loadIndex();
  }

  private loadIndex(): void {
    try {
      if (existsSync(this.indexPath)) {
        const raw = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as ArtifactMeta[];
        // Normalize legacy entries that predate the `version` field.
        this.index = raw.map(m => ({ ...m, version: m.version ?? 1 }));
      }
    } catch {
      this.index = [];
    }
  }

  /**
   * Read-through reconciliation: artifacts live at a fixed path the agent can
   * reach with the standard file tools (read_file / edit / bash). When a
   * content file is edited externally, its mtime moves ahead of the index —
   * we detect that here and bump version + updatedAt so the gallery stays
   * truthful without a filesystem watcher. Also adopts content files created
   * directly via file tools (named `<id>.html`). Called on every list()/get().
   */
  private reconcile(): void {
    let changed = false;

    for (const meta of this.index) {
      let p: string;
      try { p = this.contentPath(meta.id); } catch { continue; }
      if (!existsSync(p)) continue;
      const mtimeMs = statSync(p).mtimeMs;
      const indexedMs = Date.parse(meta.updatedAt);
      // 1s tolerance: our own writeFileSync sets mtime ~= updatedAt.
      if (Number.isFinite(indexedMs) && mtimeMs > indexedMs + 1000) {
        meta.updatedAt = new Date(mtimeMs).toISOString();
        meta.version += 1;
        changed = true;
      }
    }

    // Adopt orphan content files (well-formed `<id>.html`) dropped in directly.
    let entries: string[];
    try { entries = readdirSync(this.dir); } catch { entries = []; }
    for (const f of entries) {
      if (!f.endsWith('.html')) continue;
      const id = f.slice(0, -'.html'.length);
      if (!SAFE_ID.test(id) || this.index.some(a => a.id === id)) continue;
      const st = statSync(join(this.dir, f));
      const iso = new Date(st.mtimeMs).toISOString();
      this.index.push({
        id, title: id, description: '', type: 'html',
        createdAt: iso, updatedAt: iso, threadId: '', version: 1,
      });
      changed = true;
    }

    if (changed) this.saveIndex();
  }

  /** Absolute path of an artifact's content file — surfaced to the agent so it
   *  can read/edit artifacts with the standard file tools. */
  pathFor(id: string): string {
    return this.contentPath(id);
  }

  private versionsDir(): string {
    return join(this.dir, 'versions');
  }

  /** Path of a stored prior version. Versions live in a `versions/` subdir so
   *  reconcile()'s top-level `<id>.html` orphan scan never sees them. */
  private versionPath(id: string, n: number): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid artifact ID: ${id}`);
    if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid version: ${n}`);
    const dir = this.versionsDir();
    const p = resolve(dir, `${id}.v${n}.html`);
    if (!p.startsWith(dir)) throw new Error('Path traversal detected');
    return p;
  }

  private listVersionNumbers(id: string): number[] {
    // Defensive: every internal caller already holds a stored SAFE_ID, but
    // this guards the public history() path so an unvalidated id can never be
    // interpolated into the RegExp below. SAFE_ID's charset is regex-literal.
    if (!SAFE_ID.test(id)) return [];
    let entries: string[];
    try { entries = readdirSync(this.versionsDir()); } catch { return []; }
    const re = new RegExp(`^${id}\\.v(\\d+)\\.html$`);
    const out: number[] = [];
    for (const f of entries) {
      const m = re.exec(f);
      if (m) out.push(parseInt(m[1]!, 10));
    }
    return out;
  }

  /** Snapshot content as version `n`, then prune to the newest MAX_VERSIONS. */
  private snapshotVersion(id: string, n: number, content: string): string {
    mkdirSync(this.versionsDir(), { recursive: true });
    const p = this.versionPath(id, n);
    writeFileSync(p, content, 'utf-8');
    const nums = this.listVersionNumbers(id).sort((a, b) => b - a);
    for (const old of nums.slice(MAX_VERSIONS)) {
      try { unlinkSync(this.versionPath(id, old)); } catch { /* already gone */ }
    }
    return p;
  }

  /** Prior versions available for rollback, newest first. Captures save()-path
   *  overwrites; external file-tool edits bump the version but can't be
   *  snapshotted retroactively (the prior bytes are already gone from disk). */
  history(id: string): Array<{ version: number; bytes: number; savedAt: string }> {
    return this.listVersionNumbers(id)
      .sort((a, b) => b - a)
      .map(n => {
        const st = statSync(this.versionPath(id, n));
        return { version: n, bytes: st.size, savedAt: new Date(st.mtimeMs).toISOString() };
      });
  }

  /** Roll an artifact back to a stored prior version. The restore is itself a
   *  save(), so the CURRENT content is snapshotted first (rollback is
   *  reversible) and the artifact bumps to a fresh version. Returns null if the
   *  artifact or that version is missing. */
  restore(id: string, version: number): Artifact | null {
    const meta = this.index.find(a => a.id === id);
    if (!meta) return null;
    let content: string;
    try { content = readFileSync(this.versionPath(id, version), 'utf-8'); }
    catch { return null; }
    return this.save({ id, title: meta.title, content, type: meta.type, description: meta.description });
  }

  private saveIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
  }

  private contentPath(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid artifact ID: ${id}`);
    const p = resolve(this.dir, `${id}.html`);
    if (!p.startsWith(this.dir)) throw new Error('Path traversal detected');
    return p;
  }

  save(opts: { title: string; content: string; type?: ArtifactType; description?: string; threadId?: string; id?: string }): Artifact {
    const existing = opts.id ? this.index.find(a => a.id === opts.id) : undefined;
    const now = new Date().toISOString();

    if (existing) {
      // Update existing artifact. Snapshot the prior content to a one-level
      // backup BEFORE overwriting so an accidental full-rewrite is recoverable
      // (rafael 2026-06-04: a later session clobbered a good version with no
      // trace). Best-effort — a missing/unreadable prior file never blocks.
      const previousVersion = existing.version;
      let previousBytes = 0;
      let backupPath = '';
      try {
        const prev = readFileSync(this.contentPath(existing.id), 'utf-8');
        previousBytes = Buffer.byteLength(prev, 'utf-8');
        // Snapshot the version being replaced into the history ring (supersedes
        // the old single .bak — now up to MAX_VERSIONS recoverable steps).
        backupPath = this.snapshotVersion(existing.id, previousVersion, prev);
      } catch { /* no prior content to back up */ }

      existing.title = opts.title || existing.title;
      existing.description = opts.description ?? existing.description;
      existing.type = opts.type ?? existing.type;
      existing.updatedAt = now;
      existing.version += 1;
      writeFileSync(this.contentPath(existing.id), opts.content, 'utf-8');
      this.saveIndex();

      const newBytes = Buffer.byteLength(opts.content, 'utf-8');
      const overwrite: ArtifactOverwrite = {
        previousVersion,
        previousBytes,
        newBytes,
        backupPath,
        // Shrank to under half the prior size → likely a destructive rewrite.
        significant: previousBytes > 0 && newBytes < previousBytes * 0.5,
      };
      return { ...existing, content: opts.content, overwrite };
    }

    // Create new artifact
    const id = randomUUID().slice(0, 8);
    const meta: ArtifactMeta = {
      id,
      title: opts.title,
      description: opts.description ?? '',
      type: opts.type ?? 'html',
      createdAt: now,
      updatedAt: now,
      threadId: opts.threadId ?? '',
      version: 1,
    };
    this.index.push(meta);
    writeFileSync(this.contentPath(id), opts.content, 'utf-8');
    this.saveIndex();
    return { ...meta, content: opts.content };
  }

  get(id: string): Artifact | null {
    this.reconcile();
    const meta = this.index.find(a => a.id === id);
    if (!meta) return null;
    try {
      const content = readFileSync(this.contentPath(id), 'utf-8');
      return { ...meta, content };
    } catch {
      return null;
    }
  }

  list(): ArtifactMeta[] {
    this.reconcile();
    return [...this.index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  delete(id: string): boolean {
    const idx = this.index.findIndex(a => a.id === id);
    if (idx === -1) return false;
    this.index.splice(idx, 1);
    try { unlinkSync(this.contentPath(id)); } catch { /* file may not exist */ }
    for (const n of this.listVersionNumbers(id)) {
      try { unlinkSync(this.versionPath(id, n)); } catch { /* already gone */ }
    }
    this.saveIndex();
    return true;
  }
}
