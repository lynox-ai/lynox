import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../../core/artifact-store.js';
import { artifactHistoryTool, artifactRestoreTool, artifactSaveTool } from './artifact.js';
import { readFileTool } from './fs.js';
import { clearTenantWorkspace, setTenantWorkspace } from '../../core/workspace.js';
import type { IAgent } from '../../types/index.js';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { evictSavedArtifactBodies, EVICTION_MIN_CHARS } from '../../core/artifact-eviction.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';

// Minimal agent — the artifact tools only read agent.toolContext.artifactStore.
function makeAgent(store: ArtifactStore | null, currentThreadId?: string, originThreadId?: string): IAgent {
  return { principal: OWNER_PRINCIPAL, toolContext: { artifactStore: store }, ...(currentThreadId ? { currentThreadId } : {}), ...(originThreadId ? { originThreadId } : {}) } as unknown as IAgent;
}

describe('artifact history/restore tool handlers', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-artifact-tool-'));
    store = new ArtifactStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('artifact_history: fresh artifact reports no earlier versions', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    const out = await artifactHistoryTool.handler({ id: a.id }, makeAgent(store));
    expect(out).toContain('no earlier versions');
    expect(out).toContain('v1');
  });

  it('artifact_history: lists prior versions newest-first with the current version', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    store.save({ id: a.id, title: 'Deck', content: 'v2' });
    store.save({ id: a.id, title: 'Deck', content: 'v3' });
    const out = await artifactHistoryTool.handler({ id: a.id }, makeAgent(store));
    expect(out).toMatch(/current v3/);
    expect(out).toContain('v2');
    expect(out).toContain('v1');
    expect(out).toContain('artifact_restore');
  });

  it('artifact_history: unknown id → not found', async () => {
    const out = await artifactHistoryTool.handler({ id: 'ffffffff' }, makeAgent(store));
    expect(out).toContain('not found');
  });

  it('artifact_restore: rolls back to a prior version and is reversible', async () => {
    const a = store.save({ title: 'Deck', content: 'original' });
    store.save({ id: a.id, title: 'Deck', content: 'rewritten' });
    const out = await artifactRestoreTool.handler({ id: a.id, version: 1 }, makeAgent(store));
    expect(out).toContain('Restored');
    expect(store.get(a.id)?.content).toBe('original');
    // The rewrite is still recoverable (restore snapshotted it first).
    expect(store.history(a.id).some(h => h.version >= 2)).toBe(true);
  });

  it('artifact_restore: missing version → actionable not-found message', async () => {
    const a = store.save({ title: 'Deck', content: 'x' });
    const out = await artifactRestoreTool.handler({ id: a.id, version: 99 }, makeAgent(store));
    expect(out).toContain('not found');
    expect(out).toContain('artifact_history');
  });

  it('both tools: degrade cleanly when the store is unavailable', async () => {
    expect(await artifactHistoryTool.handler({ id: 'ffffffff' }, makeAgent(null))).toContain('not available');
    expect(await artifactRestoreTool.handler({ id: 'ffffffff', version: 1 }, makeAgent(null))).toContain('not available');
  });
});

