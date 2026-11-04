/**
 * ArtifactStore — persistent storage for agent-generated artifacts.
 *
 * Artifacts are interactive creations (dashboards, diagrams, reports) that
 * the user wants to keep beyond the chat session. Stored as JSON index +
 * individual content files in ~/.lynox/artifacts/.
 */
import { dirname, join, resolve } from 'node:path';
import { closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, unlinkSync, existsSync, statSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getLynoxDir } from './config.js';
import { containsEvictionMarker } from './artifact-eviction.js';
import {
  closeAnchor, listDir, openAnchor, openRead, openWrite, readFdCapped, readFileAt, unlinkAt, writeFileAt, WorkspaceAccessError, type WorkspaceAnchor,
} from './workspace-fd.js';
import { creatingUmask } from './workspace-rel.js';

const SAFE_ID = /^[a-f0-9-]{8}$/;

/** Whether `id` has the shape of an artifact id: a row may name it then, and `save` keeps it. */
export function isArtifactId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}

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
  /** Set when the content file is the engine's placeholder for a saved body
   *  rather than a document: a save that stored the placeholder lost the
   *  document. `artifact_save` and the file tools refuse such content now;
   *  this marks files written before they did, or by a path without that
   *  check. Computed on read, never written to the index; absent when the file
   *  is fine, larger than a placeholder can leave, or unreadable. */
  lostOnSave?: true;
}

