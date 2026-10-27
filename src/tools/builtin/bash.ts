import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolEntry, IAgent } from '../../types/index.js';
import type { IsolationConfig } from '../../types/security.js';
import { getWorkspaceCwd } from '../../core/workspace.js';
import { MAX_BUFFER_BYTES } from '../../core/constants.js';
import { ToolSoftFailure } from '../../core/tool-soft-failure.js';
import { execViaSidecar, SidecarOverflowError, SidecarStoppedError, CLIENT_GRACE_MS } from '../../shell-sidecar/client.js';
import { egressConfigFromEnv, openShellEgress, PROXY_ENV_NAMES, withNetworkLines } from '../../shell-sidecar/egress.js';
import { capTimeout } from '../../shell-sidecar/protocol.js';
import { resolveGuardedAckHosts } from '../../core/tool-context.js';
import { currentCallSignal, noteOwnStopSentence } from '../../core/call-connection.js';

interface BashInput {
  command: string;
  timeout_ms?: number | undefined;
}

/** Env var prefixes/names safe to pass to subprocesses */
const ENV_SAFE_PREFIXES = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_',
  'TMPDIR', 'TMP', 'TEMP',
  'NODE_', 'NPM_',
  'EDITOR', 'VISUAL', 'PAGER',
  'GIT_',
  'DISPLAY', 'XDG_',
  'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL',
  'COLORTERM', 'FORCE_COLOR', 'NO_COLOR',
  'LYNOX_WORKSPACE',
  'CI', 'GITHUB_',
  'DOCKER_', 'COMPOSE_',
];

/**
 * Name-pattern filter for credential-bearing env vars.
 *
 * Allow-list-by-prefix alone is insufficient: a var like `NPM_TOKEN`,
 * `GITHUB_TOKEN`, `DOCKER_AUTH_TOKEN`, or a customer-supplied
 * `MYBANK_TOKEN` matches one of the allow-listed prefixes (NPM_, GITHUB_,
 * DOCKER_, or — in the MYBANK case — none, but the agent could plausibly
 * have it in `process.env` from a parent invocation) yet still carries a
 * credential. Dropping by prefix alone leaves the credential in the
 * subprocess env.
 *
 * This regex matches case-insensitively on the NAME (not the value) of any
 * env var that contains TOKEN / KEY / SECRET / PASSWORD as a substring.
 * Applied AFTER the prefix allow-list and AFTER the explicit
 * NODE_OPTIONS/NODE_EXTRA_CA_CERTS drops, so even an allow-listed prefix
 * can't smuggle a credential through.
 *
 * Caveat: this is broader than strictly necessary — e.g. a
 * `LYNOX_KEY_BINDINGS` var would also be filtered. Per PRD-T2-S4 the
 * mandatory form is the broad regex; legitimate non-secret names
 * containing these tokens are rare and the false-negative risk of a
 * leaked credential is the dominant cost. `isolation.envVars` overrides
 * (set by the caller deliberately, e.g. by spawn_agent) bypass this
 * filter — that's the explicit scoped path.
 */
const CREDENTIAL_NAME_RE = /(TOKEN|KEY|SECRET|PASSWORD)/i;

/**
 * Build the env that subprocesses inherit.
 *
 * Isolation source of truth is the calling agent's `isolation` config:
 *  - `air-gapped` collapses to PATH/HOME/TMPDIR only — no secrets, no LLM
 *    credentials, no integration tokens, nothing the parent process holds.
 *  - `envVars` (any level) is merged on top of the allow-listed env, letting
 *    `spawn_agent` inject the deliberately-scoped variables it wants the child
 *    bash invocation to see.
 *
 * Pre-isolation behaviour (no agent, or `isolation` unset) is the previous
 * allow-listed env minus NODE_OPTIONS / NODE_EXTRA_CA_CERTS — and minus
 * SSH_AUTH_SOCK / GIT_ASKPASS / GIT_SSH_COMMAND (H-004): these are
 * auth-bearing handles that don't match the credential-name regex but let
 * the LLM sign operations as the user (ssh-agent forwarding, arbitrary
 * binary exec via git's askpass / ssh-command hooks). Callers who need
 * ssh-agent auth must opt in deliberately via `isolation.envVars`.
 */
