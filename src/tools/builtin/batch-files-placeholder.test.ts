import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { batchFilesTool } from './batch-files.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';
import { closeWorkspaceBase } from '../../core/workspace-rel.js';
import { evictSavedArtifactBodies, EVICTION_MIN_CHARS } from '../../core/artifact-eviction.js';
import { MAX_BUFFER_BYTES } from '../../core/constants.js';

// batch_files is a third way to put text into an artifact file besides artifact_save and the
// file tools, which both refuse the engine's eviction placeholder. A file that holds the
// placeholder must not land in the artifacts directory by move or rename, and transform must not
// write it there. The reach is by path (no workspace, the CLI layout, where an absolute path in the
// artifacts directory is honoured). The last test shows one way the workspace branch is kept
// clear of the artifacts directory: a workspace holding the data directory is refused.

// The two forms a model can copy, as in fs.test.ts: the note the real eviction transform appends,
// built rather than typed, and the in-field form older threads still carry.
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

let data: string;
let artifacts: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-batch-art-')));
  artifacts = join(data, 'artifacts');
  mkdirSync(artifacts);
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = data;
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
  else process.env['LYNOX_DATA_DIR'] = prevDataDir;
  rmSync(data, { recursive: true, force: true });
});

const run = (input: Record<string, unknown>): Promise<string> =>
  batchFilesTool.handler(input as never, {} as never);

