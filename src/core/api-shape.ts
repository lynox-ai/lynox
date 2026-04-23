/**
 * API response shaping — deterministic, no LLM calls.
 *
 * Applies a `ResponseShape` (from the API profile) to a parsed JSON value
 * so the agent sees a compact, relevant projection instead of a full
 * verbose response. Typical target: DataForSEO responses with deeply
 * nested `tasks[].result[].items[].keyword_data.keyword_info.monthly_searches[]`.
 *
 * Errors never throw: callers get `{ shaped, error? }`. On error the
 * raw JSON is returned unchanged and the error is reported separately.
 */

import type { ResponseShape, ShapeReducer } from './api-store.js';

export interface ShapeResult {
  shaped: string;
  beforeChars: number;
  afterChars: number;
  /** Present only when shaping failed — callers fall back to `shaped` (raw). */
  error?: string;
}

/**
 * Apply a response shape to a parsed JSON value.
 *
 * `raw` MUST be a parsed JSON value (object/array/primitive), not a string.
 * Caller is responsible for JSON.parse (and for handling non-JSON responses
 * with passthrough).
 */
export function applyShape(raw: unknown, shape: ResponseShape): ShapeResult {
  const rawString = stringify(raw);
  const beforeChars = rawString.length;

  if (!shape.kind || shape.kind === 'passthrough') {
    return { shaped: rawString, beforeChars, afterChars: beforeChars };
  }

  try {
    let value: unknown = raw;

    // 1. Projection (include whitelist).
    if (shape.include && shape.include.length > 0) {
      value = project(raw, shape.include);
    }

    // 2. Reducers.
    if (shape.reduce) {
      for (const [path, reducer] of Object.entries(shape.reduce)) {
        value = reduceAt(value, parsePath(path), reducer, shape.max_array_items ?? 3);
      }
    }

    // 3. Array cap.
    if (typeof shape.max_array_items === 'number' && shape.max_array_items >= 0) {
      value = capArraysDeep(value, shape.max_array_items);
    }

    // 4. String cap.
    if (typeof shape.max_string_chars === 'number' && shape.max_string_chars >= 0) {
      value = capStringsDeep(value, shape.max_string_chars);
    }

    let shaped = stringify(value);

    // 5. Final stringified cap.
    if (typeof shape.max_chars === 'number' && shape.max_chars >= 0 && shaped.length > shape.max_chars) {
      shaped = shaped.slice(0, shape.max_chars) + `\n... [shape-capped at ${shape.max_chars} chars, original ${beforeChars}]`;
    }

    return { shaped, beforeChars, afterChars: shaped.length };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { shaped: rawString, beforeChars, afterChars: beforeChars, error: message };
  }
}

// ── Path parsing ──────────────────────────────────────────────────────────────

type PathSegment = { kind: 'field'; name: string } | { kind: 'array' };

/**
 * Parse a JSON path like `tasks[].result[].items[].keyword_data.keyword`.
 * `[]` = "every element of this array". Other bracket notations (e.g. `[0]`)
 * are not supported in v1 — shape is whitelist-style, not query-style.
 */
export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  for (const part of path.split('.')) {
    if (!part) continue;
    let name = part;
    while (name.endsWith('[]')) {
      name = name.slice(0, -2);
      if (name.length > 0) {
        segments.push({ kind: 'field', name });
        name = '';
      }
      segments.push({ kind: 'array' });
    }
    if (name.length > 0) {
      segments.push({ kind: 'field', name });
    }
  }
  return segments;
}

// ── Projection ────────────────────────────────────────────────────────────────

/**
 * Project an object/array tree to only include the given paths.
 * Paths ending in `[]` iterate. Missing paths are silently skipped.
 */
function project(raw: unknown, includes: string[]): unknown {
  const parsedPaths = includes.map(parsePath);
  return projectAt(raw, parsedPaths, 0);
}

