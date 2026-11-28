import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * With isolation, a relative path the model gives write_file or edit_file is read from the
 * context workspace, by the tool and by the review alike: the review saves the file the tool then
 * changes, so the change is shown and a rollback undoes it. The real tools and the real review
 * run; only the LLM is mocked. The process cwd is a directory of its own under /tmp, an allowed
 * write root, holding a file of the same name, so a review that read the path from the cwd would
 * save that one instead.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from './agent.js';
import { ChangesetManager } from './changeset.js';
import { _resetCache as resetWorkspaceCache, clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { editFileTool, writeFileTool } from '../tools/builtin/fs.js';

type Exec = { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> };

let data: string;
let ws: string;
let cwd: string;

beforeEach(() => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'write-rel-')));
  vi.stubEnv('LYNOX_DATA_DIR', data);
  vi.stubEnv('LYNOX_WORKSPACE', '');
  ws = join(data, 'workspace');
  mkdirSync(ws);
  resetWorkspaceCache();
  setTenantWorkspace(ws);
  cwd = realpathSync(mkdtempSync('/tmp/write-rel-cwd-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeWorkspaceBase();
  clearTenantWorkspace();
  vi.unstubAllEnvs();
  resetWorkspaceCache();
  rmSync(data, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function agentWith(manager: ChangesetManager): Agent {
  return new Agent({ name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [writeFileTool, editFileTool], changesetManager: manager });
}

const call = (agent: Agent, name: string, input: Record<string, unknown>) =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t-${name}`, name, input });

describe('with isolation and the review on, a relative path is saved where the tool writes', () => {
  it('write_file over a workspace file by its relative path is shown and rolled back; the cwd file is untouched', async () => {
    writeFileSync(join(ws, 'data.csv'), 'before');
    writeFileSync(join(cwd, 'data.csv'), 'cwd file');
    const manager = new ChangesetManager(ws, 'run');
    try {
      const result = await call(agentWith(manager), 'write_file', { path: 'data.csv', content: 'after' });
      expect(result.is_error).not.toBe(true);
      expect(readFileSync(join(ws, 'data.csv'), 'utf-8')).toBe('after');
      expect(manager.getChanges().map((c) => c.file)).toEqual(['data.csv']);
      manager.rollbackAll();
      expect(readFileSync(join(ws, 'data.csv'), 'utf-8')).toBe('before');
      expect(readFileSync(join(cwd, 'data.csv'), 'utf-8')).toBe('cwd file');
    } finally {
      manager.cleanup();
    }
  });

  it('a new file written by its relative path is shown, and a rollback removes it', async () => {
    const manager = new ChangesetManager(ws, 'run');
    try {
      const result = await call(agentWith(manager), 'write_file', { path: 'bulkwalk/prices.csv', content: 'sku,price\n' });
      expect(result.is_error).not.toBe(true);
      expect(manager.getChanges().map((c) => c.file)).toEqual(['bulkwalk/prices.csv']);
      manager.rollbackAll();
      expect(existsSync(join(ws, 'bulkwalk', 'prices.csv'))).toBe(false);
    } finally {
      manager.cleanup();
    }
  });

  it('edit_file by a relative path is shown and rolled back to the original', async () => {
    writeFileSync(join(ws, 'a.txt'), 'old text');
    writeFileSync(join(cwd, 'a.txt'), 'old text in the cwd');
    const manager = new ChangesetManager(ws, 'run');
    try {
      const result = await call(agentWith(manager), 'edit_file', { path: 'a.txt', old_string: 'old', new_string: 'new' });
      expect(result.is_error).not.toBe(true);
      expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('new text');
      expect(manager.getChanges().map((c) => c.file)).toEqual(['a.txt']);
      manager.rollbackAll();
      expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('old text');
      expect(readFileSync(join(cwd, 'a.txt'), 'utf-8')).toBe('old text in the cwd');
    } finally {
      manager.cleanup();
    }
  });
});