describe('batch_files refuses the eviction placeholder into the artifacts directory (by path)', () => {
  beforeEach(() => {
    clearTenantWorkspace();
  });

  it('move: a file holding the placeholder does not land there, and stays where it was', async () => {
    for (const [form, placeholder] of placeholders()) {
      const src = join(data, `drafts-${form.replace(/\W/g, '')}`);
      mkdirSync(src);
      writeFileSync(join(src, 'ab12cd34.html'), placeholder);
      const out = await run({ pattern: '*.html', directory: src, operation: 'move', destination: artifacts });
      expect(out, form).toMatch(/Error moving .*ab12cd34\.html: refused[\s\S]*placeholder/);
      expect(existsSync(join(artifacts, 'ab12cd34.html')), form).toBe(false);
      expect(readFileSync(join(src, 'ab12cd34.html'), 'utf8'), form).toBe(placeholder);
    }
  });

  it('move: a destination that is a link to the artifacts directory is judged where it lands', async () => {
    const [, placeholder] = placeholders()[0]!;
    const src = join(data, 'drafts');
    mkdirSync(src);
    writeFileSync(join(src, 'ab12cd34.html'), placeholder);
    symlinkSync(artifacts, join(data, 'out'));
    const out = await run({ pattern: '*.html', directory: src, operation: 'move', destination: join(data, 'out') });
    expect(out).toMatch(/Error moving .*ab12cd34\.html: refused[\s\S]*placeholder/);
    expect(existsSync(join(artifacts, 'ab12cd34.html'))).toBe(false);
  });

  it('move: a file too large to check is not moved in', async () => {
    const src = join(data, 'drafts');
    mkdirSync(src);
    writeFileSync(join(src, 'big.html'), 'x'.repeat(MAX_BUFFER_BYTES + 1));
    const out = await run({ pattern: '*.html', directory: src, operation: 'move', destination: artifacts });
    expect(out).toMatch(/Error moving .*big\.html: it is too large to check/);
    expect(existsSync(join(artifacts, 'big.html'))).toBe(false);
  });

  it('move: a file with real content still lands there', async () => {
    const src = join(data, 'drafts');
    mkdirSync(src);
    writeFileSync(join(src, 'ab12cd34.html'), GOOD);
    const out = await run({ pattern: '*.html', directory: src, operation: 'move', destination: artifacts });
    expect(out).not.toMatch(/Error/);
    expect(readFileSync(join(artifacts, 'ab12cd34.html'), 'utf8')).toBe(GOOD);
  });

  it('rename: a placeholder file in the directory does not take an artifact\'s name, and the artifact keeps its content', async () => {
    for (const [form, placeholder] of placeholders()) {
      writeFileSync(join(artifacts, 'ab12cd34.html'), GOOD);
      writeFileSync(join(artifacts, 'copy.tmp'), placeholder);
      const out = await run({ pattern: '*.tmp', directory: artifacts, operation: 'rename', rename_pattern: 'ab12cd34.html' });
      expect(out, form).toMatch(/Error renaming .*copy\.tmp: refused[\s\S]*placeholder/);
      expect(readFileSync(join(artifacts, 'ab12cd34.html'), 'utf8'), form).toBe(GOOD);
      expect(readFileSync(join(artifacts, 'copy.tmp'), 'utf8'), form).toBe(placeholder);
    }
  });

  it('rename: a file with real content is still renamed', async () => {
    writeFileSync(join(artifacts, 'draft.tmp'), GOOD);
    const out = await run({ pattern: '*.tmp', directory: artifacts, operation: 'rename', rename_pattern: 'ab12cd34.html' });
    expect(out).not.toMatch(/Error/);
    expect(readFileSync(join(artifacts, 'ab12cd34.html'), 'utf8')).toBe(GOOD);
  });

  it('transform: the placeholder is not written into an artifact, and the file is left as it was', async () => {
    for (const [form, placeholder] of placeholders()) {
      writeFileSync(join(artifacts, 'ab12cd34.html'), GOOD);
      const out = await run({ pattern: '*.html', directory: artifacts, operation: 'transform', find: 'Three budget options.', replace: placeholder });
      expect(out, form).toMatch(/Error transforming .*ab12cd34\.html: refused[\s\S]*placeholder/);
      expect(readFileSync(join(artifacts, 'ab12cd34.html'), 'utf8'), form).toBe(GOOD);
    }
  });

  it('transform: real text is still written, also into an artifact that already holds the placeholder (a repair)', async () => {
    const [, placeholder] = placeholders()[0]!;
    writeFileSync(join(artifacts, 'lost.html'), `<h1>Pitch</h1>${placeholder}`);
    writeFileSync(join(artifacts, 'ok.html'), GOOD);
    const out = await run({ pattern: '*.html', directory: artifacts, operation: 'transform', find: 'Pitch', replace: 'Offer' });
    expect(out).not.toMatch(/Error/);
    expect(readFileSync(join(artifacts, 'ok.html'), 'utf8')).toBe(GOOD.replace('Pitch', 'Offer'));
    expect(readFileSync(join(artifacts, 'lost.html'), 'utf8')).toBe(`<h1>Offer</h1>${placeholder}`);
  });

  it('outside the artifacts directory, a file too large to check still moves', async () => {
    const src = join(data, 'notes');
    const dst = join(data, 'archive');
    mkdirSync(src);
    writeFileSync(join(src, 'big.log'), 'x'.repeat(MAX_BUFFER_BYTES + 1));
    const out = await run({ pattern: '*.log', directory: src, operation: 'move', destination: dst });
    expect(out).not.toMatch(/Error/);
    expect(readdirSync(dst)).toEqual(['big.log']);
  });

  it('outside the artifacts directory, a placeholder file still moves (the check is scoped there)', async () => {
    const [, placeholder] = placeholders()[0]!;
    const src = join(data, 'notes');
    const dst = join(data, 'archive');
    mkdirSync(src);
    writeFileSync(join(src, 'about-eviction.md'), placeholder);
    const out = await run({ pattern: '*.md', directory: src, operation: 'move', destination: dst });
    expect(out).not.toMatch(/Error/);
    expect(readdirSync(dst)).toEqual(['about-eviction.md']);
  });
});

describe('through the workspace, the artifacts directory is out of reach', () => {
  it('a workspace that holds the data directory is refused before any file moves', async () => {
    const [, placeholder] = placeholders()[0]!;
    setTenantWorkspace(data);
    const src = join(data, 'drafts');
    mkdirSync(src);
    writeFileSync(join(src, 'ab12cd34.html'), placeholder);
    await expect(run({ pattern: '*.html', directory: src, operation: 'move', destination: artifacts })).rejects.toThrow(/is the data directory or contains it/);
    expect(existsSync(join(artifacts, 'ab12cd34.html'))).toBe(false);
  });
});
