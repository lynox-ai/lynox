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

  it('backs up the previous content and reports overwrite info on update', () => {
    const a = store.save({ title: 'Deck', content: 'A'.repeat(1000) });
    expect(a.overwrite).toBeUndefined(); // create → no overwrite

    const b = store.save({ id: a.id, title: 'Deck', content: 'B'.repeat(1200) });
    expect(b.overwrite).toBeDefined();
    expect(b.overwrite?.previousVersion).toBe(1);
    expect(b.overwrite?.previousBytes).toBe(1000);
    expect(b.overwrite?.newBytes).toBe(1200);
    expect(b.overwrite?.significant).toBe(false); // grew, not a destructive shrink
    // Prior content recoverable from the snapshotted version (in versions/).
    expect(readFileSync(b.overwrite!.backupPath, 'utf-8')).toBe('A'.repeat(1000));
    expect(b.overwrite!.backupPath).toContain('versions');
    expect(b.overwrite!.backupPath).toContain(`${a.id}.v1.html`); // the replaced version
  });

  it('flags a destructive shrink (content <50% of prior) as significant', () => {
    const a = store.save({ title: 'Deck', content: 'X'.repeat(2000) });
    const b = store.save({ id: a.id, title: 'Deck', content: 'tiny' });
    expect(b.overwrite?.significant).toBe(true);
    // The good prior version is still recoverable.
    expect(readFileSync(b.overwrite!.backupPath, 'utf-8')).toBe('X'.repeat(2000));
  });

  it('does not adopt version snapshots as phantom artifacts', () => {
    const a = store.save({ title: 'Doc', content: 'one' });
    store.save({ id: a.id, title: 'Doc', content: 'two' });
    // The versions/ subdir + its files are invisible to the orphan scan.
    expect(store.list().filter(m => m.id === a.id)).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  it('keeps a version history and restores a prior version (itself reversible)', () => {
    const a = store.save({ title: 'Doc', content: 'v1-content' });        // v1
    store.save({ id: a.id, title: 'Doc', content: 'v2-content' });        // v2 (snapshots v1)
    store.save({ id: a.id, title: 'Doc', content: 'v3-content' });        // v3 (snapshots v2)
    expect(store.get(a.id)?.version).toBe(3);

    const hist = store.history(a.id);
    expect(hist.map(h => h.version)).toEqual([2, 1]); // newest-first, prior versions only
    expect(hist[0]).toMatchObject({ version: 2 });
    expect(typeof hist[0]!.bytes).toBe('number');
    expect(hist[0]!.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Restore v1: content comes back AND the restore is a new version (the
    // current v3 is snapshotted first, so restore is reversible).
    const restored = store.restore(a.id, 1);
    expect(restored?.content).toBe('v1-content');
    expect(restored?.version).toBe(4);
    expect(store.get(a.id)?.content).toBe('v1-content');
    // v3 was snapshotted during the restore → now in history.
    expect(store.history(a.id).map(h => h.version)).toEqual([3, 2, 1]);

    expect(store.restore(a.id, 99)).toBeNull(); // missing version
    expect(store.restore('ffffffff', 1)).toBeNull(); // missing artifact
  });

  it('prunes the version ring to the newest MAX_VERSIONS (10)', () => {
    const a = store.save({ title: 'Doc', content: 'gen-0' });
    for (let i = 1; i <= 14; i++) store.save({ id: a.id, title: 'Doc', content: `gen-${i}` });
    // 15 total saves → 14 prior versions exist, but only the newest 10 kept.
    const versions = store.history(a.id).map(h => h.version);
    expect(versions).toHaveLength(10);
    expect(versions[0]).toBe(14);  // newest prior
    expect(versions[versions.length - 1]).toBe(5); // oldest kept (14..5)
  });

  it('removes version snapshots when the artifact is deleted', () => {
    const a = store.save({ title: 'Doc', content: 'one' });
    store.save({ id: a.id, title: 'Doc', content: 'two' });
    expect(store.history(a.id)).toHaveLength(1);
    store.delete(a.id);
    expect(store.history(a.id)).toHaveLength(0);
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