describe('artifact_save refuses the eviction placeholder as content', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-artifact-marker-'));
    store = new ArtifactStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The reference in the two forms a model can copy: the note the engine now appends to an
  // evicted save's result — taken from a real save through the handler and the real eviction
  // transform, so a reworded note cannot leave this test checking a string nobody writes — and
  // the in-field form it put into `content` until 2026-10-10, which threads persisted before
  // then still carry (typed: nothing writes it any more).
  const IN_FIELD = '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]';

  async function placeholdersFor(document: string): Promise<{ id: string; forms: Array<[string, string]>; evictedInput: Record<string, unknown> }> {
    const result = await artifactSaveTool.handler({ title: 'Pitch', content: document }, makeAgent(store));
    const id = /id: ([0-9a-f]+)/.exec(result)![1]!;
    const turn = [
      { role: 'user', content: 'write the pitch' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'artifact_save', input: { title: 'Pitch', content: document } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: result }] },
    ] as BetaMessageParam[];
    const evicted = evictSavedArtifactBodies(turn);
    const call = (evicted[1]!.content as Array<{ type: string; input?: Record<string, unknown> }>).find(b => b.type === 'tool_use')!;
    const evictedResult = (evicted[2]!.content as Array<{ content: string }>)[0]!.content;
    const note = evictedResult.slice(result.length).trim();
    return { id, forms: [['note', note], ['in-field form', IN_FIELD]], evictedInput: call.input! };
  }

  const DOCUMENT = '# Pitch\n\n' + 'Budget options and expected leads. '.repeat(Math.ceil(EVICTION_MIN_CHARS / 30));

  it('the note built here is what eviction appends, and the evicted call keeps no content', async () => {
    const { forms, evictedInput } = await placeholdersFor(DOCUMENT);
    const note = forms[0]![1];
    expect(note.length, 'eviction appended a note').toBeGreaterThan(20);
    expect(note.length).toBeLessThan(400);
    expect(evictedInput).not.toHaveProperty('content');
  });

  it('an update carrying either form throws and leaves the document as it was', async () => {
    const { id, forms } = await placeholdersFor(DOCUMENT);
    for (const [form, placeholder] of forms) {
      await expect(artifactSaveTool.handler({ id, title: 'Pitch', content: placeholder }, makeAgent(store)), form)
        .rejects.toThrow(/artifact_save refused[\s\S]*edit_file/);
    }
    expect(store.get(id)?.content).toBe(DOCUMENT);
    expect(store.get(id)?.version).toBe(1);
  });

  it('a new artifact carrying either form throws and creates nothing', async () => {
    const { forms } = await placeholdersFor(DOCUMENT);
    const before = store.list().length;
    for (const [form, placeholder] of forms) {
      await expect(artifactSaveTool.handler({ title: 'Pitch v3', content: placeholder }, makeAgent(store)), form)
        .rejects.toThrow(/artifact_save refused/);
    }
    expect(store.list().length).toBe(before);
  });

  it('either form under a heading is refused too', async () => {
    const { forms } = await placeholdersFor(DOCUMENT);
    for (const [form, placeholder] of forms) {
      await expect(artifactSaveTool.handler({ title: 'Pitch', content: `# Pitch\n\n${placeholder}\n` }, makeAgent(store)), form)
        .rejects.toThrow(/artifact_save refused/);
    }
  });

  it('a real document still saves, as an update and as a new artifact', async () => {
    const { id } = await placeholdersFor(DOCUMENT);
    const updated = await artifactSaveTool.handler({ id, title: 'Pitch', content: DOCUMENT + '\nThree options.' }, makeAgent(store));
    expect(updated).toMatch(/^Updated artifact "Pitch"/);
    expect(store.get(id)?.content).toBe(DOCUMENT + '\nThree options.');
    const created = await artifactSaveTool.handler({ title: 'Notes', content: 'short note' }, makeAgent(store));
    expect(created).toMatch(/^Created a new artifact "Notes"/);
  });
});

