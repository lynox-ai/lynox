import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolEntry, SecretStoreLike } from '../types/index.js';

/**
 * A `secret:` reference never names the file a call reads or writes. The danger check and the
 * changeset review read a call's paths before secrets are filled in, so a path behind a
 * reference would be judged and saved as the reference while the tool works on the file its
 * value names. Which fields name a file is not listed here: it is whatever the danger check
 * reads as a path (`pathFieldsRead`), plus the field the review saves. The real permission
 * guard runs in this file; only the LLM is mocked.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from './agent.js';
import { ChangesetManager } from './changeset.js';
import { setTenantWorkspace, clearTenantWorkspace } from './workspace.js';
import { pathFieldsRead } from '../tools/permission-guard.js';

type Exec = { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> };

/** A tool that knows nothing about secrets: it does what its (resolved) input says. */
function stub(name: string, run: (input: Record<string, unknown>) => void): ToolEntry & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    definition: { name, description: name, input_schema: { type: 'object', properties: {}, additionalProperties: true } },
    handler: async (input: unknown) => { const i = input as Record<string, unknown>; calls.push(i); run(i); return 'done'; },
  } as unknown as ToolEntry & { calls: Array<Record<string, unknown>> };
}
const writer = (): ReturnType<typeof stub> => stub('write_file', (i) => writeFileSync(String(i['path']), String(i['content'])));

/** A vault with one consented secret, TARGET, whose value is `value`. */
function vault(value: string): SecretStoreLike {
  const names = (input: unknown): string[] => (JSON.stringify(input).includes('secret:TARGET') ? ['TARGET'] : []);
  return {
    getMasked: () => '***', resolve: () => value, listNames: () => ['TARGET'], containsSecret: () => false,
    maskSecrets: (t: string) => t, recordConsent: () => {}, hasConsent: () => true, isExpired: () => false,
    findUnresolvedSecretRefs: () => [], extractSecretNames: names,
    resolveSecretRefs: (input: unknown) => JSON.parse(JSON.stringify(input).split('secret:TARGET').join(value)) as unknown,
  } as unknown as SecretStoreLike;
}

const call = (agent: Agent, name: string, input: Record<string, unknown>) =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t${Math.random()}`, name, input });

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'secret-path-')));
  setTenantWorkspace(dir);
});
afterEach(() => {
  clearTenantWorkspace();
  rmSync(dir, { recursive: true, force: true });
});

describe('a secret: reference never names the file a call reads or writes', () => {
  it('a write through a reference under the review is refused, and the user\'s file stays', async () => {
    const notes = join(dir, 'notes.md');
    writeFileSync(notes, 'the user wrote this');
    const manager = new ChangesetManager(dir, 'run');
    const tool = writer();
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [tool], changesetManager: manager, changesetReviewedAfterRun: true, secretStore: vault(notes) });
    const result = await call(agent, 'write_file', { path: 'secret:TARGET', content: 'replaced' });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('has a secret: reference in "path"');
    expect(tool.calls).toEqual([]);
    expect(readFileSync(notes, 'utf8')).toBe('the user wrote this');
    manager.cleanup();
  });

  it('an autonomous write of a sensitive file through a reference is refused', async () => {
    const secret = join(dir, 'deploy.env');
    const tool = writer();
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [tool], autonomy: 'autonomous', secretStore: vault(secret) });
    const result = await call(agent, 'write_file', { path: 'secret:TARGET', content: 'X=1' });
    expect(result.is_error).toBe(true);
    expect(tool.calls).toEqual([]);
    expect(existsSync(secret)).toBe(false);
  });

  it('positive control: the same file named directly is blocked by the danger check', async () => {
    const secret = join(dir, 'deploy.env');
    const tool = writer();
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [tool], autonomy: 'autonomous', secretStore: vault(secret) });
    const result = await call(agent, 'write_file', { path: secret, content: 'X=1' });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('Permission denied');
    expect(existsSync(secret)).toBe(false);
  });

  it('a tool that knows nothing of the rule is refused for every field the check reads as a path', async () => {
    const reader = stub('read_file', () => {});
    const files = stub('batch_files', () => {});
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [reader, files], secretStore: vault(join(dir, 'x')) });
    const read = await call(agent, 'read_file', { path: 'secret:TARGET' });
    // The destination is read after the directory; a sensitive directory must not hide it.
    const moved = await call(agent, 'batch_files', { directory: '/etc', pattern: '*', operation: 'move', destination: 'secret:TARGET' });
    expect(String(read.content)).toContain('in "path"');
    expect(String(moved.content)).toContain('in "destination"');
    expect([reader.calls, files.calls]).toEqual([[], []]);
  });

  it('the field the review saves is covered too, where the check reads no path', async () => {
    const editor = stub('edit_file', () => {});
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [editor], secretStore: vault(join(dir, 'notes.md')) });
    const result = await call(agent, 'edit_file', { path: 'secret:TARGET', old_string: 'a', new_string: 'b' });
    expect(String(result.content)).toContain('in "path"');
    expect(editor.calls).toEqual([]);
  });

  it('a secret anywhere else in the call still works', async () => {
    const out = join(dir, 'config.txt');
    const tool = writer();
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [tool], secretStore: vault('s3cr3t') });
    const result = await call(agent, 'write_file', { path: out, content: 'token=secret:TARGET' });
    expect(result.is_error).not.toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('token=s3cr3t');
  });
});

describe('pathFieldsRead: the fields the danger check reads as a file path, found by running it', () => {
  it.each([
    ['read_file', { path: '/etc/passwd' }, ['path']],
    ['write_file', { path: 'a.txt', content: '' }, ['path']],
    ['batch_files', { directory: '/etc', operation: 'move', destination: '/root' }, ['directory', 'destination']],
    ['batch_files', { directory: 'docs', operation: 'transform' }, ['directory']],
    ['bash', { command: 'cat /etc/passwd' }, []],
    ['http_request', { url: 'https://example.org/a', method: 'GET' }, []],
  ] as const)('%s %j → %j', (tool, input, expected) => {
    expect(pathFieldsRead(tool, input, 'autonomous')).toEqual(expected);
  });
});
