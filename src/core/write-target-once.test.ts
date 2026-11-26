import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAgent, ToolEntry } from '../types/index.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The file write_file and edit_file write is resolved once per call: the permission guard judges
 * that file, and the handler writes exactly it. A link set between the two (while the call waits
 * for its answer, or by a parallel command) is refused by the write, never followed to a file
 * nobody judged. The real tools and the real guard run; only the LLM is mocked.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from './agent.js';
import { _resetCache as resetWorkspaceCache, clearTenantWorkspace, setTenantWorkspace } from './workspace.js';
import { closeWorkspaceBase } from './workspace-rel.js';
import { editFileTool, writeFileTool } from '../tools/builtin/fs.js';
import { isDangerousDetailed } from '../tools/permission-guard.js';
import { applyPluginToolGate } from './session.js';
import { wrapWithGate } from '../orchestrator/runtime-adapter.js';
import { ChangesetManager } from './changeset.js';
import type { PluginManager } from './plugins.js';

type Exec = { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> };

let data: string;
let ws: string;
let away: string;

function setup(isolated: boolean): void {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'write-once-')));
  // In /tmp itself, not TMPDIR: /tmp is a root the write tools allow with isolation on.
  away = realpathSync(mkdtempSync('/tmp/write-once-away-'));
  vi.stubEnv('LYNOX_DATA_DIR', data);
  vi.stubEnv('LYNOX_WORKSPACE', '');
  ws = join(data, 'workspace');
  mkdirSync(ws);
  resetWorkspaceCache();
  if (isolated) setTenantWorkspace(ws);
}

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  vi.unstubAllEnvs();
  resetWorkspaceCache();
  rmSync(data, { recursive: true, force: true });
  rmSync(away, { recursive: true, force: true });
});

/** The tool as the agent has it, with `then` run right after the call's one resolution. */
const resolvingThen = (tool: ToolEntry, then: () => void): ToolEntry => ({
  ...tool,
  writeTarget: (path: string) => {
    const target = tool.writeTarget!(path);
    then();
    return target;
  },
});

