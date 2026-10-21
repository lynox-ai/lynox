import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool, buildSafeEnv } from './bash.js';
import { isToolSoftFailure, type ToolSoftFailure } from '../../core/tool-soft-failure.js';
import { runInCallSlot, type CallSlot } from '../../core/call-connection.js';
import { getWorkspaceCwd } from '../../core/workspace.js';

// These run real commands through /bin/sh: the local path (no sidecar) is a process the engine
// starts, and a stop, a timeout or an overflow is only shown by what happens to that process.

/** Whether a process with this pid is still alive. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

async function softFailure(call: Promise<string>): Promise<ToolSoftFailure> {
  try {
    const r = await call;
    throw new Error(`expected a ToolSoftFailure, got a plain return: ${r}`);
  } catch (err: unknown) {
    if (!isToolSoftFailure(err)) throw err;
    return err;
  }
}

const run = (command: string, timeoutMs?: number): Promise<string> =>
  bashTool.handler(timeoutMs === undefined ? { command } : { command, timeout_ms: timeoutMs }, {} as never);

describe('bashTool, run here (no sidecar)', () => {
  it('returns stdout on success, and only stdout', async () => {
    expect(await run("printf 'hello world\\n'; printf 'warn' >&2")).toBe('hello world\n');
  });

  it('returns "(no output)" when stdout is empty', async () => {
    expect(await run('true')).toBe('(no output)');
  });

  it('runs in the workspace directory', async () => {
    expect((await run('pwd -P')).trim()).toBe(realpathSync(getWorkspaceCwd()));
  });

  it('closes stdin, so a command that reads it ends instead of waiting', async () => {
    expect(await run('cat')).toBe('(no output)');
  }, 3000);

  it('does not block the event loop while the command runs', async () => {
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 50);
    let ended = false;
    const call = run('sleep 0.5').then(() => { ended = true; });
    await vi.waitFor(() => { expect(ticked).toBe(true); }, { timeout: 400, interval: 10 });
    expect(ended, 'the timer fired while the command still ran').toBe(false);
    await call;
    clearTimeout(timer);
  });

  // A non-zero exit leaves as a `ToolSoftFailure` rather than a plain return, so the run
  // ledger does not count it as a success. The agent reads the output, the ledger the reason.
  it('reports an exit code to the ledger and the output to the agent', async () => {
    const err = await softFailure(run('echo boom >&2; exit 127'));
    expect(err.reason).toBe('bash exited 127');
    expect(err.agentVisibleResult).toBe('boom\n');
  });

  it('gives the agent stdout and stderr on failure, stdout first', async () => {
    const err = await softFailure(run("printf 'partial output'; printf 'error details' >&2; exit 1"));
    expect(err.agentVisibleResult).toBe('partial output\nerror details');
  });

  it('gives the agent only stderr on failure when stdout is empty', async () => {
    expect((await softFailure(run("printf 'only error' >&2; exit 1"))).agentVisibleResult).toBe('only error');
  });

  it('gives the agent "Command failed" when both streams are empty', async () => {
    expect((await softFailure(run('exit 3'))).agentVisibleResult).toBe('Command failed: exit 3');
  });

  it('names a TIMEOUT as a timeout, not as an exit code, and kills what the shell started', async () => {
    // Residuum 2 of four (closing comment 2026-08-02): the old text read "bash exited
    // non-zero", the single reason a reader would rule OUT a timeout.
    const dir = mkdtempSync(join(tmpdir(), 'bash-local-'));
    const pidFile = join(dir, 'pid');
    try {
      const started = Date.now();
      const err = await softFailure(run(`sleep 30 & echo $! > ${pidFile}; wait`, 300));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(err.reason).toBe('bash killed by SIGTERM after 300ms');
      expect(err.reason, 'a killed child never "exited"').not.toContain('exited');
      const pid = Number((await run(`cat ${pidFile}`)).trim());
      leftovers.push(pid);
      await vi.waitFor(() => { expect(alive(pid), 'the background sleep').toBe(false); }, { timeout: 2000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 6000);

  it('ends an output over the cap and names the cap', async () => {
    const err = await softFailure(run("head -c 11000000 /dev/zero | tr '\\0' a; sleep 30"));
    expect(err.reason).toBe('bash output exceeded 10485760 bytes');
  }, 10000);

  it('refuses a timeout that is not a whole number of milliseconds from 0 up', async () => {
    await expect(run('true', -1)).rejects.toThrow(/^bash: timeout_ms must be a whole number/);
    await expect(run('true', 1.5)).rejects.toThrow(/^bash: timeout_ms must be a whole number/);
  });

  it('a stopped run kills the command and what it started, and the result says its effects stay', async () => {
    const slot: CallSlot = { abort: new AbortController() };
    const started = Date.now();
    const call = softFailure(runInCallSlot(slot, () => bashTool.handler({ command: 'sleep 30 & echo $!; wait' }, {} as never)));
    // The shell prints the background sleep's pid before it waits.
    await new Promise((r) => setTimeout(r, 300));
    slot.abort!.abort();
    const err = await call;
    expect(Date.now() - started, 'ended by the stop, not by the 120 s limit').toBeLessThan(3000);
    expect(err.reason).toBe('bash stopped with its run');
    expect(err.agentVisibleResult).toMatch(/^bash: stopped because the run was stopped, and the command was killed before it finished\. What it did until then stays — check before running it again\./);
    const pid = Number(/Output until the stop:\n(\d+)/.exec(err.agentVisibleResult)?.[1]);
    expect(pid).toBeGreaterThan(0);
    leftovers.push(pid);
    await vi.waitFor(() => { expect(alive(pid), 'the background sleep').toBe(false); }, { timeout: 2000 });
    // The result speaks of the stop itself, so the engine adds no sentence of its own to it.
    expect(slot.ownStopSentence).toBe(true);
  }, 6000);

  it('a call in a run that is not stopped runs to its end', async () => {
    const slot: CallSlot = { abort: new AbortController() };
    expect(await runInCallSlot(slot, () => bashTool.handler({ command: 'sleep 0.2; echo done' }, {} as never))).toBe('done\n');
    expect(slot.ownStopSentence).toBeUndefined();
  });

  it('a call whose run is already stopped starts no command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-local-'));
    const marker = join(dir, 'ran');
    try {
      const slot: CallSlot = { abort: new AbortController() };
      slot.abort!.abort();
      const err = await softFailure(runInCallSlot(slot, () => bashTool.handler({ command: `touch ${marker}` }, {} as never)));
      expect(err.agentVisibleResult).toBe('bash: not run, because the run was stopped before the command started.');
      expect(err.reason).toBe('bash stopped with its run');
      expect(slot.ownStopSentence).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      process.env['GIT_AUTHOR_NAME'] = 'Alice';
      process.env['GIT_COMMITTER_EMAIL'] = 'alice@example.com';
      try {
        const env = buildSafeEnv();
        expect(env['GIT_AUTHOR_NAME']).toBe('Alice');
        expect(env['GIT_COMMITTER_EMAIL']).toBe('alice@example.com');
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

describe('bash tool description', () => {
  const description = bashTool.definition.description;

  it('no longer advertises package management', () => {
    // It used to. A model reads the description as a statement of capability,
    // and this one named a capability the managed runtime does not have —
    // read-only root, non-root user, no package manager. The measured cost was
    // 41 bash calls in a single thread rediscovering that.
    expect(description).not.toMatch(/package management/i);
  });

  it('states the prohibition as a POLICY, not as a claim about the environment', () => {
    // Deliberate: a local `npx lynox` run may well have a working apt or npm, so
    // "you cannot install" would be false there and would teach the model to
    // distrust the description. "Do not install" is true in every deployment.
    expect(description).toMatch(/installing packages/i);
    expect(description).not.toMatch(/no package manager|cannot install|not available/i);
  });

  it('stands alone — it does not defer to text the holder may not have', () => {
    // The first draft of this description ended "(see the tools section of your
    // instructions)". That pointer is dead for most holders of the tool: a
    // spawned child is given GROUNDING_PROMPT_BLOCK plus its own role prompt and
    // never SYSTEM_PROMPT (spawn.ts), and so is a workflow step
    // (runtime-adapter.ts), while both inherit the parent's tool list including
    // bash. Pointing at a document the reader does not have is the same class of
    // defect as advertising a capability the runtime does not have.
    // Forbid the DEIXIS, not the one string that was deleted. The earlier form
    // of this test matched `see the … section|your instructions|the system
    // prompt`, which catches the exact phrase already gone and none of the
    // seven plausible ways to write it back: "see your system instructions",
    // "refer to the Tools section of your prompt", "(see above)",
    // "(per your guidelines)". A short tool description has no legitimate use
    // for a pointer, so the verb is the invariant.
    expect(description).not.toMatch(/\b(see|refer(s|ring)? to|as (described|noted|documented)|per your)\b/i);
  });

});
