import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolEntry } from '../types/index.js';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The reads that run before write_file and edit_file — the diff preview, the review's backup and
 * edit_file's own read — stop at the file tools' read cap, and none of them waits on a FIFO.
 * Every case runs in both branches: through the context workspace's open directory (`anchor`,
 * isolation on) and by name (`name`, isolation off). Each refusal is checked against a file of
 * exactly the cap, which goes through. The real tools and the real review run; only the LLM is
 * mocked.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent, readForDiffPreview } from './agent.js';
import { ChangesetManager } from './changeset.js';
import { _resetCache as resetWorkspaceCache, clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { FILE_TOOL_READ_CAP_BYTES, isReadLimit } from './workspace-fd.js';
import { editFileTool, writeFileTool } from '../tools/builtin/fs.js';
import { batchFilesTool } from '../tools/builtin/batch-files.js';

type Exec = { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> };
type Branch = 'anchor' | 'name';

const CAP = FILE_TOOL_READ_CAP_BYTES;
const MARK = 'MARK-551';
/** `MARK-551` followed by filler, `size` bytes in all. */
const fileOf = (size: number): string => MARK + 'a'.repeat(size - MARK.length);

let data: string;
let ws: string;
const writers: ChildProcess[] = [];

/**
 * A FIFO at `path`, with a writer that opens it every 3 s, three times, and gives up after 12 s.
 * A read that waits for a writer returns then (a call may open the file twice: backup and tool),
 * so it fails the time asserted below instead of hanging the run.
 */
function fifoWithLateWriter(path: string): void {
  execFileSync('mkfifo', [path]);
  const writer = spawn('timeout', ['12', 'sh', '-c', 'for i in 1 2 3; do sleep 3; echo x > "$1"; done', 'sh', path], { stdio: 'ignore' });
  writer.unref();
  writers.push(writer);
}

function setup(branch: Branch): void {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'write-cap-')));
  // Without isolation the write tools reach `<data dir>/workspace` only; with it, the same
  // directory is the context workspace.
  vi.stubEnv('LYNOX_DATA_DIR', data);
  vi.stubEnv('LYNOX_WORKSPACE', '');
  ws = join(data, 'workspace');
  mkdirSync(ws);
  resetWorkspaceCache();
  if (branch === 'anchor') setTenantWorkspace(ws);
}

/** Present only so the refusals see an agent that has bash; never called here. */
const bashStub = {
  definition: { name: 'bash', description: 'bash', input_schema: { type: 'object', properties: {} } },
  handler: async () => 'not run',
} as unknown as ToolEntry;

const WAY_OUT_NO_BASH =
  'There is no bash here to split it: tell the user the file is too large for the file tools, and has to be split into parts under 5 MB or changed outside lynox.';

function agentWith(manager?: ChangesetManager, extra: ToolEntry[] = []): Agent {
  return new Agent({
    name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic',
    tools: [writeFileTool, editFileTool, ...extra],
    ...(manager !== undefined ? { changesetManager: manager } : {}),
  });
}