function agentWith(tools: ToolEntry[]): Agent {
  return new Agent({ name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', tools });
}

const call = (agent: Agent, name: string, input: Record<string, unknown>) =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t-${name}`, name, input });

/** Said when the write meets a link on the way to the file it was handed. */
const LINK_REFUSED = 'a link on the way to the file is not followed here; nothing was written.';

/** `at` becomes a link to `to`. */
const relink = (at: string, to: string): void => { unlinkSync(at); symlinkSync(to, at); };

const INPUT = { write_file: { content: 'new text' }, edit_file: { old_string: 'old', new_string: 'new text' } } as const;

describe.each([['write_file', writeFileTool], ['edit_file', editFileTool]] as const)('%s writes the file the guard judged', (name, tool) => {
  it(`${name}, no workspace: a link set in the folder after the judgement is refused, and the file it points to stays as it was`, async () => {
    setup(false);
    writeFileSync(join(ws, '.env'), 'KEY=old\n');
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const agent = agentWith([resolvingThen(tool, () => relink(join(ws, 'notes.txt'), '.env'))]);
    const asked = vi.fn().mockResolvedValue('Allow');
    agent.promptUser = asked;
    const result = await call(agent, name, { path: 'notes.txt', ...INPUT[name] });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain(LINK_REFUSED);
    expect(readFileSync(join(ws, '.env'), 'utf-8')).toBe('KEY=old\n');
    expect(lstatSync(join(ws, 'notes.txt')).isSymbolicLink()).toBe(true);
    // The guard judged the file resolved before the link (a plain one), not a second resolution.
    expect(asked).not.toHaveBeenCalled();
  });

  it(`${name}, isolation, a file in /tmp: a link set after the judgement is refused, and the file it points to stays as it was`, async () => {
    setup(true);
    writeFileSync(join(away, 'other.txt'), 'old\n');
    writeFileSync(join(away, 'notes.txt'), 'old\n');
    const agent = agentWith([resolvingThen(tool, () => relink(join(away, 'notes.txt'), join(away, 'other.txt')))]);
    const result = await call(agent, name, { path: join(away, 'notes.txt'), ...INPUT[name] });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain(LINK_REFUSED);
    expect(readFileSync(join(away, 'other.txt'), 'utf-8')).toBe('old\n');
  });

  it(`${name}, control, isolation, a file in /tmp: without a link the judged file is written`, async () => {
    setup(true);
    writeFileSync(join(away, 'notes.txt'), 'old\n');
    const result = await call(agentWith([resolvingThen(tool, () => undefined)]), name, { path: join(away, 'notes.txt'), ...INPUT[name] });
    expect(result.is_error).not.toBe(true);
    expect(readFileSync(join(away, 'notes.txt'), 'utf-8')).toMatch(/^new text/);
  });

  it(`${name}, behind the plugin gate: a link set after the judgement is refused, and the file it points to stays as it was`, async () => {
    setup(false);
    writeFileSync(join(ws, '.env'), 'KEY=old\n');
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const plugins = { fireToolGate: async () => true } as unknown as PluginManager;
    const [gated] = applyPluginToolGate([resolvingThen(tool, () => relink(join(ws, 'notes.txt'), '.env'))], plugins);
    const result = await call(agentWith([gated!]), name, { path: 'notes.txt', ...INPUT[name] });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain(LINK_REFUSED);
    expect(readFileSync(join(ws, '.env'), 'utf-8')).toBe('KEY=old\n');
  });

  it(`${name}, control: without a link the judged file is written`, async () => {
    setup(false);
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const agent = agentWith([resolvingThen(tool, () => undefined)]);
    const result = await call(agent, name, { path: 'notes.txt', ...INPUT[name] });
    expect(result.is_error).not.toBe(true);
    expect(readFileSync(join(ws, 'notes.txt'), 'utf-8')).toMatch(/^new text/);
  });

  it(`${name}, control, isolation: a workspace file is written through the workspace, as before`, async () => {
    setup(true);
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const result = await call(agentWith([tool]), name, { path: join(ws, 'notes.txt'), ...INPUT[name] });
    expect(result.is_error).not.toBe(true);
    expect(readFileSync(join(ws, 'notes.txt'), 'utf-8')).toMatch(/^new text/);
  });

  it(`${name}: resolved to nothing writable, the handler refuses and resolves nothing to write, even when the path would resolve now`, async () => {
    setup(false);
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const agent = { sessionCounters: { writeBytes: 0 } } as unknown as IAgent;
    await expect(tool.handler({ path: 'notes.txt', ...INPUT[name] } as never, agent, { writeTarget: null }))
      .rejects.toThrow('notes.txt changed after it was checked; nothing was written. Call again to have it checked anew.');
    expect(readFileSync(join(ws, 'notes.txt'), 'utf-8')).toBe('old\n');
  });

  it(`${name}: resolved to nothing writable because the path is refused, the handler says the path's own refusal`, async () => {
    setup(false);
    writeFileSync(join(away, 'out.txt'), 'old\n');
    symlinkSync(join(away, 'out.txt'), join(ws, 'away.txt'));
    const agent = { sessionCounters: { writeBytes: 0 } } as unknown as IAgent;
    await expect(tool.handler({ path: 'away.txt', ...INPUT[name] } as never, agent, { writeTarget: null }))
      .rejects.toThrow(/Blocked: .*(escapes the workspace|points outside)/);
    expect(readFileSync(join(away, 'out.txt'), 'utf-8')).toBe('old\n');
  });

  it(`${name}: a direct call without the engine's resolution resolves the path itself, as before (a link in the folder is followed)`, async () => {
    setup(false);
    writeFileSync(join(ws, '.env'), 'old\n');
    symlinkSync('.env', join(ws, 'notes.txt'));
    const agent = { sessionCounters: { writeBytes: 0 } } as unknown as IAgent;
    await tool.handler({ path: 'notes.txt', ...INPUT[name] } as never, agent);
    expect(readFileSync(join(ws, '.env'), 'utf-8')).toMatch(/^new text/);
  });
});

describe('what the handler holds to', () => {
  it('isolation: a workspace path whose judged file is another workspace file is refused, and neither is written', async () => {
    setup(true);
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    writeFileSync(join(ws, 'other.txt'), 'old\n');
    const agent = { sessionCounters: { writeBytes: 0 } } as unknown as IAgent;
    await expect(writeFileTool.handler({ path: join(ws, 'notes.txt'), content: 'new text' }, agent, { writeTarget: join(ws, 'other.txt') }))
      .rejects.toThrow('changed after it was checked; nothing was written');
    expect(readFileSync(join(ws, 'notes.txt'), 'utf-8')).toBe('old\n');
    expect(readFileSync(join(ws, 'other.txt'), 'utf-8')).toBe('old\n');
  });

  it('edit_file, no workspace: a link set at the file after the judgement is refused before the file it points to is read, so the answer says nothing of its text', async () => {
    setup(false);
    writeFileSync(join(ws, '.env'), 'KEY=1\n');
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const agent = agentWith([resolvingThen(editFileTool, () => relink(join(ws, 'notes.txt'), '.env'))]);
    const result = await call(agent, 'edit_file', { path: 'notes.txt', old_string: 'old', new_string: 'new' });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain(LINK_REFUSED);
    expect(String(result.content)).not.toContain('old_string');
    expect(readFileSync(join(ws, '.env'), 'utf-8')).toBe('KEY=1\n');
  });
});