function projectAt(value: unknown, paths: PathSegment[][], depth: number): unknown {
  // If any path has fully consumed its segments at this depth, the whitelist
  // "ends here" — keep the entire subtree verbatim.
  if (paths.some(p => p.length === depth)) {
    return value;
  }

  // Array traversal: any path expecting `[]` at this depth applies to every item.
  if (Array.isArray(value)) {
    const arrayPaths = paths.filter(p => p[depth]?.kind === 'array');
    if (arrayPaths.length === 0) return undefined;
    return value.map(item => projectAt(item, arrayPaths, depth + 1));
  }

  // Object field traversal: group remaining paths by the field they require.
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const groups = new Map<string, PathSegment[][]>();
    for (const path of paths) {
      const seg = path[depth];
      if (seg?.kind !== 'field') continue;
      if (!(seg.name in obj)) continue;
      const existing = groups.get(seg.name);
      if (existing) existing.push(path);
      else groups.set(seg.name, [path]);
    }
    const out: Record<string, unknown> = {};
    for (const [fieldName, group] of groups.entries()) {
      const projected = projectAt(obj[fieldName], group, depth + 1);
      if (projected !== undefined) {
        out[fieldName] = projected;
      }
    }
    return out;
  }

  // Primitive where a path expected deeper traversal: skip.
  return undefined;
}

// ── Reducers ──────────────────────────────────────────────────────────────────

function reduceAt(value: unknown, path: PathSegment[], reducer: ShapeReducer, firstN: number): unknown {
  if (path.length === 0) {
    return reduceArray(value, reducer, firstN);
  }
  const [head, ...rest] = path;
  if (!head) return value;

  if (head.kind === 'array') {
    if (!Array.isArray(value)) return value;
    return value.map(item => reduceAt(item, rest, reducer, firstN));
  }

  if (head.kind === 'field') {
    if (!value || typeof value !== 'object') return value;
    const obj = { ...(value as Record<string, unknown>) };
    if (head.name in obj) {
      obj[head.name] = reduceAt(obj[head.name], rest, reducer, firstN);
    }
    return obj;
  }

  return value;
}

function reduceArray(value: unknown, reducer: ShapeReducer, firstN: number): unknown {
  if (!Array.isArray(value)) return value;

  if (reducer === 'count') return value.length;
  if (reducer === 'first_n') return value.slice(0, firstN);
  if (reducer === 'last_n') return value.slice(-firstN);

  const numbers = extractNumbers(value);
  if (numbers.length === 0) return value;
  const count = numbers.length;
  const sum = numbers.reduce((a, b) => a + b, 0);
  const avg = Math.round((sum / count) * 100) / 100;
  const peak = Math.max(...numbers);

  if (reducer === 'avg') return { avg, count };
  if (reducer === 'peak') return { peak, count };
  if (reducer === 'avg+peak') return { avg, peak, count };

  return value;
}

function extractNumbers(arr: unknown[]): number[] {
  const out: number[] = [];
  for (const item of arr) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      out.push(item);
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      // Common DataForSEO / time-series shapes: {value: N}, {count: N}, {search_volume: N}
      for (const key of ['value', 'count', 'search_volume']) {
        if (typeof rec[key] === 'number' && Number.isFinite(rec[key])) {
          out.push(rec[key] as number);
          break;
        }
      }
    }
  }
  return out;
}

// ── Deep caps ─────────────────────────────────────────────────────────────────

function capArraysDeep(value: unknown, max: number): unknown {
  if (Array.isArray(value)) {
    const capped = value.slice(0, max).map(v => capArraysDeep(v, max));
    if (value.length > max) {
      capped.push(`[+${value.length - max} more truncated]` as unknown);
    }
    return capped;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = capArraysDeep(v, max);
    }
    return out;
  }
  return value;
}

function capStringsDeep(value: unknown, max: number): unknown {
  if (typeof value === 'string' && value.length > max) {
    return value.slice(0, max) + `…[+${value.length - max}ch]`;
  }
  if (Array.isArray(value)) {
    return value.map(v => capStringsDeep(v, max));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = capStringsDeep(v, max);
    }
    return out;
  }
  return value;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
