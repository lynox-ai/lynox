/**
 * Minimal cron expression parser — pure TypeScript, zero dependencies.
 *
 * Supports:
 * - 5-field standard cron: minute hour day-of-month month day-of-week
 * - Shorthand intervals: 30s, 5m, 1h, 6h, 1d
 * - Wildcards (*), ranges (1-5), lists (1,3,5), steps (* /5)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

interface ShorthandInterval {
  ms: number;
}

type ParsedExpression = CronFields | ShorthandInterval;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHORTHAND_RE = /^(\d+)\s*(s|m|h|d)$/i;

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day-of-month
  [1, 12],   // month
  [0, 6],    // day-of-week (0=Sun)
] as const;

/** Cap iteration at 366 days of minutes to prevent infinite loops. */
const MAX_MINUTES_SCAN = 366 * 24 * 60;

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

function expandField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2]!, 10);
      if (step <= 0) throw new Error(`Invalid step value: ${part}`);
      const base = stepMatch[1]!;
      let start = min;
      let end = max;
      if (base !== '*') {
        const range = parseRange(base, min, max);
        start = range[0];
        end = range[1];
      }
      for (let i = start; i <= end; i += step) {
        result.add(i);
      }
    } else if (part === '*') {
      for (let i = min; i <= max; i++) {
        result.add(i);
      }
    } else if (part.includes('-')) {
      const [s, e] = parseRange(part, min, max);
      for (let i = s; i <= e; i++) {
        result.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (Number.isNaN(n) || n < min || n > max) {
        throw new Error(`Value out of range [${String(min)}-${String(max)}]: ${part}`);
      }
      result.add(n);
    }
  }
  return result;
}

function parseRange(token: string, min: number, max: number): [number, number] {
  const parts = token.split('-');
  if (parts.length !== 2) throw new Error(`Invalid range: ${token}`);
  const start = parseInt(parts[0]!, 10);
  const end = parseInt(parts[1]!, 10);
  if (Number.isNaN(start) || Number.isNaN(end) || start < min || end > max || start > end) {
    throw new Error(`Invalid range [${String(min)}-${String(max)}]: ${token}`);
  }
  return [start, end];
}

// ---------------------------------------------------------------------------
// Expression parsing
// ---------------------------------------------------------------------------

function parse(expression: string): ParsedExpression {
  const trimmed = expression.trim();

  // Shorthand interval
  const shorthand = trimmed.match(SHORTHAND_RE);
  if (shorthand) {
    const value = parseInt(shorthand[1]!, 10);
    if (value <= 0) throw new Error(`Interval must be > 0: ${trimmed}`);
    const unit = shorthand[2]!.toLowerCase();
    const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return { ms: value * multipliers[unit]! };
  }

  // Standard 5-field cron
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected 5 fields, got ${String(parts.length)}: ${trimmed}`);

  const fieldNames: ReadonlyArray<keyof CronFields> = [
    'minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek',
  ];

  const fields: Partial<CronFields> = {};
  for (let i = 0; i < 5; i++) {
    const [min, max] = FIELD_RANGES[i]!;
    fields[fieldNames[i]!] = expandField(parts[i]!, min, max);
  }

  return fields as CronFields;
}

function isShorthand(parsed: ParsedExpression): parsed is ShorthandInterval {
  return 'ms' in parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate whether `expression` is a supported cron expression or shorthand interval.
 */
export function isValidCron(expression: string): boolean {
  try {
    parse(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next occurrence after `after` (defaults to now).
 *
 * - Shorthand intervals: adds the interval to `after`.
 * - Standard cron: iterates forward minute-by-minute (capped at 366 days).
 */
export function nextOccurrence(expression: string, after?: Date): Date {
  const parsed = parse(expression);

  const base = after ? new Date(after.getTime()) : new Date();

  if (isShorthand(parsed)) {
    return new Date(base.getTime() + parsed.ms);
  }

  // Start one minute after `base`, zeroing seconds/ms (all UTC)
  const candidate = new Date(base.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setTime(candidate.getTime() + 60_000);

  for (let i = 0; i < MAX_MINUTES_SCAN; i++) {
    const min = candidate.getUTCMinutes();
    const hr = candidate.getUTCHours();
    const dom = candidate.getUTCDate();
    const mon = candidate.getUTCMonth() + 1; // JS months are 0-based
    const dow = candidate.getUTCDay();        // 0=Sun

    if (
      parsed.minute.has(min) &&
      parsed.hour.has(hr) &&
      parsed.dayOfMonth.has(dom) &&
      parsed.month.has(mon) &&
      parsed.dayOfWeek.has(dow)
    ) {
      return candidate;
    }

    candidate.setTime(candidate.getTime() + 60_000);
  }

  throw new Error(`No matching occurrence within 366 days for: ${expression}`);
}
