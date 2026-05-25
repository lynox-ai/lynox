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

  // H-004: auth-bearing handles that don't match CREDENTIAL_NAME_RE. The
  // bash tool can no longer authenticate via ssh-agent or hijack git's
  // askpass/ssh-command hooks unless the caller explicitly forwards them
  // via isolation.envVars (the deliberate opt-in path).
  describe('H-004 auth-handle filter', () => {
    const H004_NAMES = ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'GIT_SSH_COMMAND'];

    afterEach(() => {
      for (const name of H004_NAMES) {
        delete process.env[name];
      }
    });

    it('strips SSH_AUTH_SOCK from subprocess env', () => {
      process.env['SSH_AUTH_SOCK'] = '/tmp/ssh-agent.sock';
      const env = buildSafeEnv();
      expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    });

    it('strips GIT_ASKPASS from subprocess env', () => {
      process.env['GIT_ASKPASS'] = '/evil/script.sh';
      const env = buildSafeEnv();
      expect(env['GIT_ASKPASS']).toBeUndefined();
    });

    it('strips GIT_SSH_COMMAND from subprocess env', () => {
      process.env['GIT_SSH_COMMAND'] = '/bin/evil';
      const env = buildSafeEnv();
      expect(env['GIT_SSH_COMMAND']).toBeUndefined();
    });

    it('preserves PATH/HOME/USER/LANG (legitimate vars not affected)', () => {
      const env = buildSafeEnv();
      expect(env['PATH']).toBe(process.env['PATH']);
      expect(env['HOME']).toBe(process.env['HOME']);
      if (process.env['USER']) {
        expect(env['USER']).toBe(process.env['USER']);
      }
      if (process.env['LANG']) {
        expect(env['LANG']).toBe(process.env['LANG']);
      }
    });

    it('preserves legitimate GIT_ vars (GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL)', () => {
      process.env['GIT_AUTHOR_NAME'] = 'Rafael';
      process.env['GIT_COMMITTER_EMAIL'] = 'rafael@example.com';
      try {
        const env = buildSafeEnv();
        expect(env['GIT_AUTHOR_NAME']).toBe('Rafael');
        expect(env['GIT_COMMITTER_EMAIL']).toBe('rafael@example.com');
      } finally {
        delete process.env['GIT_AUTHOR_NAME'];
        delete process.env['GIT_COMMITTER_EMAIL'];
      }
    });

    it('preserves NODE_PATH and NPM_CONFIG_REGISTRY (allow-listed, no credential substring)', () => {
      process.env['NODE_PATH'] = '/usr/lib/node_modules';
      process.env['NPM_CONFIG_REGISTRY'] = 'https://registry.npmjs.org/';
      try {
        const env = buildSafeEnv();
        expect(env['NODE_PATH']).toBe('/usr/lib/node_modules');
        expect(env['NPM_CONFIG_REGISTRY']).toBe('https://registry.npmjs.org/');
      } finally {
        delete process.env['NODE_PATH'];
        delete process.env['NPM_CONFIG_REGISTRY'];
      }
    });

    it('still strips NPM_TOKEN (CREDENTIAL_NAME_RE regression guard)', () => {
      process.env['NPM_TOKEN'] = 'npm_xxxxxx';
      try {
        const env = buildSafeEnv();
        expect(env['NPM_TOKEN']).toBeUndefined();
      } finally {
        delete process.env['NPM_TOKEN'];
      }
    });

    it('air-gapped isolation does not leak SSH_AUTH_SOCK/GIT_ASKPASS/GIT_SSH_COMMAND', () => {
      process.env['SSH_AUTH_SOCK'] = '/tmp/ssh-agent.sock';
      process.env['GIT_ASKPASS'] = '/evil/script.sh';
      process.env['GIT_SSH_COMMAND'] = '/bin/evil';
      try {
        const env = buildSafeEnv({ level: 'air-gapped' });
        expect(env['SSH_AUTH_SOCK']).toBeUndefined();
        expect(env['GIT_ASKPASS']).toBeUndefined();
        expect(env['GIT_SSH_COMMAND']).toBeUndefined();
        // Bare-essentials still present
        expect(env['PATH']).toBe(process.env['PATH']);
      } finally {
        // afterEach handles H004_NAMES cleanup
      }
    });

    it('caller-explicit isolation.envVars CAN forward SSH_AUTH_SOCK (intentional opt-in path)', () => {
      // spawn_agent may legitimately need ssh-agent auth for a scoped
      // child — the isolation.envVars merge runs AFTER the explicit
      // H-004 drops, so the override still wins.
      const env = buildSafeEnv({
        level: 'scoped',
        envVars: { SSH_AUTH_SOCK: '/tmp/explicit-agent.sock' },
      });
      expect(env['SSH_AUTH_SOCK']).toBe('/tmp/explicit-agent.sock');
    });
  });
});
