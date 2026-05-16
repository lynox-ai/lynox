/**
 * Coerce tool-input args to match the declared JSON-Schema types.
 *
 * Some openai-compat providers (notably Llama 3.3 70B via OpenRouter/Inceptron)
 * emit typed arguments as strings — e.g. `{"rank": "1"}` when the schema says
 * `rank: { type: 'integer' }`. The downstream validator then rejects the call
 * (type mismatch) and the agent loops on retries, eventually exhausting its
 * iteration budget without producing a final answer.
 *
 * This coercer runs BEFORE `validateToolInput` and converts the obvious
 * string→typed-primitive cases per the schema. Conservative — never
 * fabricates values, never changes shape, never coerces objects/arrays.
 *
 *   integer → parseInt if string is digits only
 *   number  → parseFloat if string parses cleanly
 *   boolean → "true"/"false" → real booleans (case-insensitive)
 *
 * On any ambiguity the original value is left intact and the validator's
 * type-mismatch error fires as before — the agent then learns from the
 * structured error and retries.
 *
 * Recursive across nested objects + array items. Pure function — input
 * is never mutated; a new object/array is returned only when a coercion
 * actually fired.
 */
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

type SchemaNode = Record<string, unknown>;

export function coerceToolInput(
  schema: BetaTool['input_schema'],
  input: unknown,
): unknown {
  return coerceNode(schema as SchemaNode, input);
}

function coerceNode(schema: SchemaNode, value: unknown): unknown {
  const type = schema['type'];

  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const props = (schema['properties'] ?? {}) as Record<string, SchemaNode>;
    const src = value as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [key, raw] of Object.entries(src)) {
      const childSchema = props[key];
      if (!childSchema) continue; // unknown keys: leave as-is, validator will catch
      const coerced = coerceNode(childSchema, raw);
      if (coerced !== raw) {
        out ??= { ...src };
        out[key] = coerced;
      }
    }
    return out ?? value;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) return value;
    const itemSchema = schema['items'] as SchemaNode | undefined;
    if (!itemSchema) return value;
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const coerced = coerceNode(itemSchema, item);
      if (coerced !== item) {
        out ??= [...value];
        out[i] = coerced;
      }
    }
    return out ?? value;
  }

  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'string') return value;
    // `parseFloat`/`parseInt` would silently parse "1abc" as 1; we want
    // strict numeric strings. `Number(s)` returns NaN for any junk.
    const trimmed = value.trim();
    if (trimmed === '') return value;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return value;
    if (type === 'integer' && !Number.isInteger(n)) return value;
    return n;
  }

  if (type === 'boolean') {
    if (typeof value !== 'string') return value;
    const lower = value.toLowerCase().trim();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return value;
  }

  return value;
}
