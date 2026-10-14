/**
 * Shared setup for online tests (real LLM API calls).
 *
 * API key loaded from ~/.lynox/config.json (same as lynox CLI).
 * Uses Haiku by default (~$0.001 per call).
 */
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { readOperatorConfig, reportMissingKey } from '../../scripts/test-run-home.js';
import { tmpdir } from 'node:os';

export const HAIKU = 'claude-haiku-4-5-20251001';

// `anthropic_api_key` is the name the eval and bench scripts read, and the one a developer config
// may carry instead of `api_key`, the schema field. Same order as
// tests/eval/knowledge-substrate-provider.ts.
const CONFIG_FIELDS = ['anthropic_api_key', 'api_key'] as const;

/**
 * Load API key from env or the developer's own lynox config. The suite points `HOME` at a
 * directory of its own, so the config is read from the home the run started with
 * (`operatorHome()`), read only.
 */
export function getApiKey(): string {
  if (process.env['ANTHROPIC_API_KEY']) return process.env['ANTHROPIC_API_KEY'];

  const { config } = readOperatorConfig();
  if (config !== null) {
    for (const field of CONFIG_FIELDS) {
      const value = config[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }

  throw new Error(
    'No API key found. Set ANTHROPIC_API_KEY env var or configure ~/.lynox/config.json',
  );
}

let missingKeyReported = false;

/** Check if API key is available (for test skipping). Says so out loud when it is not. */
export function hasApiKey(): boolean {
  try {
    getApiKey();
    return true;
  } catch {
    if (!missingKeyReported) {
      missingKeyReported = true;
      reportMissingKey('online tests', ['ANTHROPIC_API_KEY'], CONFIG_FIELDS);
    }
    return false;
  }
}

/** Create a temp dir for test isolation. Returns path + cleanup fn. */
export function createTmpDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'lynox-online-'));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
