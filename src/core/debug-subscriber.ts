import { createWriteStream, chmodSync, type WriteStream } from 'node:fs';
import { channels } from './observability.js';

// Channel name → group mapping for NODYN_DEBUG filtering
const CHANNEL_GROUPS: Record<string, string> = {
  'nodyn:tool:start':              'tool',
  'nodyn:tool:end':                'tool',
  'nodyn:spawn:start':             'spawn',
  'nodyn:spawn:end':               'spawn',
  'nodyn:mode:change':             'mode',
  'nodyn:trigger:fire':            'trigger',
  'nodyn:cost:warning':            'cost',
  'nodyn:goal:update':             'goal',
  'nodyn:preapproval:match':       'preapproval',
  'nodyn:preapproval:exhausted':   'preapproval',
  'nodyn:preapproval:expired':     'preapproval',
  'nodyn:dag:notify':              'dag',

  'nodyn:memory:store':            'memory',
  'nodyn:memory:extraction':       'memory',
  'nodyn:content:truncation':      'tool',
  'nodyn:filewatcher:fallback':    'trigger',
  'nodyn:secret:access':           'secret',
};

// Env var patterns that must never appear in debug output
const SENSITIVE_ENV_KEYS = /API_KEY|SECRET|TOKEN|PASSWORD|VAULT_KEY/i;

/** Redact values that look like secrets (long alphanumeric, tokens, keys) */
function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (SENSITIVE_ENV_KEYS.test(key)) return '***';
  // Catch bare tokens: hex/base64 strings ≥ 20 chars
  if (/^[A-Za-z0-9+/=_-]{20,}$/.test(value)) return `${value.slice(0, 4)}…***`;
  return value;
}

/** Token patterns that must be masked in any debug output value. */
const TOKEN_VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /ya29\.[A-Za-z0-9_-]{10,}/g, replacement: 'ya29.***' },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, replacement: 'eyJ***' },
];

