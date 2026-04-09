import { execSync } from 'node:child_process';
import type { ToolEntry } from '../../types/index.js';
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

// === Isolation env overrides ===

let _isolationEnvOverride: Record<string, string> | undefined;
let _isolationMinimalEnv = false;

export function setIsolationEnv(envVars: Record<string, string> | undefined, minimal: boolean): void {
  _isolationEnvOverride = envVars;
  _isolationMinimalEnv = minimal;
}

export function clearIsolationEnv(): void {
  _isolationEnvOverride = undefined;
  _isolationMinimalEnv = false;
}

export function buildSafeEnv(): NodeJS.ProcessEnv {
  // Air-gapped: minimal env
  if (_isolationMinimalEnv) {
    const minEnv: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR']) {
      if (process.env[key] !== undefined) {
        minEnv[key] = process.env[key];
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

  // Merge isolation env vars
  if (_isolationEnvOverride) {
    for (const [key, value] of Object.entries(_isolationEnvOverride)) {
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
  handler: async (input: BashInput): Promise<string> => {
    const safeEnv = buildSafeEnv();

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
