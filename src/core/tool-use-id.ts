import { randomBytes } from 'node:crypto';

/**
 * A fresh `tool_use` block id: 9 alphanumerics.
 *
 * The narrowest shape reported for a target provider (Mistral is reported to
 * validate `^[a-zA-Z0-9]{9}$`). Ids land in PERSISTED threads, so a rejected id
 * fails not just one turn but every later turn in the thread. Random, not
 * derived from a position: positions repeat within a thread (history
 * truncation shrinks the array; block indexes restart every turn), and a
 * recorded call row joins its block by this id.
 */
export function newToolUseId(): string {
  return randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9).padEnd(9, '0');
}