export function buildSafeEnv(isolation?: IsolationConfig): NodeJS.ProcessEnv {
  // Air-gapped: minimal env, nothing inherited beyond the bare essentials.
  if (isolation?.level === 'air-gapped') {
    const minEnv: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR']) {
      if (process.env[key] !== undefined) {
        minEnv[key] = process.env[key];
      }
    }
    if (isolation.envVars) {
      for (const [key, value] of Object.entries(isolation.envVars)) {
        minEnv[key] = value;
      }
    }
    return minEnv;
  }

  const safeEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!ENV_SAFE_PREFIXES.some(p => key === p || key.startsWith(p))) continue;
    // Name-pattern credential filter — see CREDENTIAL_NAME_RE comment.
    // Catches NPM_TOKEN, GITHUB_TOKEN, DOCKER_AUTH_TOKEN, MYBANK_KEY,
    // STRIPE_SECRET, DB_PASSWORD, etc., regardless of whether their
    // prefix is allow-listed.
    if (CREDENTIAL_NAME_RE.test(key)) continue;
    safeEnv[key] = value;
  }

  // Remove dangerous NODE_ vars that could be exploited for code injection
  delete safeEnv.NODE_OPTIONS;
  delete safeEnv.NODE_EXTRA_CA_CERTS;

  // H-004: auth-bearing handles that don't match CREDENTIAL_NAME_RE.
  // Defense-in-depth — even if a future edit re-adds the prefix, these
  // explicit drops fire AFTER the allow-list loop and AFTER the regex
  // filter, BEFORE the isolation.envVars merge (which is the intentional
  // opt-in path for callers like spawn_agent that need ssh-agent auth).
  delete safeEnv.SSH_AUTH_SOCK;    // ssh-agent socket — lets LLM sign as the user
  delete safeEnv.GIT_ASKPASS;       // exec'd binary — captures git credentials
  delete safeEnv.GIT_SSH_COMMAND;   // replaces ssh binary in git operations

  // Per-spawn env overrides for scoped/sandboxed levels.
  // These are caller-explicit — spawn_agent / orchestrator deliberately
  // scoped them for the child, so the credential-name regex does NOT
  // apply (a caller can legitimately want to forward a single token to a
  // tightly-scoped child).
  if (isolation?.envVars) {
    for (const [key, value] of Object.entries(isolation.envVars)) {
      safeEnv[key] = value;
    }
  }

  return safeEnv;
}

/**
 * Managed hosting runs bash in the shell sidecar, not in the engine (PRD 152 v2 §4.1): the
 * engine holds the vault key and the integration credentials, a call's processes must not
 * share its container. When the socket is set there is NO fallback to running it here — a
 * missing or refusing sidecar is an error, never a reason to run the command here (S5).
 *
 * The call starts in the sidecar's workspace root, the same volume the engine's workspace
 * is. Calls are asynchronous now, so two bash calls of one turn can run side by side.
 */
async function runInSidecar(socketPath: string, input: BashInput, env: NodeJS.ProcessEnv): Promise<string> {
  const callEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) callEnv[k] = v;
  let r;
  try {
    r = await execViaSidecar(socketPath, { cmd: input.command, timeoutMs: input.timeout_ms, env: callEnv }, MAX_BUFFER_BYTES, CLIENT_GRACE_MS, currentCallSignal());
  } catch (err: unknown) {
    // The run was stopped and the call killed mid-command. Whatever it did until then stays,
    // so the sentence must not read as "did not run". A soft failure, like the overflow below:
    // what the command printed is foreign text of any length, and only the result path scans and
    // caps it — a hard error's message goes to the model as is.
    if (err instanceof SidecarStoppedError) throw stoppedFailure(err.stdout, err.stderr);
    if (err instanceof SidecarOverflowError) {
      const combined = [err.stdout, err.stderr].filter(Boolean).join('\n');
      throw new ToolSoftFailure(combined || `Command failed: ${input.command}`, `bash output exceeded ${String(err.maxBytes)} bytes`);
    }
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new Error(`bash: ${cause.message}`, { cause });
  }
  if (r.error !== undefined) throw new Error(`bash: exec sidecar refused the call: ${r.error}`);
  if (r.code === 0 && !r.timedOut) return r.stdout || '(no output)';
  const combined = [r.stdout, r.stderr].filter(Boolean).join('\n');
  const reason = r.timedOut
    ? `bash killed by ${r.signal ?? 'SIGKILL'} after ${String(r.limitMs)}ms`
    : typeof r.code === 'number'
      ? `bash exited ${String(r.code)}`
      : r.signal !== null
        ? `bash killed by ${r.signal}`
        : 'bash failed without an exit code';
  throw new ToolSoftFailure(combined || `Command failed: ${input.command}`, reason);
}

