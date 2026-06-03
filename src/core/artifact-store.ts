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
      // Update existing artifact
      existing.title = opts.title || existing.title;
      existing.description = opts.description ?? existing.description;
      existing.type = opts.type ?? existing.type;
      existing.updatedAt = now;
      existing.version += 1;
      writeFileSync(this.contentPath(existing.id), opts.content, 'utf-8');
      this.saveIndex();
      return { ...existing, content: opts.content };
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
    this.saveIndex();
    return true;
  }
}