describe('every wrapper hands the call on', () => {
  const CALL = { writeTarget: '/judged/file' } as const;
  const inner = (): { entry: ToolEntry; seen: unknown[][] } => {
    const seen: unknown[][] = [];
    const entry = { ...writeFileTool, handler: async (...args: unknown[]) => { seen.push(args); return 'done'; } } as unknown as ToolEntry;
    return { entry, seen };
  };
  const agent = { sessionCounters: { writeBytes: 0 } } as unknown as IAgent;

  it('the plugin gate passes the call context to the tool, and leaves a call without one as it was', async () => {
    const { entry, seen } = inner();
    const [gated] = applyPluginToolGate([entry], { fireToolGate: async () => true } as unknown as PluginManager);
    await gated!.handler({ path: 'x' }, agent, CALL);
    await gated!.handler({ path: 'x' }, agent);
    expect(seen).toEqual([[{ path: 'x' }, agent, CALL], [{ path: 'x' }, agent]]);
  });

  it('a workflow step gate passes the call context to the tool after its approval', async () => {
    const { entry, seen } = inner();
    const adapter = { submit: async () => 'id', waitForDecision: async () => ({ status: 'approved' }) };
    const gated = wrapWithGate(entry, adapter as never, {} as never);
    await gated.handler({ path: 'x' }, agent, CALL);
    expect(seen).toEqual([[{ path: 'x' }, agent, CALL]]);
  });
});

describe('the diff preview reads the file that is written', () => {
  it('write_file, no workspace, an artifact path: the preview before the question shows the workspace file it writes, not the artifact', async () => {
    setup(false);
    mkdirSync(join(data, 'artifacts'));
    writeFileSync(join(data, 'artifacts', 'report.html'), 'ARTIFACT TEXT\n');
    writeFileSync(join(ws, 'report.html'), 'WORKSPACE TEXT\n');
    const agent = agentWith([writeFileTool]);
    // Emptying a file is asked about, so the preview is shown first.
    agent.promptUser = vi.fn().mockResolvedValue('Allow');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let shown: string;
    try {
      await call(agent, 'write_file', { path: join(data, 'artifacts', 'report.html'), content: '' });
      shown = stderr.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      stderr.mockRestore();
    }
    expect(shown).toContain('WORKSPACE TEXT');
    expect(shown).not.toContain('ARTIFACT TEXT');
    expect(readFileSync(join(ws, 'report.html'), 'utf-8')).toBe('');
    expect(readFileSync(join(data, 'artifacts', 'report.html'), 'utf-8')).toBe('ARTIFACT TEXT\n');
  });
});