/**
 * A sidecar call with the egress proxy (PRD 152 v2 §4.2, W2): the call reaches the network
 * only through a credential registered for this call with the hosts `network_policy` allows.
 * What the proxy refused is added to the result, on success and on failure alike: a refused
 * `wget` exits non-zero, and that is when the model needs to read why. The credential is
 * revoked before the result goes back, and its plain forms are removed from what the call
 * printed (hygiene, not a boundary).
 */
async function runInSidecarWithEgress(socketPath: string, input: BashInput, env: NodeJS.ProcessEnv, agent: IAgent): Promise<string> {
  // Only the engine's own proxy variables reach the call, never ones from the isolation config.
  for (const name of PROXY_ENV_NAMES) delete env[name];
  const config = egressConfigFromEnv();
  // No egress proxy configured: the call has no network, as before.
  if (config.secret === undefined || config.secret === '') return runInSidecar(socketPath, input, env);
  const ctx = agent.toolContext;
  const egress = await openShellEgress({
    policy: {
      networkPolicy: ctx.networkPolicy,
      allowedHosts: ctx.allowedHosts,
      allowedWildcards: ctx.allowedWildcards,
      ackHosts: resolveGuardedAckHosts(ctx),
    },
    timeoutMs: input.timeout_ms,
    run: agent.currentRunId,
    session: agent.currentThreadId ?? agent.originThreadId,
    config,
  });
  if (egress === null) return runInSidecar(socketPath, input, env);
  Object.assign(env, egress.env);
  let out: string;
  try {
    out = await runInSidecar(socketPath, input, env);
  } catch (err: unknown) {
    const lines = await egress.finish();
    if (err instanceof ToolSoftFailure) throw new ToolSoftFailure(withNetworkLines(lines, egress.redact(err.agentVisibleResult)), egress.redact(err.reason));
    // A hard error keeps its `bash: ` prefix first; its message is short. No `cause`: it would
    // carry the text before redaction.
    const message = egress.redact(err instanceof Error ? err.message : String(err));
    throw new Error(lines === '' ? message : `${message}\n\n${lines}`);
  }
  const lines = await egress.finish();
  return withNetworkLines(lines, egress.redact(out));
}

// NOTE: This tool intentionally uses shell execution.
// It is a bash tool for an autonomous agent — shell features are required by design.
// Input comes from the LLM agent, not from untrusted external users.

export const bashTool: ToolEntry<BashInput> = {
  undo: 'none',
  definition: {
    name: 'bash',
    // "package management" used to sit in this list, and it was an advertisement
    // for something the runtime does not offer: the managed container runs
    // read-only, as a non-root user, with no package manager configured. A model
    // reading this description took it as a capability and spent 41 bash calls in
    // one thread on `apt-get install`, `npm install` and five hand-written
    // extractors before giving up — every one of them costing tokens and time to
    // rediscover a constraint the description had implied away.
    //
    // What replaces it is a POLICY, not a claim about the environment: a local
    // `npx lynox` run may well have a working apt or npm, so "you cannot install"
    // would be false there. "Do not install" is true everywhere.
    //
    // It has to be SELF-CONTAINED. A first draft ended "(see the tools section of
    // your instructions)" and that pointer dangles for most holders of this tool:
    // a spawned child gets GROUNDING_PROMPT_BLOCK and its own role prompt, never
    // SYSTEM_PROMPT (spawn.ts), while inheriting the parent's tool list — bash
    // included. Same for a workflow step declaring `tools:['bash']` and for any
    // deployment that sets its own `config.systemPrompt`. Pointing at a document
    // the reader does not have is the same failure as advertising a capability the
    // runtime does not have, one step along. The system prompt keeps the REASON
    // and the alternatives, for the agent that has it; the rule travels with the
    // tool, for everyone.
    description: 'Execute a shell command for system operations, git, or process control. NEVER use for file reads/writes (use read_file/write_file), web searches (use web_research), or installing packages — report the missing capability instead.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds' },
      },
      required: ['command'],
    },
  },
  // NOTE: a shell is intentional — this is a bash tool requiring shell features.
  // Input comes from the LLM agent, not untrusted external users.
  handler: async (input: BashInput, agent: IAgent): Promise<string> => {
    const safeEnv = buildSafeEnv(agent.isolation);
    // Decided once at boot (`shell-isolation.ts`): a broken socket value stopped the start there.
    const isolation = agent.toolContext.shellIsolation;
    if (isolation.kind === 'sidecar') return runInSidecarWithEgress(isolation.socket, input, safeEnv, agent);
    return runLocal(input, safeEnv, currentCallSignal());
  },
};

