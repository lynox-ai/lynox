import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A platform without O_NOFOLLOW (Windows) cannot open the store's directory as a handle; there
 * the store reads and writes by name, as it did before, rather than not at all.
 */

vi.mock('./workspace-fd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-fd.js')>();
  return {
    ...actual,
    openAnchor: () => { throw new actual.WorkspaceAccessError('UNSUPPORTED', 'fd-based workspace access is not available on win32'); },
  };
});

const { ArtifactStore } = await import('./artifact-store.js');

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-store-unsup-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ArtifactStore where handles are not available', () => {
  it('creates, updates, versions, prunes, restores and reads by name', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'v1' });
    for (let n = 2; n <= 13; n++) store.save({ id: a.id, title: 't', content: `v${n}` });
    expect(readFileSync(join(dir, `${a.id}.html`), 'utf-8')).toBe('v13');
    expect(readdirSync(join(dir, 'versions'))).toHaveLength(10);
    expect(store.restore(a.id, 12)?.content).toBe('v12');
    expect(new ArtifactStore(dir).get(a.id)?.content).toBe('v12');
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'))).toHaveLength(1);
    expect(store.delete(a.id)).toBe(true);
    expect(readdirSync(join(dir, 'versions'))).toHaveLength(0);
  });
});
