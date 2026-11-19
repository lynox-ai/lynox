import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { ArtifactStore, ArtifactPlaceholderError } from './artifact-store.js';
import { evictSavedArtifactBodies, EVICTION_MIN_CHARS } from './artifact-eviction.js';
import { artifactRestoreTool } from '../tools/builtin/artifact.js';
import { OWNER_PRINCIPAL } from './request-principal.js';

// The store refuses content that holds only the engine's placeholder for an already saved
// document, by the same test as the "lost on save" mark, whichever way the save comes:
// artifact_save checked it before, the gallery route and a restore did not. A restore of a
// version like that is refused the same way, and artifact_restore says so. A larger document
// that quotes the placeholder is still a document, and is saved and restored.

// The two forms a model can copy: the note the real eviction appends, built rather than typed,
// and the in-field form older threads still carry.
function placeholders(): Array<[string, string]> {
  const result = 'Saved artifact "Pitch" (id: ab12cd34, v1).\nFile: /x/ab12cd34.html';
  const turn = [
    { role: 'user', content: 'write it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'artifact_save', input: { title: 'Pitch', content: 'x'.repeat(EVICTION_MIN_CHARS + 1) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: result }] },
  ] as BetaMessageParam[];
  const evicted = (evictSavedArtifactBodies(turn)[2]!.content as Array<{ content: string }>)[0]!.content;
  const note = evicted.slice(result.length).trim();
  if (note === '') throw new Error('eviction did not run — the test fixture is wrong');
  return [
    ['note', note],
    ['in-field form', '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]'],
  ];
}

const GOOD = '<h1>Pitch</h1><p>Three budget options.</p>';

let dir: string;
let store: ArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-artifact-placeholder-'));
  store = new ArtifactStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const restore = (id: string, version: number): Promise<string> =>
  artifactRestoreTool.handler({ id, version } as never, { principal: OWNER_PRINCIPAL, toolContext: { artifactStore: store } } as never) as Promise<string>;

describe('ArtifactStore.save refuses the placeholder', () => {
  it('as a new artifact: nothing is stored', () => {
    for (const [form, placeholder] of placeholders()) {
      expect(() => store.save({ title: 'Pitch', content: placeholder }), form).toThrow(ArtifactPlaceholderError);
      expect(store.list(), form).toEqual([]);
    }
  });

  it('as an update: the document keeps its content and its version', () => {
    const doc = store.save({ title: 'Pitch', content: GOOD });
    for (const [form, placeholder] of placeholders()) {
      expect(() => store.save({ id: doc.id, title: 'Pitch', content: placeholder }), form).toThrow(ArtifactPlaceholderError);
      expect(store.get(doc.id)?.content, form).toBe(GOOD);
      expect(store.get(doc.id)?.version, form).toBe(1);
    }
  });

  it('control: a document larger than the placeholder leaves that quotes it is saved', () => {
    const quoting = `<h1>About the save bug</h1><p>The chat showed: ${placeholders()[1]![1]}</p>${'<p>Details.</p>'.repeat(200)}`;
    expect(Buffer.byteLength(quoting)).toBeGreaterThan(2048);
    const doc = store.save({ title: 'Bug report', content: quoting });
    expect(store.get(doc.id)?.content).toBe(quoting);
  });

  it('control: an artifact that already holds it can still be repaired with real content', () => {
    const doc = store.save({ title: 'Pitch', content: GOOD });
    writeFileSync(store.pathFor(doc.id), placeholders()[0]![1]);
    const repaired = store.save({ id: doc.id, title: 'Pitch', content: GOOD });
    expect(repaired.version).toBe(2);
    expect(readFileSync(store.pathFor(doc.id), 'utf-8')).toBe(GOOD);
  });
});

describe('a restore of a version that holds the placeholder', () => {
  /** An artifact whose stored v1 holds `content`, as an earlier unchecked save left it; current is v2. */
  function withStoredV1(content: string): string {
    const doc = store.save({ title: 'Pitch', content: GOOD });
    store.save({ id: doc.id, title: 'Pitch', content: `${GOOD}<p>v2</p>` });
    mkdirSync(join(dir, 'versions'), { recursive: true });
    writeFileSync(join(dir, 'versions', `${doc.id}.v1.html`), content);
    return doc.id;
  }

  it('is refused by the store, and the artifact stays as it was', () => {
    for (const [form, placeholder] of placeholders()) {
      const id = withStoredV1(placeholder);
      expect(() => store.restore(id, 1), form).toThrow(ArtifactPlaceholderError);
      expect(store.get(id)?.content, form).toBe(`${GOOD}<p>v2</p>`);
      expect(store.get(id)?.version, form).toBe(2);
    }
  });

  it('is answered by artifact_restore with what happened and what to do', async () => {
    const id = withStoredV1(placeholders()[0]![1]);
    expect(await restore(id, 1)).toBe(`Could not restore — v1 of artifact ${id} holds only the engine's placeholder for a saved document, not a document. Nothing was restored, and the artifact is unchanged. Use artifact_history to pick another version.`);
    expect(store.get(id)?.version).toBe(2);
  });

  it('control: any other error of the restore still reaches the caller', async () => {
    const failing = { restore: () => { throw new Error('disk full'); } };
    await expect(artifactRestoreTool.handler({ id: 'ab12cd34', version: 1 } as never, { principal: OWNER_PRINCIPAL, toolContext: { artifactStore: failing } } as never)).rejects.toThrow('disk full');
  });

  it('control: a version with a larger document that quotes the placeholder is restored', async () => {
    const quoting = `<h1>About the save bug</h1><p>${placeholders()[1]![1]}</p>${'<p>Details.</p>'.repeat(200)}`;
    const id = withStoredV1(quoting);
    expect(await restore(id, 1)).toContain('Restored "Pitch" to the content of v1');
    expect(store.get(id)?.content).toBe(quoting);
  });

  it('control: a version with a real document is restored', async () => {
    const id = withStoredV1(GOOD);
    expect(await restore(id, 1)).toContain('Restored "Pitch" to the content of v1');
    expect(store.get(id)?.content).toBe(GOOD);
  });
});