describe('the review saves the file that is written', () => {
  it('isolation, a file in /tmp: a link retargeted after the judgement leaves the backup and the write on the same file', async () => {
    setup(true);
    writeFileSync(join(away, 'b.txt'), 'b old\n');
    writeFileSync(join(away, 'c.txt'), 'c old\n');
    symlinkSync(join(away, 'b.txt'), join(away, 'a.txt'));
    const manager = new ChangesetManager(ws, 'run', [realpathSync('/tmp')]);
    try {
      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', changesetManager: manager,
        tools: [resolvingThen(writeFileTool, () => relink(join(away, 'a.txt'), join(away, 'c.txt')))],
      });
      const result = await call(agent, 'write_file', { path: join(away, 'a.txt'), content: 'new text' });
      expect(result.is_error).not.toBe(true);
      expect(readFileSync(join(away, 'b.txt'), 'utf-8')).toBe('new text');
      expect(readFileSync(join(away, 'c.txt'), 'utf-8')).toBe('c old\n');
      // Saved for the review: the file written, not the one the link points to now.
      expect(manager.getChanges().map((c) => join(ws, c.file))).toEqual([join(away, 'b.txt')]);
      manager.rollbackAll();
      expect(readFileSync(join(away, 'b.txt'), 'utf-8')).toBe('b old\n');
    } finally {
      manager.cleanup();
    }
  });

  it('isolation, a new file in /tmp under a folder link moved after the judgement: the rollback deletes the file that was written', async () => {
    setup(true);
    mkdirSync(join(away, 'one'));
    mkdirSync(join(away, 'two'));
    symlinkSync(join(away, 'one'), join(away, 'dir'));
    const manager = new ChangesetManager(ws, 'run', [realpathSync('/tmp')]);
    try {
      const agent = new Agent({
        name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', changesetManager: manager,
        tools: [resolvingThen(writeFileTool, () => relink(join(away, 'dir'), join(away, 'two')))],
      });
      const result = await call(agent, 'write_file', { path: join(away, 'dir', 'new.txt'), content: 'new text' });
      expect(result.is_error).not.toBe(true);
      expect(readFileSync(join(away, 'one', 'new.txt'), 'utf-8')).toBe('new text');
      manager.rollbackAll();
      expect(existsSync(join(away, 'one', 'new.txt')), 'the file the run wrote is gone').toBe(false);
    } finally {
      manager.cleanup();
    }
  });

  it('isolation: a call resolved to nothing writable saves nothing, so a rollback leaves the file as others left it', async () => {
    setup(true);
    writeFileSync(join(away, 'x.txt'), 'before\n');
    const manager = new ChangesetManager(ws, 'run', [realpathSync('/tmp')]);
    try {
      const unwritable: ToolEntry = { ...writeFileTool, writeTarget: () => null };
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', changesetManager: manager, tools: [unwritable] });
      const result = await call(agent, 'write_file', { path: join(away, 'x.txt'), content: 'new text' });
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toContain('changed after it was checked; nothing was written');
      writeFileSync(join(away, 'x.txt'), 'changed by someone else\n');
      manager.rollbackAll();
      expect(readFileSync(join(away, 'x.txt'), 'utf-8')).toBe('changed by someone else\n');
    } finally {
      manager.cleanup();
    }
  });
});

describe('the guard judges the file it is handed', () => {
  it('a handed file is judged in place of resolving the path again', () => {
    setup(false);
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const handed = join(ws, '.env');
    const signal = isDangerousDetailed('write_file', { path: 'notes.txt', content: 'x' }, 'guided', writeFileTool, undefined, undefined, undefined, 'en', handed);
    expect(signal?.warning).toMatch(/sensitive path/);
    expect(signal?.warning).toContain('.env');
  });

  it('handed nothing, the guard resolves the path itself and judges what it finds', () => {
    setup(false);
    writeFileSync(join(ws, '.env'), 'KEY=1\n');
    symlinkSync('.env', join(ws, 'notes.txt'));
    const signal = isDangerousDetailed('write_file', { path: 'notes.txt', content: 'x' }, 'guided', writeFileTool, undefined, undefined, undefined, 'en');
    expect(signal?.warning).toMatch(/sensitive path/);
  });
});

describe('the window a question opens', () => {
  it('write_file, no workspace: a link set while the owner is asked is refused after the answer, and its target stays as it was', async () => {
    setup(false);
    writeFileSync(join(ws, '.env'), 'KEY=old\n');
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const agent = agentWith([writeFileTool]);
    // Emptying a file is asked about; while the question is open, notes.txt becomes a link.
    const asked = vi.fn().mockImplementation(async () => { relink(join(ws, 'notes.txt'), '.env'); return 'Allow'; });
    agent.promptUser = asked;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await call(agent, 'write_file', { path: 'notes.txt', content: '' });
      expect(asked).toHaveBeenCalledTimes(1);
      expect(result.is_error).toBe(true);
    } finally {
      stderr.mockRestore();
    }
    expect(readFileSync(join(ws, '.env'), 'utf-8')).toBe('KEY=old\n');
  });

  it('write_file, control: answered without a link, the emptied file is written', async () => {
    setup(false);
    writeFileSync(join(ws, 'notes.txt'), 'old\n');
    const agent = agentWith([writeFileTool]);
    const asked = vi.fn().mockResolvedValue('Allow');
    agent.promptUser = asked;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const result = await call(agent, 'write_file', { path: 'notes.txt', content: '' });
      expect(asked).toHaveBeenCalledTimes(1);
      expect(result.is_error).not.toBe(true);
    } finally {
      stderr.mockRestore();
    }
    expect(existsSync(join(ws, 'notes.txt'))).toBe(true);
    expect(readFileSync(join(ws, 'notes.txt'), 'utf-8')).toBe('');
  });
});