export interface Artifact extends ArtifactMeta {
  content: string;
  /** Populated ONLY when save() overwrote an existing artifact. Lets the
   *  caller surface the overwrite (and a recovery path) instead of silently
   *  replacing good content — the "v2 → v7 wrong-name clobber" failure mode
   *  (2026-06-04, lynox Marktanalyse). Absent on create. */
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

/** The placeholder forms are a few hundred bytes at most, so a document lost
 *  by saving one left a file of about that size, a heading at most around it.
 *  Its own number, not EVICTION_MIN_CHARS: that is a minimum BODY length in
 *  chars, and lowering it must not stop lost files from being marked. A larger file that contains the placeholder is a document that
 *  quotes it, or one with a copied placeholder inside — it is still readable,
 *  and the notice the UI shows ("only a placeholder was stored") would be false. */
const LOST_ON_SAVE_MAX_BYTES = 2048;

/** `bytes` is the file's size on disk, the number list() reads by stat — not
 *  the decoded string's length, which grows where the file is not valid UTF-8. */
function isLostOnSave(bytes: number, content: string): boolean {
  return bytes <= LOST_ON_SAVE_MAX_BYTES && containsEvictionMarker(content);
}

/** Thrown by {@link ArtifactStore.save} for content that holds only the engine's placeholder for
 *  an already saved document ({@link isLostOnSave}). Each caller words it for whoever reads it. */
export class ArtifactPlaceholderError extends Error {
  constructor() {
    super('The content holds only the engine\'s placeholder for a saved document, not a document. Nothing was saved.');
    this.name = 'ArtifactPlaceholderError';
  }
}

/**
 * Thrown by {@link ArtifactStore.save} when the artifact's file is a link, or has a second name (a
 * hard link): the store writes neither through, so nothing was written. Each caller words it.
 */
export class ArtifactFileRefusedError extends Error {
  constructor(readonly reason: 'link' | 'second-name', readonly path: string) {
    super(reason === 'link'
      ? `${path}: a link on the way to the file is not followed; nothing was written`
      : `${path} has more than one name (a hard link); nothing was written`);
    this.name = 'ArtifactFileRefusedError';
  }
}

/**
 * The store reaches its files through an open handle on its directory, each component below it
 * opened without following links: a link put into the directory (by bash, say) is neither written
 * through nor read through. A platform without that kind of open (Windows) uses names, as before.
 */
export class ArtifactStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private index: ArtifactMeta[] = [];
  /** The directory as resolved when the store was made (an operator may have linked it); the
   *  handle opens this path, so a link put in the directory's place later is not followed. */
  private anchorDir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(getLynoxDir(), 'artifacts');
    mkdirSync(this.dir, { recursive: true });
    this.anchorDir = realpathSync(this.dir);
    this.indexPath = join(this.dir, 'index.json');
    this.loadIndex();
  }

  /**
   * GDPR Art. 17: forget every artifact this instance has indexed. The erasure removes the
   * directory; without this the gallery keeps listing the erased titles from memory, and
   * the next save writes them back into `index.json`.
   */
  forgetAll(): void {
    this.index = [];
    mkdirSync(this.dir, { recursive: true });
    this.anchorDir = realpathSync(this.dir);
  }

  /** Run `op` on an open handle of the store's directory; `byName` where the platform has none. */
  private atDir<T>(op: (anchor: WorkspaceAnchor) => T, byName: () => T): T {
    let anchor: WorkspaceAnchor;
    try {
      anchor = openAnchor(this.anchorDir);
    } catch (err) {
      if (err instanceof WorkspaceAccessError && err.code === 'UNSUPPORTED') return byName();
      throw err;
    }
    try {
      return op(anchor);
    } finally {
      closeAnchor(anchor);
    }
  }

  /** Read a file below the directory; a link on the way is refused, not followed. */
  private readRel(rel: string): Buffer {
    return this.atDir(anchor => readFileAt(anchor, rel), () => readFileSync(join(this.dir, rel)));
  }

  /**
   * Read an artifact's content or a version, as {@link readRel}, and refuse a file with a second
   * name too: that name may be a file outside the directory, which a snapshot or a restore would
   * copy into an artifact. Not for the index: an index read as missing is written anew, empty.
   */
  private readArtifactRel(rel: string): Buffer {
    return this.atDir(anchor => {
      const fd = openRead(anchor, rel);
      try {
        if (fstatSync(fd).nlink > 1) throw new ArtifactFileRefusedError('second-name', join(this.dir, rel));
        return readFdCapped(fd, Number.MAX_SAFE_INTEGER, rel);
      } finally {
        closeSync(fd);
      }
    }, () => readFileSync(join(this.dir, rel)));
  }

  /**
   * Write an artifact's content in place, its inode kept (the file tools edit the same file),
   * creating it when missing. A link at the file and a file with a second name are refused.
   */
  private writeContent(rel: string, data: string): void {
    const path = join(this.dir, rel);
    this.atDir(anchor => {
      const umask = creatingUmask();
      let fd: number;
      try {
        ({ fd } = openWrite(anchor, rel, { createMode: 0o666 & ~umask }));
      } catch (err) {
        if (err instanceof WorkspaceAccessError && err.code === 'SYMLINK') throw new ArtifactFileRefusedError('link', path);
        throw err;
      }
      try {
        const st = fstatSync(fd);
        if (st.nlink > 1) throw new ArtifactFileRefusedError('second-name', path);
        if (st.size > 0) ftruncateSync(fd, 0);
        writeFileSync(fd, data, 'utf-8');
      } finally {
        closeSync(fd);
      }
    }, () => writeFileSync(path, data, 'utf-8'));
  }

  /** Replace a file the store alone keeps (the index, a version): a new file renamed over it, so a link there is replaced, not followed. */
  private replaceRel(rel: string, data: string): void {
    const umask = creatingUmask();
    this.atDir(
      anchor => writeFileAt(anchor, rel, data, { fileMode: 0o666 & ~umask, dirMode: 0o777 & ~umask }),
      () => {
        mkdirSync(dirname(join(this.dir, rel)), { recursive: true });
        writeFileSync(join(this.dir, rel), data, 'utf-8');
      },
    );
  }

  private loadIndex(): void {
    try {
      if (existsSync(this.indexPath)) {
        const raw = JSON.parse(this.readRel('index.json').toString('utf-8')) as ArtifactMeta[];
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
      // A regular file only: a link named like an artifact is not adopted as one.
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(join(this.dir, f)); } catch { continue; }
      if (!st.isFile()) continue;
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
    try {
      // Regular files only: a link named like a version is not one of the store's.
      entries = this.atDir(
        anchor => listDir(anchor, 'versions').filter(e => e.type === 'file' && e.exactName).map(e => e.name),
        () => readdirSync(this.versionsDir()),
      );
    } catch { return []; }
    const re = new RegExp(`^${id}\\.v(\\d+)\\.html$`);
    const out: number[] = [];
    for (const f of entries) {
      const m = re.exec(f);
      if (m) out.push(parseInt(m[1]!, 10));
    }
    return out;
  }

  private versionRel(id: string, n: number): string {
    this.versionPath(id, n); // validates id and n
    return `versions/${id}.v${n}.html`;
  }

  private unlinkVersion(id: string, n: number): void {
    const rel = this.versionRel(id, n);
    this.atDir(anchor => unlinkAt(anchor, rel), () => unlinkSync(this.versionPath(id, n)));
  }

  /** Snapshot content as version `n`, then prune to the newest MAX_VERSIONS. */
  private snapshotVersion(id: string, n: number, content: string): string {
    this.replaceRel(this.versionRel(id, n), content);
    const nums = this.listVersionNumbers(id).sort((a, b) => b - a);
    for (const old of nums.slice(MAX_VERSIONS)) {
      try { this.unlinkVersion(id, old); } catch { /* already gone */ }
    }
    return this.versionPath(id, n);
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
   *  artifact or that version is missing; a version that holds only the placeholder
   *  is refused like any save ({@link ArtifactPlaceholderError}). */
  restore(id: string, version: number): Artifact | null {
    const meta = this.index.find(a => a.id === id);
    if (!meta) return null;
    let content: string;
    try { content = this.readArtifactRel(this.versionRel(id, version)).toString('utf-8'); }
    catch { return null; }
    return this.save({ id, title: meta.title, content, type: meta.type, description: meta.description });
  }

  private saveIndex(): void {
    this.replaceRel('index.json', JSON.stringify(this.index, null, 2));
  }

  private contentPath(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid artifact ID: ${id}`);
    const p = resolve(this.dir, `${id}.html`);
    if (!p.startsWith(this.dir)) throw new Error('Path traversal detected');
    return p;
  }

  save(opts: { title: string; content: string; type?: ArtifactType; description?: string; threadId?: string; id?: string }): Artifact {
    // In the store, so every way that saves (the gallery route, a restore, a later caller) is
    // held to it, before anything is written: an update cannot replace a real document with it.
    // The same test as the "lost on save" mark: content no larger than the placeholder leaves.
    // A larger document that quotes it is still a document and is saved. artifact_save refuses
    // any content that contains it, before it gets here.
    if (isLostOnSave(Buffer.byteLength(opts.content, 'utf-8'), opts.content)) throw new ArtifactPlaceholderError();
    const existing = opts.id ? this.index.find(a => a.id === opts.id) : undefined;
    const now = new Date().toISOString();

    if (existing) {
      // Update existing artifact. Snapshot the prior content to a one-level
      // backup BEFORE overwriting so an accidental full-rewrite is recoverable
      // (2026-06-04: a later session clobbered a good version with no
      // trace). Best-effort — a missing/unreadable prior file never blocks.
      const previousVersion = existing.version;
      let previousBytes = 0;
      let backupPath = '';
      try {
        this.contentPath(existing.id); // validates the id
        const prev = this.readArtifactRel(`${existing.id}.html`).toString('utf-8');
        previousBytes = Buffer.byteLength(prev, 'utf-8');
        // Snapshot the version being replaced into the history ring (supersedes
        // the old single .bak — now up to MAX_VERSIONS recoverable steps).
        backupPath = this.snapshotVersion(existing.id, previousVersion, prev);
      } catch { /* no prior content to back up */ }

      // The content first: a refused write leaves the entry as it was.
      this.contentPath(existing.id); // validates the id
      this.writeContent(`${existing.id}.html`, opts.content);
      existing.title = opts.title || existing.title;
      existing.description = opts.description ?? existing.description;
      existing.type = opts.type ?? existing.type;
      existing.updatedAt = now;
      existing.version += 1;
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

    // Create new artifact. If the caller supplied an `id` we couldn't find
    // above (an intended UPDATE to an artifact missing from the index), honor
    // that id when it's well-formed instead of minting a fresh random one — so
    // the save is idempotent: a retry finds + updates THIS artifact rather than
    // silently forking another divergent duplicate the caller can't open.
    const id = opts.id && SAFE_ID.test(opts.id) ? opts.id : randomUUID().slice(0, 8);
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
    this.contentPath(id); // validates the id
    this.writeContent(`${id}.html`, opts.content);
    this.index.push(meta);
    this.saveIndex();
    return { ...meta, content: opts.content };
  }

  get(id: string): Artifact | null {
    this.reconcile();
    const meta = this.index.find(a => a.id === id);
    if (!meta) return null;
    try {
      this.contentPath(id); // validates the id
      const raw = this.readArtifactRel(`${id}.html`);
      const content = raw.toString('utf-8');
      return { ...meta, ...(isLostOnSave(raw.length, content) ? { lostOnSave: true as const } : {}), content };
    } catch {
      return null;
    }
  }

  list(): ArtifactMeta[] {
    this.reconcile();
    return this.index
      .map(m => (this.isLostOnSave(m.id) ? { ...m, lostOnSave: true as const } : { ...m }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** `lostOnSave` for an indexed artifact, read from its file. A file larger
   *  than a placeholder can leave is not read at all. */
  private isLostOnSave(id: string): boolean {
    try {
      const p = this.contentPath(id);
      if (statSync(p).size > LOST_ON_SAVE_MAX_BYTES) return false;
      return containsEvictionMarker(this.readArtifactRel(`${id}.html`).toString('utf-8'));
    } catch {
      return false;
    }
  }

  delete(id: string): boolean {
    const idx = this.index.findIndex(a => a.id === id);
    if (idx === -1) return false;
    this.index.splice(idx, 1);
    try { unlinkSync(this.contentPath(id)); } catch { /* file may not exist */ }
    for (const n of this.listVersionNumbers(id)) {
      try { this.unlinkVersion(id, n); } catch { /* already gone */ }
    }
    this.saveIndex();
    return true;
  }
}