describe('artifact_save and artifact_restore at a link or a file with a second name', () => {
  let dir: string;
  let outside: string;
  let store: ArtifactStore;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-artifact-link-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-artifact-link-out-')));
    writeFileSync(join(outside, 'target.txt'), 'kept');
    store = new ArtifactStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const wayOut = (id: string): string =>
    `, and artifact ${id} is unchanged. ` +
    'Tell the user that this artifact could not be changed, and that you are saving the changed version as a new artifact. ' +
    `Then call artifact_save without an id: passing ${id} would write to the same file. ` +
    'In your reply, name the new artifact as the one that replaces it.';

  it('artifact_save with an id refuses a link at its file, word for word, and writes nothing through it', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    const file = join(dir, `${a.id}.html`);
    rmSync(file);
    symlinkSync(join(outside, 'target.txt'), file);
    const message = await artifactSaveTool.handler({ id: a.id, title: 'Deck', content: 'v2' }, makeAgent(store)).then(() => '', (err: Error) => err.message);
    expect(message).toBe(`${file}: a link on the way to the file is not followed; nothing was written${wayOut(a.id)}`);
    expect(readFileSync(join(outside, 'target.txt'), 'utf-8')).toBe('kept');
  });

  it('artifact_save with an id refuses a file with a second name, word for word', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    const file = join(dir, `${a.id}.html`);
    linkSync(file, join(outside, 'second.html'));
    const message = await artifactSaveTool.handler({ id: a.id, title: 'Deck', content: 'v2' }, makeAgent(store)).then(() => '', (err: Error) => err.message);
    expect(message).toBe(`${file} has more than one name (a hard link); artifact_save does not write such a file, so nothing was written${wayOut(a.id)}`);
    expect(readFileSync(join(outside, 'second.html'), 'utf-8')).toBe('v1');
  });

  it('artifact_restore refuses a link at the artifact\'s file, word for word', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    store.save({ id: a.id, title: 'Deck', content: 'v2' });
    const file = join(dir, `${a.id}.html`);
    rmSync(file);
    symlinkSync(join(outside, 'target.txt'), file);
    const message = await artifactRestoreTool.handler({ id: a.id, version: 1 }, makeAgent(store)).then(() => '', (err: Error) => err.message);
    expect(message).toBe(`${file}: a link on the way to the file is not followed; ${restoreWayOut(a.id, 1, store.versionPathFor(a.id, 1))}`);
    expect(readFileSync(join(outside, 'target.txt'), 'utf-8')).toBe('kept');
  });

  it('artifact_restore refuses a file with a second name, word for word', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    store.save({ id: a.id, title: 'Deck', content: 'v2' });
    const file = join(dir, `${a.id}.html`);
    linkSync(file, join(outside, 'second.html'));
    const message = await artifactRestoreTool.handler({ id: a.id, version: 1 }, makeAgent(store)).then(() => '', (err: Error) => err.message);
    expect(message).toBe(`${file} has more than one name (a hard link); artifact_restore does not write such a file, so ${restoreWayOut(a.id, 1, store.versionPathFor(a.id, 1))}`);
    expect(readFileSync(join(outside, 'second.html'), 'utf-8')).toBe('v2');
  });

  it.each([['a link'], ['a file with a second name']] as const)('artifact_restore says so when the version itself is %s, word for word', async (kind) => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    store.save({ id: a.id, title: 'Deck', content: 'v2' });
    const version = store.versionPathFor(a.id, 1);
    rmSync(version);
    if (kind === 'a link') symlinkSync(join(outside, 'target.txt'), version);
    else linkSync(join(outside, 'target.txt'), version);
    const out = await artifactRestoreTool.handler({ id: a.id, version: 1 }, makeAgent(store));
    expect(out).toBe(`v1 of artifact ${a.id} is a link or has more than one name, so it was not read; nothing was restored, and the artifact is unchanged. Use artifact_history to pick another version.`);
    expect(store.get(a.id)?.content).toBe('v2');
  });

  it('control: a version that is missing is still not found', async () => {
    const a = store.save({ title: 'Deck', content: 'v1' });
    const out = await artifactRestoreTool.handler({ id: a.id, version: 7 }, makeAgent(store));
    expect(out).toBe(`Could not restore — artifact ${a.id} or version 7 not found. Use artifact_history to see available versions.`);
  });
});

const restoreWayOut = (id: string, n: number, versionPath: string): string =>
  `nothing was restored, and artifact ${id} is unchanged. ` +
  `Tell the user that artifact ${id} could not be restored to v${n}, and that you are keeping v${n} as a new artifact instead. ` +
  `Read v${n} with read_file at ${versionPath}, then call artifact_save without an id, with that content: passing ${id} would write to the same file. ` +
  `In your reply, name the new artifact as the one that holds v${n}.`;

