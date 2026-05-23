import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { bashTool, buildSafeEnv } from './bash.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe('bashTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stdout on success', async () => {
    mockedExecSync.mockReturnValue('hello world\n');
    const result = await bashTool.handler({ command: 'echo hello world' }, {} as never);
    expect(result).toBe('hello world\n');
    expect(mockedExecSync).toHaveBeenCalledWith('echo hello world', expect.objectContaining({
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    }));
  });

  it('returns "(no output)" when stdout is empty', async () => {
    mockedExecSync.mockReturnValue('');
    const result = await bashTool.handler({ command: 'true' }, {} as never);
    expect(result).toBe('(no output)');
  });

  it('uses custom timeout_ms when provided', async () => {
    mockedExecSync.mockReturnValue('ok');
    await bashTool.handler({ command: 'sleep 1', timeout_ms: 5000 }, {} as never);
    expect(mockedExecSync).toHaveBeenCalledWith('sleep 1', expect.objectContaining({
      timeout: 5000,
    }));
  });

  it('returns combined stdout+stderr on failure with both', async () => {
    const err = Object.assign(new Error('cmd failed'), {
      stdout: 'partial output',
      stderr: 'error details',
    });
    mockedExecSync.mockImplementation(() => { throw err; });
    const result = await bashTool.handler({ command: 'bad-cmd' }, {} as never);
    expect(result).toBe('partial output\nerror details');
  });

  it('returns only stderr on failure when stdout is empty', async () => {
    const err = Object.assign(new Error('cmd failed'), {
      stdout: '',
      stderr: 'only error',
    });
    mockedExecSync.mockImplementation(() => { throw err; });
    const result = await bashTool.handler({ command: 'fail' }, {} as never);
    expect(result).toBe('only error');
  });

  it('returns "Command failed" when both stdout and stderr are empty', async () => {
    const err = Object.assign(new Error('cmd failed'), {
      stdout: '',
      stderr: '',
    });
    mockedExecSync.mockImplementation(() => { throw err; });
    const result = await bashTool.handler({ command: 'empty-fail' }, {} as never);
    expect(result).toBe('Command failed: empty-fail');
  });

  it('wraps non-standard error with cause', async () => {
    mockedExecSync.mockImplementation(() => { throw new Error('segfault'); });
    await expect(bashTool.handler({ command: 'crash' }, {} as never))
      .rejects.toThrow('bash: segfault');
    try {
      await bashTool.handler({ command: 'crash' }, {} as never);
    } catch (e) {
      expect((e as Error).cause).toBeInstanceOf(Error);
      expect(((e as Error).cause as Error).message).toBe('segfault');
    }
  });

  it('wraps non-Error throw with cause', async () => {
    mockedExecSync.mockImplementation(() => { throw 'string error'; });
    await expect(bashTool.handler({ command: 'throw-string' }, {} as never))
      .rejects.toThrow('bash: string error');
    try {
      await bashTool.handler({ command: 'throw-string' }, {} as never);
    } catch (e) {
      expect((e as Error).cause).toBeInstanceOf(Error);
      expect(((e as Error).cause as Error).message).toBe('string error');
    }
  });
});

