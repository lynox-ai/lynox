/**
 * ArtifactStore — persistent storage for agent-generated artifacts.
 *
 * Artifacts are interactive creations (dashboards, diagrams, reports) that
 * the user wants to keep beyond the chat session. Stored as JSON index +
 * individual content files in ~/.lynox/artifacts/.
 */
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getLynoxDir } from './config.js';

const SAFE_ID = /^[a-f0-9-]{8}$/;

export type ArtifactType = 'html' | 'mermaid' | 'svg' | 'markdown';

export interface ArtifactMeta {
  id: string;
  title: string;
  description: string;
  type: ArtifactType;
  createdAt: string;
  updatedAt: string;
  threadId: string;
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
        this.index = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as ArtifactMeta[];
      }
    } catch {
      this.index = [];
    }
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
    };
    this.index.push(meta);
    writeFileSync(this.contentPath(id), opts.content, 'utf-8');
    this.saveIndex();
    return { ...meta, content: opts.content };
  }

  get(id: string): Artifact | null {
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
