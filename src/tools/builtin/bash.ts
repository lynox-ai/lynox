import { execSync } from 'node:child_process';
import type { ToolEntry, IAgent } from '../../types/index.js';
import type { IsolationConfig } from '../../types/security.js';
import { getWorkspaceCwd } from '../../core/workspace.js';
import { MAX_BUFFER_BYTES, DEFAULT_BASH_TIMEOUT_MS } from '../../core/constants.js';

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

// NOTE: This tool intentionally uses execSync with shell execution.
// It is a bash tool for an autonomous agent — shell features are required by design.
// Input comes from the LLM agent, not from untrusted external users.

export const bashTool: ToolEntry<BashInput> = {
  definition: {
    name: 'bash',
    description: 'Execute a shell command for system operations, package management, git, or process control. NEVER use for file reads/writes (use read_file/write_file) or web searches (use web_research).',
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
  // NOTE: execSync is intentional — this is a bash tool requiring shell features.
  // Input comes from the LLM agent, not untrusted external users.
  handler: async (input: BashInput, agent: IAgent): Promise<string> => {
    const safeEnv = buildSafeEnv(agent.isolation);

    try {
      const output = execSync(input.command, {
        timeout: input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: getWorkspaceCwd(),
        env: safeEnv,
      });
      return output || '(no output)';
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'stderr' in err && 'stdout' in err) {
        const stderr = String((err as { stderr: unknown }).stderr);
        const stdout = String((err as { stdout: unknown }).stdout || '');
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        return combined || `Command failed: ${input.command}`;
      }
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new Error(`bash: ${cause.message}`, { cause });
    }
  },
};
