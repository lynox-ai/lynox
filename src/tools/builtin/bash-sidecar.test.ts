import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { bashTool } from './bash.js';
import { isToolSoftFailure } from '../../core/tool-soft-failure.js';
import { runInCallSlot, type CallSlot } from '../../core/call-connection.js';

vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), execSync: vi.fn() }));

/** A daemon stand-in answering every request with `reply` (raw lines). */
let server: Server | null = null;
let dir = '';
let seen: unknown[] = [];
async function daemon(reply: string): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'bash-sidecar-'));
  const sock = join(dir, 'exec.sock');
  seen = [];
  server = createServer((s) => {
    let buf = '';
    s.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\n')) { seen.push(JSON.parse(buf.slice(0, buf.indexOf('\n')))); s.end(reply); } });
  });
  await new Promise<void>((r) => server!.listen(sock, () => r()));
  return sock;
}

const exit = (code: number | null, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: 'exit', code, signal: null, timedOut: false, ...extra }) + '\n';

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('bash through the shell sidecar', () => {
  it('returns stdout only on success and never runs the command in the engine', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon('{"t":"out","d":"hi\\n"}\n{"t":"err","d":"warn"}\n' + exit(0)));
    expect(await bashTool.handler({ command: 'echo hi' }, {} as never)).toBe('hi\n');
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ cmd: 'echo hi', timeoutMs: 120_000 });
  });

  it('does not hand the socket path or credentials to the call', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon(exit(0)));
    vi.stubEnv('ANTHROPIC_API_KEY', 'not-for-the-call');
    await bashTool.handler({ command: 'true' }, {} as never);
    const env = (seen[0] as { env: Record<string, string> }).env;
    expect(env['LYNOX_SHELL_EXEC_SOCKET']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('says "(no output)" for an empty success', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon(exit(0)));
    expect(await bashTool.handler({ command: 'true' }, {} as never)).toBe('(no output)');
  });

  it('reports an exit code like execSync did: stdout and stderr for the agent, the code for the ledger', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon('{"t":"out","d":"o"}\n{"t":"err","d":"e"}\n' + exit(2)));
    const err = await failure(bashTool.handler({ command: 'x' }, {} as never));
    expect(isToolSoftFailure(err)).toBe(true);
    expect((err as { agentVisibleResult?: string }).agentVisibleResult).toBe('o\ne');
    expect((err as { reason?: string }).reason).toBe('bash exited 2');
  });

  it('names a timeout as a timeout, with the capped limit', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon(exit(null, { signal: 'SIGKILL', timedOut: true })));
    const err = await failure(bashTool.handler({ command: 'sleep 9', timeout_ms: 5000 }, {} as never));
    expect((err as { reason?: string }).reason).toBe('bash killed by SIGKILL after 5000ms');
    expect((err as { agentVisibleResult?: string }).agentVisibleResult).toBe('Command failed: sleep 9');
  });

  it('turns a refusal into a hard error, not a soft failure', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon(exit(null, { error: 'no free uid in the pool' })));
    const err = await failure(bashTool.handler({ command: 'x' }, {} as never));
    expect(isToolSoftFailure(err)).toBe(false);
    expect((err as Error).message).toBe('bash: exec sidecar refused the call: no free uid in the pool');
  });

  it('a stopped run kills the command mid-way, and the result says its effects so far stay', async () => {
    // A daemon that prints, then hangs like a long command; it notes the close it would kill on.
    dir = mkdtempSync(join(tmpdir(), 'bash-sidecar-'));
    const sock = join(dir, 'exec.sock');
    let closed = false;
    server = createServer((s) => {
      s.on('error', () => {});
      s.on('close', () => { closed = true; });
      s.once('data', () => s.write('{"t":"out","d":"copied 3 of 10"}\n'));
    });
    await new Promise<void>((r) => server!.listen(sock, () => r()));
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', sock);
    const slot: CallSlot = { abort: new AbortController() };
    const call = failure(runInCallSlot(slot, () => bashTool.handler({ command: 'copy-everything' }, {} as never)));
    await new Promise((r) => setTimeout(r, 50));
    slot.abort!.abort();
    const err = await call;
    // A soft failure: its text takes the result path, where foreign output is scanned and capped.
    expect(isToolSoftFailure(err)).toBe(true);
    expect((err as { reason?: string }).reason).toBe('bash stopped with its run');
    const message = (err as { agentVisibleResult: string }).agentVisibleResult;
    expect(message).toMatch(/^bash: stopped because the run was stopped, and the command was killed before it finished\. What it did until then stays — check before running it again\./);
    expect(message).toContain('Output until the stop:\ncopied 3 of 10');
    // The result speaks of the stop itself, so the engine adds no sentence of its own to it.
    expect(slot.ownStopSentence).toBe(true);
    await vi.waitFor(() => { expect(closed).toBe(true); });
  }, 3000);

  it('a call whose run is already stopped starts no command', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', await daemon(exit(0)));
    const slot: CallSlot = { abort: new AbortController() };
    slot.abort!.abort();
    const err = await failure(runInCallSlot(slot, () => bashTool.handler({ command: 'rm -rf build' }, {} as never)));
    expect((err as { agentVisibleResult?: string }).agentVisibleResult).toMatch(/^bash: stopped because the run was stopped/);
    expect(slot.ownStopSentence).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
  });

  it('has no fallback: an unreachable sidecar is an error, and execSync is not tried', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', join(tmpdir(), 'no-such-exec.sock'));
    const err = await failure(bashTool.handler({ command: 'x' }, {} as never));
    expect((err as Error).message).toMatch(/^bash: exec sidecar: /);
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it('treats a set-but-empty socket variable as broken, not as "run here"', async () => {
    vi.stubEnv('LYNOX_SHELL_EXEC_SOCKET', '');
    await expect(bashTool.handler({ command: 'x' }, {} as never)).rejects.toThrow(/set but empty/);
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });
});