/** The stop's own sentence, the same for both paths: what the command did until then stays. */
function stoppedFailure(stdout: string, stderr: string): ToolSoftFailure {
  const printed = [stdout, stderr].filter(Boolean).join('\n');
  noteOwnStopSentence();
  return new ToolSoftFailure(
    `bash: stopped because the run was stopped, and the command was killed before it finished. `
      + `What it did until then stays — check before running it again.${printed === '' ? '' : `\n\nOutput until the stop:\n${printed}`}`,
    'bash stopped with its run',
  );
}

const IS_WINDOWS = process.platform === 'win32';
/** How long a command gets after SIGTERM (timeout, overflow) before its group is killed and
 *  the call ends with what it printed — also when something it started still holds a pipe. */
const KILL_GRACE_MS = 1000;

/**
 * The process groups of local commands still running. `detached` takes a command out of the
 * terminal's process group, so a Ctrl+C on the engine no longer reaches it. Whatever still runs
 * here is killed when the process emits 'exit': a normal exit, the SIGINT/SIGTERM shutdown, an
 * uncaught exception. Not on SIGHUP (no handler, so Node ends without 'exit'), SIGKILL or a V8
 * abort; a process that left the group with `setsid` outlives the engine, as under `execSync`.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // run-group-starter: a process-exit hook, it kills processes and reports no spend.
  process.on('exit', () => {
    for (const pgid of liveGroups) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
  });
}

/**
 * A call without the sidecar (self-host): the command runs here, in its own process group.
 *
 * It used to run through `execSync`, which blocks the event loop until the command ends: a
 * stop of the run could not even be seen until then. Now the command runs asynchronously, and
 * a stop kills its whole group at once (SIGKILL, as the sidecar does) and ends the call with
 * the output so far, without waiting for a process that still holds a pipe open.
 *
 * The time limit follows the sidecar's rules ({@link capTimeout}): unset or invalid is the
 * default, `0` and anything above it are the 15-minute ceiling. A command that no longer
 * blocks the event loop is cut at the engine's 15-minute tool limit anyway, so "no limit" was
 * not true any more; at the ceiling it is that tool limit, not this one, whose message the
 * model reads. At the limit the group gets SIGTERM, then SIGKILL after {@link KILL_GRACE_MS}. stdout and stderr share one cap of {@link MAX_BUFFER_BYTES}, as they
 * did under `execSync`; stdin is closed.
 */