/** Mask known token patterns within a string value. */
export function maskTokenPatterns(text: string): string {
  let result = text;
  for (const { pattern, replacement } of TOKEN_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Safely format a channel message for debug output, redacting sensitive fields */
function formatMessage(channelName: string, msg: unknown): string {
  const ts = new Date().toISOString();
  const padded = channelName.padEnd(32);
  const data = msg as Record<string, unknown> | undefined;

  if (!data || typeof data !== 'object') {
    return `[${ts}] ${padded}  (no data)`;
  }

  // Channel-specific formatting
  switch (channelName) {
    case 'nodyn:tool:start':
      return `[${ts}] ${padded}  agent=${s(data['agent'])} tool=${s(data['name'])}`;

    case 'nodyn:tool:end': {
      const ok = data['success'] ? '✓' : '✗';
      const dur = typeof data['duration'] === 'number' ? `${Math.round(data['duration'] as number)}ms` : '?';
      const parts = [`agent=${s(data['agent'])}`, `tool=${s(data['name'])}`, `${dur}`, ok];
      if (!data['success'] && data['error']) parts.push(`error=${maskTokenPatterns(trunc(s(data['error']), 200))}`);
      if (data['input']) parts.push(`input=${trunc(s(data['input']), 120)}`);
      return `[${ts}] ${padded}  ${parts.join(' ')}`;
    }

    case 'nodyn:spawn:start':
      return `[${ts}] ${padded}  parent=${s(data['parent'])} agents=[${Array.isArray(data['agents']) ? (data['agents'] as string[]).join(',') : '?'}] depth=${s(data['depth'])}`;

    case 'nodyn:spawn:end': {
      const errors = data['errors'] as number | undefined;
      return `[${ts}] ${padded}  parent=${s(data['parent'])} agents=[${Array.isArray(data['agents']) ? (data['agents'] as string[]).join(',') : '?'}] errors=${errors ?? 0}`;
    }

    case 'nodyn:mode:change': {
      // Redact config — only show mode name, not full config with potential trigger URLs
      const config = data['config'] as Record<string, unknown> | undefined;
      const modeName = s(data['mode']);
      const extra = config?.['triggers'] ? ` triggers=${Array.isArray(config['triggers']) ? (config['triggers'] as unknown[]).length : '?'}` : '';
      return `[${ts}] ${padded}  mode=${modeName}${extra}`;
    }

    case 'nodyn:trigger:fire': {
      const event = data['event'] as Record<string, unknown> | undefined;
      return `[${ts}] ${padded}  source=${s(event?.['source'])} ts=${s(event?.['timestamp'])}`;
    }

    case 'nodyn:cost:warning':
      return `[${ts}] ${padded}  ${safeJson(data, 200)}`;

    case 'nodyn:goal:update': {
      const goal = data['goal'] as Record<string, unknown> | undefined;
      return `[${ts}] ${padded}  status=${s(goal?.['status'])} completed=${s(goal?.['completedCount'])}/${s(goal?.['totalCount'] ?? '?')} cost=$${s(goal?.['totalCost'])}`;
    }

    case 'nodyn:preapproval:match':
    case 'nodyn:preapproval:exhausted':
    case 'nodyn:preapproval:expired':
      return `[${ts}] ${padded}  tool=${s(data['toolName'])} set=${s(data['setId'])} pattern=${s(data['pattern'] ?? 'n/a')}`;

    case 'nodyn:dag:notify':
      return `[${ts}] ${padded}  manifest=${s(data['manifestName'])} step=${s(data['stepId'])} error=${trunc(s(data['error']), 200)}`;

    case 'nodyn:memory:store': {
      // Truncate content heavily — could contain user data
      const content = typeof data['content'] === 'string' ? trunc(data['content'] as string, 80) : '';
      return `[${ts}] ${padded}  ns=${s(data['namespace'])} scope=${s(data['scopeType'] ?? 'default')} ${content}`;
    }

    case 'nodyn:memory:extraction': {
      const status = s(data['status']);
      const extra = status === 'error' ? ` error=${trunc(s(data['error']), 200)}` : ` entries=${s(data['entries'])}`;
      return `[${ts}] ${padded}  status=${status}${extra}`;
    }

    case 'nodyn:content:truncation':
      return `[${ts}] ${padded}  source=${s(data['source'])} original=${s(data['originalLength'])} truncated=${s(data['truncatedTo'])}`;

    case 'nodyn:filewatcher:fallback':
      return `[${ts}] ${padded}  dir=${s(data['dir'])} reason=${trunc(s(data['reason']), 200)}`;

    case 'nodyn:secret:access':
      // Never log secret values — only name + action
      return `[${ts}] ${padded}  name=${s(data['name'])} action=${s(data['action'])}`;

    default:
      return `[${ts}] ${padded}  ${safeJson(data, 300)}`;
  }
}

function s(v: unknown): string {
  if (v === undefined || v === null) return '-';
  return String(v);
}

function trunc(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function safeJson(obj: Record<string, unknown>, max: number): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    cleaned[k] = redactValue(k, v);
  }
  const raw = JSON.stringify(cleaned);
  return maskTokenPatterns(trunc(raw, max));
}

type WriteFn = (line: string) => void;

let _initialized = false;
let _fileStream: WriteStream | null = null;

/**
 * Parse NODYN_DEBUG env var into a set of enabled groups.
 * - "1" or "true" or "*" → all groups
 * - "tool,spawn,dag" → specific groups only
 * - falsy → disabled
 */
export function parseDebugFilter(value: string | undefined): Set<string> | null {
  if (!value || value === '0' || value === 'false') return null;
  if (value === '1' || value === 'true' || value === '*') {
    return new Set(Object.values(CHANNEL_GROUPS));
  }
  const groups = new Set(value.split(',').map(g => g.trim().toLowerCase()).filter(Boolean));
  return groups.size > 0 ? groups : null;
}

/**
 * Initialize the debug subscriber.
 * Reads NODYN_DEBUG and NODYN_DEBUG_FILE from env.
 * Safe to call multiple times — only the first call has effect.
 *
 * @returns true if debug logging was activated
 */
export function initDebugSubscriber(): boolean {
  if (_initialized) return _fileStream !== null || process.env['NODYN_DEBUG'] !== undefined;
  _initialized = true;

  const filter = parseDebugFilter(process.env['NODYN_DEBUG']);
  if (!filter) return false;

  // Warn if running in a production-like environment
  if (process.env['NODE_ENV'] === 'production') {
    process.stderr.write('⚠ NODYN_DEBUG is set in production — debug output may contain sensitive data and impact performance. Disable after debugging.\n');
  }

  // Set up output writer
  const debugFile = process.env['NODYN_DEBUG_FILE'];
  let write: WriteFn;

  if (debugFile) {
    _fileStream = createWriteStream(debugFile, { flags: 'a', mode: 0o600 });
    try { chmodSync(debugFile, 0o600); } catch { /* best-effort for existing files */ }
    write = (line: string) => { _fileStream!.write(line + '\n'); };
    process.stderr.write(`[nodyn:debug] Logging to ${debugFile} (groups: ${[...filter].join(',')})\n`);
  } else {
    write = (line: string) => { process.stderr.write(line + '\n'); };
    process.stderr.write(`[nodyn:debug] Active (groups: ${[...filter].join(',')})\n`);
  }

  // Subscribe to all channels, filter by group
  for (const [key, ch] of Object.entries(channels)) {
    const channelName = String(ch.name);
    const group = CHANNEL_GROUPS[channelName];
    if (!group || !filter.has(group)) continue;

    ch.subscribe((msg: unknown) => {
      try {
        const line = formatMessage(channelName, msg);
        write(line);
      } catch {
        // Debug logging must never crash the process
      }
    });

    // Log subscription for transparency (only key name, not channel name — shorter)
    if (!debugFile) {
      write(`[nodyn:debug] ✓ subscribed: ${key}`);
    }
  }

  return true;
}

/**
 * Shut down debug subscriber (flush file stream).
 * Called during graceful shutdown.
 */
export function shutdownDebugSubscriber(): Promise<void> {
  if (!_fileStream) return Promise.resolve();
  return new Promise<void>((resolve) => {
    _fileStream!.end(() => {
      _fileStream = null;
      resolve();
    });
  });
}

// For testing: reset internal state
export function _resetDebugSubscriber(): void {
  _initialized = false;
  if (_fileStream) {
    _fileStream.end();
    _fileStream = null;
  }
}
