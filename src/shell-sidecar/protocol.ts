/**
 * Wire protocol between the engine's bash client and the shell sidecar's exec daemon
 * (PRD 152 v2 §4.1, W1).
 *
 * One request per connection: the client writes ONE JSON line, the daemon answers with
 * JSON lines `{t:'out'|'err', d}` and ends with exactly one `{t:'exit', …}`. Both sides
 * treat the other's bytes as untrusted: the daemon because a request decides what runs,
 * the client because a pool uid writes the output and the sidecar is the side the engine
 * does not trust (PRD §4.1, "the engine trusts nothing the sidecar can write").
 *
 * There is no `cwd` field, on purpose (W1 plan, refute S1): a cwd checked by realpath is
 * not a boundary — the shell can `cd` anywhere — and libuv changes directory before it
 * drops to the call's uid, so a symlink a previous call left in the workspace would be
 * followed as root. Every call starts in the workspace root, as its pool uid.
 */

import { DEFAULT_BASH_TIMEOUT_MS } from '../core/constants.js';

/** The ceiling on a call's runtime. Today `timeout_ms: 0` means "no limit" (PRD P2). */
export const MAX_EXEC_TIMEOUT_MS = 15 * 60_000;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_CMD_BYTES = 256 * 1024;
export const MAX_ENV_ENTRIES = 256;
export const MAX_ENV_VALUE_BYTES = 32 * 1024;
/** One response line, including its JSON frame. The daemon chunks output below this. */
export const MAX_RESPONSE_LINE_BYTES = 128 * 1024;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ExecRequest {
  cmd: string;
  timeoutMs: number;
  env: Record<string, string>;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The effective timeout for a requested one: unset, non-finite or not positive → the
 * default; above the ceiling → the ceiling. Both sides apply it, so neither trusts the other.
 */
export function capTimeout(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_BASH_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requested), MAX_EXEC_TIMEOUT_MS);
}

/** Parse the one request line a connection carries. Unknown fields are refused, not ignored. */
export function parseRequest(line: string): ParseResult<ExecRequest> {
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) return { ok: false, error: 'request too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: 'request is not JSON' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'request is not an object' };
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'cmd' && key !== 'timeoutMs' && key !== 'env') return { ok: false, error: `unknown field ${JSON.stringify(key)}` };
  }
  const cmd = obj['cmd'];
  if (typeof cmd !== 'string' || cmd.length === 0) return { ok: false, error: 'cmd must be a non-empty string' };
  if (Buffer.byteLength(cmd, 'utf8') > MAX_CMD_BYTES) return { ok: false, error: 'cmd too large' };
  if (cmd.includes('\0')) return { ok: false, error: 'cmd contains a NUL byte' };
  const envRaw = obj['env'] ?? {};
  if (envRaw === null || typeof envRaw !== 'object' || Array.isArray(envRaw)) return { ok: false, error: 'env must be an object' };
  const entries = Object.entries(envRaw as Record<string, unknown>);
  if (entries.length > MAX_ENV_ENTRIES) return { ok: false, error: 'too many env entries' };
  const env: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) return { ok: false, error: `bad env name ${JSON.stringify(name)}` };
    if (typeof value !== 'string') return { ok: false, error: `env ${name} must be a string` };
    if (value.includes('\0')) return { ok: false, error: `env ${name} contains a NUL byte` };
    if (Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_BYTES) return { ok: false, error: `env ${name} too large` };
    env[name] = value;
  }
  return { ok: true, value: { cmd, timeoutMs: capTimeout(obj['timeoutMs']), env } };
}

export type ExecFrame =
  | { t: 'out'; d: string }
  | { t: 'err'; d: string }
  | { t: 'exit'; code: number | null; signal: string | null; timedOut: boolean; error?: string };

/**
 * Parse one response line on the client side. Only the three frame shapes pass; anything
 * else — a missing field, an extra field, a wrong type, an oversize line — is an error,
 * never passed through as output.
 */
export function parseFrame(line: string): ParseResult<ExecFrame> {
  if (Buffer.byteLength(line, 'utf8') > MAX_RESPONSE_LINE_BYTES) return { ok: false, error: 'response line too large' };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: 'response line is not JSON' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'response line is not an object' };
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join(',');
  if (obj['t'] === 'out' || obj['t'] === 'err') {
    if (keys !== 'd,t' || typeof obj['d'] !== 'string') return { ok: false, error: 'bad output frame' };
    return { ok: true, value: { t: obj['t'], d: obj['d'] } };
  }
  if (obj['t'] === 'exit') {
    const allowed = new Set(['t', 'code', 'signal', 'timedOut', 'error']);
    for (const k of Object.keys(obj)) if (!allowed.has(k)) return { ok: false, error: 'bad exit frame' };
    const code = obj['code'];
    const signal = obj['signal'];
    const timedOut = obj['timedOut'];
    const error = obj['error'];
    if (!(code === null || (typeof code === 'number' && Number.isInteger(code)))) return { ok: false, error: 'bad exit code' };
    if (!(signal === null || typeof signal === 'string')) return { ok: false, error: 'bad exit signal' };
    if (typeof timedOut !== 'boolean') return { ok: false, error: 'bad exit timedOut' };
    if (error !== undefined && typeof error !== 'string') return { ok: false, error: 'bad exit error' };
    const frame: ExecFrame = error === undefined
      ? { t: 'exit', code, signal, timedOut }
      : { t: 'exit', code, signal, timedOut, error };
    return { ok: true, value: frame };
  }
  return { ok: false, error: 'unknown frame type' };
}

/** Encode one frame as a line. Output text is split by the caller below the line limit. */
export function encodeFrame(frame: ExecFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
