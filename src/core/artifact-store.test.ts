import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from './artifact-store.js';

describe('ArtifactStore', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-artifacts-'));
    store = new ArtifactStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an artifact at version 1', () => {
    const a = store.save({ title: 'Doc', content: '# hi', type: 'markdown' });
    expect(a.version).toBe(1);
    expect(store.get(a.id)?.version).toBe(1);
  });

  it('bumps version on every update via save(id)', () => {
    const a = store.save({ title: 'Doc', content: 'v1' });
    const b = store.save({ id: a.id, title: 'Doc', content: 'v2' });
    expect(b.version).toBe(2);
    const c = store.save({ id: a.id, title: 'Doc', content: 'v3' });
    expect(c.version).toBe(3);
  });

  it('pathFor returns the content file path the agent can edit', () => {
    const a = store.save({ title: 'Doc', content: 'body' });
    const p = store.pathFor(a.id);
    expect(p).toBe(join(dir, `${a.id}.html`));
    expect(readFileSync(p, 'utf-8')).toBe('body');
  });

  it('reconcile() bumps version + updatedAt when the file is edited externally', () => {
    const a = store.save({ title: 'Doc', content: 'original' });
    const p = store.pathFor(a.id);

    // Simulate an edit via the standard file tools / bash, with a future mtime.
    writeFileSync(p, 'edited by file tool', 'utf-8');
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future);

    const got = store.get(a.id);
    expect(got?.content).toBe('edited by file tool');
    expect(got?.version).toBe(2); // 1 (create) → 2 (external edit)
    // list() also reflects it without a second bump (idempotent)
    expect(store.list().find(m => m.id === a.id)?.version).toBe(2);
  });

  it('adopts orphan <id>.html files dropped in directly', () => {
    const orphanId = 'abcdef12';
    writeFileSync(join(dir, `${orphanId}.html`), '<p>dropped in</p>', 'utf-8');
    const listed = store.list();
    const adopted = listed.find(m => m.id === orphanId);
    expect(adopted).toBeDefined();
    expect(adopted?.version).toBe(1);
    expect(store.get(orphanId)?.content).toBe('<p>dropped in</p>');
  });

  it('normalizes legacy index entries without a version field to 1', () => {
    const a = store.save({ title: 'Doc', content: 'x' });
    // Rewrite index.json stripping the version field (legacy shape).
    const indexPath = join(dir, 'index.json');
    const legacy = (JSON.parse(readFileSync(indexPath, 'utf-8')) as Array<Record<string, unknown>>)
      .map(({ version, ...rest }) => rest);
    writeFileSync(indexPath, JSON.stringify(legacy), 'utf-8');

    const reloaded = new ArtifactStore(dir);
    expect(reloaded.get(a.id)?.version).toBe(1);
  });
});