describe('buildSafeEnv', () => {
  it('strips ANTHROPIC_API_KEY from subprocess env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const env = buildSafeEnv();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('strips LYNOX_VAULT_KEY from subprocess env', () => {
    process.env['LYNOX_VAULT_KEY'] = 'vault-key-123';
    const env = buildSafeEnv();
    expect(env['LYNOX_VAULT_KEY']).toBeUndefined();
    delete process.env['LYNOX_VAULT_KEY'];
  });

  it('strips SLACK_BOT_TOKEN from subprocess env', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
    const env = buildSafeEnv();
    expect(env['SLACK_BOT_TOKEN']).toBeUndefined();
    delete process.env['SLACK_BOT_TOKEN'];
  });

  it('passes PATH, HOME, NODE_ENV through', () => {
    const env = buildSafeEnv();
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['HOME']).toBe(process.env['HOME']);
    if (process.env['NODE_ENV']) {
      expect(env['NODE_ENV']).toBe(process.env['NODE_ENV']);
    }
  });

  it('passes LYNOX_WORKSPACE through', () => {
    process.env['LYNOX_WORKSPACE'] = '/workspace';
    const env = buildSafeEnv();
    expect(env['LYNOX_WORKSPACE']).toBe('/workspace');
    delete process.env['LYNOX_WORKSPACE'];
  });

  it('air-gapped isolation collapses env to PATH/HOME/TMPDIR only', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-leak';
    process.env['LYNOX_VAULT_KEY'] = 'vault-leak';
    process.env['LYNOX_WORKSPACE'] = '/workspace';
    try {
      const env = buildSafeEnv({ level: 'air-gapped' });
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['LYNOX_VAULT_KEY']).toBeUndefined();
      expect(env['LYNOX_WORKSPACE']).toBeUndefined();
      expect(env['PATH']).toBe(process.env['PATH']);
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['LYNOX_VAULT_KEY'];
      delete process.env['LYNOX_WORKSPACE'];
    }
  });

  it('air-gapped isolation merges envVars on top of minimal env', () => {
    const env = buildSafeEnv({
      level: 'air-gapped',
      envVars: { CHILD_ONLY: 'set-by-spawn' },
    });
    expect(env['CHILD_ONLY']).toBe('set-by-spawn');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('scoped isolation envVars override env without enabling air-gap collapse', () => {
    process.env['LYNOX_WORKSPACE'] = '/parent-workspace';
    try {
      const env = buildSafeEnv({
        level: 'scoped',
        envVars: { LYNOX_WORKSPACE: '/child-workspace' },
      });
      expect(env['LYNOX_WORKSPACE']).toBe('/child-workspace');
      expect(env['PATH']).toBe(process.env['PATH']); // not collapsed
    } finally {
      delete process.env['LYNOX_WORKSPACE'];
    }
  });

  // T2-S4: name-pattern filter catches credential-bearing env vars whose
  // prefix may be allow-listed (NPM_TOKEN, GITHUB_TOKEN, DOCKER_AUTH_TOKEN)
  // or whose name is custom (MYBANK_TOKEN, MY_SECRET, DB_PASSWORD). The
  // legacy "drop known prefixes" pass missed all of these.
  describe('T2-S4 credential-name filter', () => {
    const SAMPLE_CREDENTIAL_NAMES = [
      'MYBANK_TOKEN',     // custom prefix, no allow-list match (and even if it had one)
      'STRIPE_KEY',        // custom prefix
      'MY_SECRET',         // custom prefix
      'DB_PASSWORD',       // custom prefix
      'NPM_TOKEN',         // NPM_ prefix IS allow-listed — must still be filtered
      'GITHUB_TOKEN',      // GITHUB_ prefix IS allow-listed — must still be filtered
      'DOCKER_AUTH_TOKEN', // DOCKER_ prefix IS allow-listed — must still be filtered
      'lowercase_token',   // case-insensitive
    ];

    afterEach(() => {
      for (const name of SAMPLE_CREDENTIAL_NAMES) {
        delete process.env[name];
      }
    });

    it('filters credential-named env vars regardless of allow-listed prefix', () => {
      for (const name of SAMPLE_CREDENTIAL_NAMES) {
        process.env[name] = 'sensitive-value';
      }
      const env = buildSafeEnv();
      for (const name of SAMPLE_CREDENTIAL_NAMES) {
        expect(env[name], `${name} must be filtered`).toBeUndefined();
      }
    });

    it('still passes legitimate non-credential env vars through', () => {
      const env = buildSafeEnv();
      expect(env['PATH']).toBe(process.env['PATH']);
      expect(env['HOME']).toBe(process.env['HOME']);
      if (process.env['LANG']) {
        expect(env['LANG']).toBe(process.env['LANG']);
      }
    });

    it('does NOT filter caller-explicit isolation.envVars (scoped path)', () => {
      // spawn_agent may deliberately forward a single scoped token to a
      // child — that's the explicit-opt-in path, not the inherited-env
      // path, so the regex filter does not apply here.
      const env = buildSafeEnv({
        level: 'scoped',
        envVars: { CHILD_SCOPED_TOKEN: 'forwarded-by-caller' },
      });
      expect(env['CHILD_SCOPED_TOKEN']).toBe('forwarded-by-caller');
    });
  });
});
