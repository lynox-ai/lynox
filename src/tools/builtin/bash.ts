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
  'GIT_', 'SSH_AUTH_SOCK',
  'DISPLAY', 'XDG_',
  'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL',
  'COLORTERM', 'FORCE_COLOR', 'NO_COLOR',
  'LYNOX_WORKSPACE',
  'CI', 'GITHUB_',
  'DOCKER_', 'COMPOSE_',
];

/**
 * Build the env that subprocesses inherit.
 *
 * Isolation source of truth is the calling agent's `isolation` config:
 *  - `air-gapped` collapses to PATH/HOME/TMPDIR only — no secrets, no Bedrock
 *    credentials, no Telegram token, nothing the parent process holds.
 *  - `envVars` (any level) is merged on top of the allow-listed env, letting
 *    `spawn_agent` inject the deliberately-scoped variables it wants the child
 *    bash invocation to see.
 *
 * Pre-isolation behaviour (no agent, or `isolation` unset) is the previous
 * allow-listed env minus NODE_OPTIONS / NODE_EXTRA_CA_CERTS.
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
    if (ENV_SAFE_PREFIXES.some(p => key === p || key.startsWith(p))) {
      safeEnv[key] = value;
    }
  }

  // Remove dangerous NODE_ vars that could be exploited for code injection
  delete safeEnv.NODE_OPTIONS;
  delete safeEnv.NODE_EXTRA_CA_CERTS;

  // Per-spawn env overrides for scoped/sandboxed levels.
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
