/**
 * Shared setup for online tests (real LLM API calls).
 *
 * API key loaded from ~/.lynox/config.json (same as lynox CLI).
 * Uses Haiku by default (~$0.001 per call).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const HAIKU = 'claude-haiku-4-5-20251001';

/** Load API key from lynox config or env. */
export function getApiKey(): string {
  if (process.env['ANTHROPIC_API_KEY']) return process.env['ANTHROPIC_API_KEY'];

  try {
    const configPath = join(homedir(), '.lynox', 'config.json');
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config['api_key'] === 'string' && config['api_key'].length > 0) {
      return config['api_key'];
    }
  } catch { /* config not found */ }

  throw new Error(
    'No API key found. Set ANTHROPIC_API_KEY env var or configure ~/.lynox/config.json',
  );
}

/** Check if API key is available (for test skipping). */
export function hasApiKey(): boolean {
  try {
    getApiKey();
    return true;
  } catch {
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
