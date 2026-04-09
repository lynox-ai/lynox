import { sha256Short } from './utils.js';

/**
 * Compute a SHA-256 hash of a prompt string, truncated to 16 hex chars.
 */
export function hashPrompt(text: string): string {
  return sha256Short(text);
}