async function runLocal(input: BashInput, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): Promise<string> {
  const limitMs = capTimeout(input.timeout_ms);
  if (signal?.aborted === true) {
    noteOwnStopSentence();
    throw new ToolSoftFailure('bash: not run, because the run was stopped before the command started.', 'bash stopped with its run');
  }
  // The stop arrives in the abort listener, outside this call's async context, where
  // `noteOwnStopSentence` finds no call to mark. So the promise only reports it, and the
  // failure is built after the `await`, back in the call's context.
  const outcome = await new Promise<string | { stopped: true; stdout: string; stderr: string }>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(input.command, {
        shell: true,
        cwd: getWorkspaceCwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so that a kill reaches what the shell started too.
        detached: !IS_WINDOWS,
      });
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      reject(new Error(`bash: ${cause.message}`, { cause }));
      return;
    }
    const pgid = child.pid;
    if (pgid !== undefined && !IS_WINDOWS) trackGroup(pgid);
    child.stdin?.end();

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    let killedAfterGrace = false;
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf-8');

    const killGroup = (sig: NodeJS.Signals): void => {
      if (pgid !== undefined && !IS_WINDOWS) {
        try { process.kill(-pgid, sig); return; } catch { /* the group is gone already */ }
      }
      child.kill(sig);
    };
    const finish = (): void => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      signal?.removeEventListener('abort', onStop);
      if (pgid !== undefined) liveGroups.delete(pgid);
    };
    const failWith = (code: number | null, sig: NodeJS.Signals | null): void => {
      const combined = [text(out), text(errOut)].filter(Boolean).join('\n');
      // The agent still reads the output verbatim and adapts — that behaviour
      // is deliberate and unchanged. But a non-zero exit is a FAILURE, and
      // returning it plainly recorded it in the run ledger as a success:
      // `toolEnd` publishes `success: true` for anything a handler returns.
      // One real thread logged 123 tool calls and exactly 1 error while a long
      // run of `wget` calls was failing.
      // A TIMEOUT is not an exit code: the old text read "bash exited non-zero",
      // which is the one reason a reader would rule OUT a timeout. The ledger
      // reason is the only trace of why a call failed, so it has to name the
      // actual cause. (Residuum 2 of four, closing comment 2026-08-02.)
      const reason = overflowed
        ? `bash output exceeded ${String(MAX_BUFFER_BYTES)} bytes`
        : timedOut
          ? killedAfterGrace
            ? `bash killed by SIGKILL after ${String(limitMs)}ms and a ${String(KILL_GRACE_MS)}ms grace`
            : `bash killed by ${sig ?? 'SIGTERM'} after ${String(limitMs)}ms`
          : typeof code === 'number'
            ? `bash exited ${String(code)}`
            : sig !== null
              ? `bash killed by ${sig}`
              : 'bash failed without an exit code';
      reject(new ToolSoftFailure(combined || `Command failed: ${input.command}`, reason));
    };
    /** Timeout or overflow: SIGTERM now; after the grace, SIGKILL and end the call, whether or
     *  not the pipes closed (a process that left the group can hold them for good). */
    const endCommand = (): void => {
      // Once: a limit that passes during an overflow's grace changes nothing.
      if (grace !== undefined) return;
      clearTimeout(timer);
      killGroup('SIGTERM');
      // run-group-starter: lives only as long as this one command and reports no spend.
      grace = setTimeout(() => {
        if (settled) return;
        finish();
        killGroup('SIGKILL');
        killedAfterGrace = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        failWith(null, null);
      }, KILL_GRACE_MS);
    };
    const onStop = (): void => {
      if (settled) return;
      finish();
      killGroup('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ stopped: true, stdout: text(out), stderr: text(errOut) });
    };
    // run-group-starter: lives only as long as this one command and reports no spend.
    const timer = setTimeout(() => { timedOut = true; endCommand(); }, limitMs);
    // run-group-starter: removed when the command ends (`finish`), and a stop reports no spend.
    signal?.addEventListener('abort', onStop, { once: true });

    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      if (overflowed || settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BUFFER_BYTES) {
        overflowed = true;
        endCommand();
        return;
      }
      chunks.push(chunk);
    };
    // run-group-starter: lives only as long as this one command and reports no spend.
    child.stdout?.on('data', collect(out));
    child.stderr?.on('data', collect(errOut));

    // run-group-starter: lives only as long as this one command and reports no spend.
    child.on('error', (err) => {
      if (settled) return;
      finish();
      // Mostly a working directory that is gone: Node names the shell, not the directory.
      reject(new ToolSoftFailure(`bash: the command could not start in ${getWorkspaceCwd()}: ${err.message}`, 'bash failed to start'));
    });
    // run-group-starter: lives only as long as this one command and reports no spend.
    child.on('close', (code, sig) => {
      if (settled) return;
      finish();
      if (code === 0 && !timedOut && !overflowed) {
        resolve(text(out) || '(no output)');
        return;
      }
      failWith(code, sig);
    });
  });
  if (typeof outcome === 'string') return outcome;
  throw stoppedFailure(outcome.stdout, outcome.stderr);
}