describe('artifact_save says what the store did', () => {
  let dir: string;
  let store: ArtifactStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lynox-artifact-result-')); store = new ArtifactStore(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a new artifact without an id: created, word for word', async () => {
    const out = await artifactSaveTool.handler({ title: 'Notes', content: 'n' }, makeAgent(store));
    const id = store.list()[0]!.id;
    expect(out.split('\n').slice(0, 2)).toEqual([`Created a new artifact "Notes" (id: ${id}, v1).`, `File: ${store.pathFor(id)}`]);
  });

  it('an id the index does not hold: created, and says that no artifact had it, word for word', async () => {
    const out = await artifactSaveTool.handler({ id: 'abcdef12', title: 'Notes', content: 'n' }, makeAgent(store));
    expect(out.split('\n').slice(0, 3)).toEqual([
      'Created a new artifact "Notes" (id: abcdef12, v1).',
      'No artifact with id abcdef12 existed, so this is a new one.',
      `File: ${store.pathFor('abcdef12')}`,
    ]);
  });

  it('an update: updated, word for word', async () => {
    const a = store.save({ title: 'Notes', content: 'n' });
    const out = await artifactSaveTool.handler({ id: a.id, title: 'Notes', content: 'm' }, makeAgent(store));
    expect(out.split('\n')[0]).toBe(`Updated artifact "Notes" (id: ${a.id}, v2).`);
  });
});

describe('the version path in the restore refusal is one read_file reads', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  beforeEach(() => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-artifact-vread-')));
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = dataDir;
    clearTenantWorkspace();
  });
  afterEach(() => {
    clearTenantWorkspace();
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('without a workspace and with one', async () => {
    const store = new ArtifactStore(join(dataDir, 'artifacts'));
    const a = store.save({ title: 'Deck', content: 'first' });
    store.save({ id: a.id, title: 'Deck', content: 'second' });
    const path = store.versionPathFor(a.id, 1);
    const plain = await readFileTool.handler({ path });
    expect(plain).toContain('first');
    expect(plain).not.toContain('second');
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-artifact-vread-ws-')));
    try {
      setTenantWorkspace(ws);
      const inWorkspace = await readFileTool.handler({ path });
      expect(inWorkspace).toContain('first');
      expect(inWorkspace).not.toContain('second');
    } finally {
      clearTenantWorkspace();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('artifact_save records the chat that made the artifact (row 1072)', () => {
  let dir: string;
  let store: ArtifactStore;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'artifact-thread-')); store = new ArtifactStore(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const idOf = (out: string): string => {
    const id = store.list().map(a => a.id).find(i => out.includes(i));
    if (!id) throw new Error(`no artifact id in: ${out}`);
    return id;
  };

  it('a new artifact lists the running chat\'s thread id, and an edit from another chat keeps it', async () => {
    const created = await artifactSaveTool.handler({ title: 'Plan', content: 'first draft of the plan' }, makeAgent(store, 'thread-a'));
    const id = idOf(created);
    expect(store.list().find(a => a.id === id)?.threadId).toBe('thread-a');

    await artifactSaveTool.handler({ id, title: 'Plan', content: 'second draft of the plan' }, makeAgent(store, 'thread-b'));
    const after = store.list().find(a => a.id === id);
    expect(after?.version).toBe(2);
    expect(after?.threadId).toBe('thread-a');
  });

  it('a spawn_agent child or workflow step, which has no thread of its own, records the chat it runs for', async () => {
    const id = idOf(await artifactSaveTool.handler({ title: 'From a helper', content: 'made by a subagent' }, makeAgent(store, undefined, 'thread-parent')));
    expect(store.list().find(a => a.id === id)?.threadId).toBe('thread-parent');
  });

  it('an artifact saved outside a chat stays without one', async () => {
    const id = idOf(await artifactSaveTool.handler({ title: 'Loose', content: 'no chat around this one' }, makeAgent(store)));
    expect(store.list().find(a => a.id === id)?.threadId).toBe('');
  });
});