const call = (agent: Agent, name: string, input: Record<string, unknown>) =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t-${name}`, name, input });

afterEach(() => {
  for (const writer of writers.splice(0)) writer.kill();
  closeWorkspaceBase();
  clearTenantWorkspace();
  vi.unstubAllEnvs();
  resetWorkspaceCache();
  rmSync(data, { recursive: true, force: true });
});

describe.each<Branch>(['anchor', 'name'])('the reads before a write, %s branch', (branch) => {
  beforeEach(() => setup(branch));

  it(`[${branch}] the preview reads a file of exactly the cap, and refuses one byte more as over the limit`, () => {
    const path = join(ws, 'data.csv');
    writeFileSync(path, fileOf(CAP));
    expect(readForDiffPreview(path)).toHaveLength(CAP);
    writeFileSync(path, fileOf(CAP + 1));
    let thrown: unknown;
    try { readForDiffPreview(path); } catch (err) { thrown = err; }
    expect(isReadLimit(thrown), 'a LIMIT error, not an empty preview').toBe(true);
  });

  it(`[${branch}] the preview before a prompted write says why there is no diff for a file over the cap`, async () => {
    const path = join(ws, 'data.csv');
    const shown = async (): Promise<string> => {
      const agent = agentWith();
      agent.promptUser = vi.fn().mockResolvedValue('Allow');
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await call(agent, 'write_file', { path, content: 'new text' });
        return stderr.mock.calls.map((c) => String(c[0])).join('');
      } finally {
        stderr.mockRestore();
      }
    };
    writeFileSync(path, fileOf(CAP + 1));
    const over = await shown();
    expect(over).toContain(`No diff preview: ${path} is larger than 5 MB.`);
    expect(over, 'the file is not read').not.toContain('KB file');
    writeFileSync(path, fileOf(CAP));
    const at = await shown();
    // Read whole: the diff renderer sees its size (and skips a diff this large itself).
    expect(at, 'a file of exactly the cap is read for the preview').toContain('5120KB file');
    expect(at).not.toContain('No diff preview');
  });

  it(`[${branch}] with the review on, write_file over a file one byte over the cap is refused with the way out`, async () => {
    const path = join(ws, 'data.csv');
    writeFileSync(path, fileOf(CAP + 1));
    const manager = new ChangesetManager(ws, 'run');
    try {
      const result = await call(agentWith(manager), 'write_file', { path, content: 'new text' });
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toBe(
        'Blocked: write_file did not run. The file is larger than 5 MB, too large to save for the review, so the change could not be undone. ' +
        'Nothing was written. Do not retry with write_file. ' +
        'Write the new content to a new file instead and tell the user its name; the old file stays as it was.',
      );
      expect(statSync(path).size, 'the file is left as it was').toBe(CAP + 1);
      expect(manager.getChanges()).toEqual([]);
      expect(manager.refusedTooLarge).toBe(true);
      // The next save answers for itself: a file the review can save clears it.
      writeFileSync(join(ws, 'small.txt'), 'small');
      expect(manager.backupBeforeWrite(join(ws, 'small.txt'))).toBe(true);
      expect(manager.refusedTooLarge).toBe(false);
    } finally {
      manager.cleanup();
    }
  });

  it(`[${branch}] with the review on, write_file over a file of exactly the cap is saved, written and rolled back (control)`, async () => {
    const path = join(ws, 'data.csv');
    writeFileSync(path, fileOf(CAP));
    const manager = new ChangesetManager(ws, 'run');
    try {
      const result = await call(agentWith(manager), 'write_file', { path, content: 'new text' });
      expect(result.is_error).not.toBe(true);
      expect(readFileSync(path, 'utf-8')).toBe('new text');
      expect(manager.getChanges().map((c) => c.file)).toEqual(['data.csv']);
      manager.rollbackAll();
      expect(readFileSync(path, 'utf-8')).toBe(fileOf(CAP));
    } finally {
      manager.cleanup();
    }
  });

  it(`[${branch}] with the review on, a batch_files transform leaves a file over the cap with the way out, and changes one of exactly the cap`, async () => {
    // batch_files reaches the review through the agent's writer view, not the manager.
    writeFileSync(join(ws, 'over.csv'), fileOf(CAP + 1));
    writeFileSync(join(ws, 'at.csv'), fileOf(CAP));
    const manager = new ChangesetManager(ws, 'run');
    try {
      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [batchFilesTool, bashStub], changesetManager: manager,
      });
      const result = await call(agent, 'batch_files', { pattern: '*.csv', directory: ws, operation: 'transform', find: MARK, replace: 'EDITED' });
      expect(String(result.content)).toContain(
        'over.csv: it is larger than 5 MB, too large to save for the review, so it was left as it was. Tell the user, and if they agree, ' +
        'split the file into parts under 5 MB with bash (for example `split -l`) and change the part that needs it.',
      );
      expect(readFileSync(join(ws, 'over.csv'), 'utf-8').startsWith(MARK)).toBe(true);
      expect(readFileSync(join(ws, 'at.csv'), 'utf-8').startsWith('EDITED'), 'a file of exactly the cap is changed').toBe(true);
      expect(manager.getChanges().map((c) => c.file)).toEqual(['at.csv']);
    } finally {
      manager.cleanup();
    }
  });

  it(`[${branch}] with the review on, edit_file over a file one byte over the cap is refused before it runs`, async () => {
    const path = join(ws, 'data.csv');
    writeFileSync(path, fileOf(CAP + 1));
    const manager = new ChangesetManager(ws, 'run');
    try {
      const result = await call(agentWith(manager), 'edit_file', { path, old_string: MARK, new_string: 'EDITED' });
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toBe(
        'Blocked: edit_file did not run. The file is larger than 5 MB, too large to save for the review, so the change could not be undone. ' +
        `Nothing was written. Do not retry with edit_file. ${WAY_OUT_NO_BASH}`,
      );
      expect(readFileSync(path, 'utf-8').startsWith(MARK), 'the file is left as it was').toBe(true);
    } finally {
      manager.cleanup();
    }
  });

  it(`[${branch}] edit_file refuses a file one byte over the cap with the way out, and edits one of exactly the cap`, async () => {
    // Without the review, so the refusal is edit_file's own and not the backup's.
    const path = join(ws, 'data.csv');
    writeFileSync(path, fileOf(CAP + 1));
    const over = await call(agentWith(undefined, [bashStub]), 'edit_file', { path, old_string: MARK, new_string: 'EDITED' });
    expect(over.is_error).toBe(true);
    expect(String(over.content)).toContain(
      `${path} is larger than 5 MB, too large for edit_file; nothing was changed. ` +
      'Change it with bash instead (sed for a line, or split it into parts under 5 MB with `split -l`).',
    );
    // An agent without bash (the creator role) is not sent to it.
    const noBash = await call(agentWith(), 'edit_file', { path, old_string: MARK, new_string: 'EDITED' });
    expect(String(noBash.content)).toContain(`too large for edit_file; nothing was changed. ${WAY_OUT_NO_BASH}`);
    expect(readFileSync(path, 'utf-8').startsWith(MARK), 'the file is left as it was').toBe(true);

    writeFileSync(path, fileOf(CAP));
    const at = await call(agentWith(), 'edit_file', { path, old_string: MARK, new_string: 'EDITED' });
    expect(at.is_error).not.toBe(true);
    expect(readFileSync(path, 'utf-8').startsWith('EDITED')).toBe(true);
  });

  it.runIf(process.platform === 'linux')(`[${branch}] edit_file on a FIFO, with the review on, returns at once and leaves the FIFO`, async () => {
    const path = join(ws, 'pipe.csv');
    fifoWithLateWriter(path);
    const manager = new ChangesetManager(ws, 'run');
    try {
      const started = Date.now();
      const result = await call(agentWith(manager), 'edit_file', { path, old_string: 'a', new_string: 'b' });
      expect(Date.now() - started, 'no read waits for a writer').toBeLessThan(2_000);
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain('not a regular file');
      expect(statSync(path).isFIFO()).toBe(true);
    } finally {
      manager.cleanup();
    }
  }, 15_000);

  it.runIf(process.platform === 'linux')(`[${branch}] the preview before a prompted edit of a FIFO returns at once`, async () => {
    const path = join(ws, 'pipe.csv');
    fifoWithLateWriter(path);
    const agent = agentWith();
    agent.promptUser = vi.fn().mockResolvedValue('Allow');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const started = Date.now();
      await call(agent, 'edit_file', { path, old_string: 'a', new_string: 'b' });
      expect(Date.now() - started, 'no read waits for a writer').toBeLessThan(2_000);
    } finally {
      stderr.mockRestore();
    }
    expect(statSync(path).isFIFO()).toBe(true);
  }, 15_000);
});

describe('write_file on a FIFO in the context workspace', () => {
  beforeEach(() => setup('anchor'));

  // By name (isolation off) write_file itself opens the path for writing and waits for a reader;
  // there is no second writer of the workspace there, and this file does not cover that case.
  it.runIf(process.platform === 'linux')('with the review on, returns at once and leaves the FIFO', async () => {
    const path = join(ws, 'pipe.csv');
    fifoWithLateWriter(path);
    const manager = new ChangesetManager(ws, 'run');
    try {
      const started = Date.now();
      const result = await call(agentWith(manager), 'write_file', { path, content: 'new text' });
      expect(Date.now() - started, 'no read waits for a writer').toBeLessThan(2_000);
      expect(result.is_error).toBe(true);
      expect(statSync(path).isFIFO()).toBe(true);
    } finally {
      manager.cleanup();
    }
  }, 15_000);
});
