/**
 * The rule a bulk run's judge applies (PRD bulk-loop §3.1, `bulk_judge`): a text, an output
 * schema over the fields F the run writes, and the model tier. Planned by `bulk_plan`, stored
 * encrypted with the run, shown to the owner before the start and bound by its hash into the
 * start and the approval.
 *
 * The schema is the only thing that bounds what a verdict can hold, and only as far as the plan
 * enforces it (PRD bulk-loop §3.1): `validateAgainstSchema` refuses unknown fields only under
 * `additionalProperties: false`, `required` is optional, and a `pattern` runs as a regex over
 * model output — before the length check, so `maxLength` does not bound it. So the plan does not
 * take a schema as given; it builds one from what it was given and refuses what it cannot bound:
 * scalars only, every string with `maxLength` or `enum`, no `pattern`, every field required,
 * nothing else allowed.
 */
import { BulkSourceError } from './bulk-plan.js';
import type { ExtractSchema, ExtractSchemaProperty } from './llm-helper.js';
import { normalizeTier, type ModelTier } from '../types/index.js';
import { hiddenCharAt } from './hidden-chars.js';

/** A field name of F: one top-level name, as a list's id field is. */
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Fields one rule may decide. */
export const JUDGE_MAX_FIELDS = 20;
/** The longest a judged text field may be, in characters. */
export const JUDGE_MAX_STRING = 2_000;
/** The longest rule text. */
export const JUDGE_MAX_RULE_CHARS = 4_000;
/** The most a verdict may take in bytes, as {@link judgeAfterBound} counts it. */
export const JUDGE_MAX_AFTER_BYTES = 32 * 1024;
/** Bytes a number in a verdict may take as JSON: the longest a double prints is 25
 *  (`-0.0000012345678901234567`); rounded up. */
const NUMBER_BYTES = 32;
/** Names an object literal does not hold as its own field. */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export interface JudgeRule {
  /** What the model is told to decide, per target. The owner's words, never a target's. */
  rule: string;
  /** The verdict's shape over F, normalised by {@link normalizeJudgeRule}. */
  schema: ExtractSchema;
  /** The tier that places the judge's call: which provider serves it, and the gate and booking.
   *  The model is set per provider (`JUDGE_MODELS`), not by the tier. Default `fast`. */
  tier: ModelTier;
}

/** The fields F a rule decides, in the schema's order. */
/** Targets with a verdict a write can use: not invalid (before the judge or by its answer), and
 *  not still waiting for one. The run's summary and `bulk_status` count the same way. */
export function judgedTargets(s: { total: number; changes: { invalid: number }; judge: { unjudged: number } | null }): number {
  return Math.max(0, s.total - s.changes.invalid - (s.judge?.unjudged ?? 0));
}

export function judgeFields(rule: Pick<JudgeRule, 'schema'>): string[] {
  return Object.keys(rule.schema.properties);
}

/** What a target is planned with before its verdict: every field of F, null. Its keys are F,
 *  so reading a target's before-image over it reads exactly F. */
export function judgeTemplate(rule: Pick<JudgeRule, 'schema'>): Record<string, null> {
  return Object.fromEntries(judgeFields(rule).map((f) => [f, null]));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteOrUndefined(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BulkSourceError(`judge.schema: ${what} must be a number.`);
  return v;
}

/**
 * Refuse a text the owner confirms and the judge reads if it carries a character the owner does
 * not see (`hiddenCharAt`): the model would follow what the page shows only as a marking. The
 * message names the rule, not the character, and where the text holds it, in characters. An enum
 * value is a choice, not running text, so it takes no hidden character in any place (`inPlace`).
 */
function refuseHidden(text: string, what: string, opts: { inPlace?: boolean } = {}): void {
  const at = hiddenCharAt(text, opts);
  if (at === -1) return;
  throw new BulkSourceError(
    `${what} holds a character a reader does not see (an invisible format, direction or control character, `
    + `or a joiner or variation selector outside the emoji or word it belongs to) at character ${String(at + 1)}. `
    + 'The owner confirms this text as shown, so it must be plain text: newline, carriage return and tab are fine.',
  );
}

function normalizeProperty(name: string, raw: unknown): ExtractSchemaProperty {
  if (!isPlainObject(raw)) throw new BulkSourceError(`judge.schema: field ${name} must be an object with a type.`);
  if (Object.hasOwn(raw, 'pattern')) {
    // A regex the planner writes runs over output the target's text steers, before any length
    // check: catastrophic backtracking blocks the event loop, and with it the run's lease.
    throw new BulkSourceError(`judge.schema: field ${name} uses pattern, which a judged run does not take. Use enum or maxLength.`);
  }
  switch (raw['type']) {
    case 'string': {
      const enumValues = raw['enum'];
      if (enumValues !== undefined) {
        if (!Array.isArray(enumValues) || enumValues.length === 0 || enumValues.length > 100
          || !enumValues.every((e) => typeof e === 'string' && e.length > 0 && e.length <= 200)) {
          throw new BulkSourceError(`judge.schema: field ${name}: enum must be 1–100 texts of up to 200 characters.`);
        }
        (enumValues as string[]).forEach((e, i) => { refuseHidden(e, `judge.schema: field ${name}: enum value ${String(i + 1)}`, { inPlace: false }); });
        return { type: 'string', enum: [...new Set(enumValues as string[])] };
      }
      const max = raw['maxLength'];
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > JUDGE_MAX_STRING) {
        throw new BulkSourceError(`judge.schema: text field ${name} needs maxLength (1–${String(JUDGE_MAX_STRING)}) or enum.`);
      }
      const min = raw['minLength'];
      if (min !== undefined && (typeof min !== 'number' || !Number.isInteger(min) || min < 0 || min > max)) {
        throw new BulkSourceError(`judge.schema: field ${name}: minLength must be a whole number up to maxLength.`);
      }
      return { type: 'string', maxLength: max, ...(min !== undefined ? { minLength: min } : {}) };
    }
    case 'number':
    case 'integer': {
      const minimum = finiteOrUndefined(raw['minimum'], `field ${name}: minimum`);
      const maximum = finiteOrUndefined(raw['maximum'], `field ${name}: maximum`);
      return { type: raw['type'], ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) };
    }
    case 'boolean':
      return { type: 'boolean' };
    default:
      // A list or an object is not a field a bulk target holds: the external path writes
      // scalars only, and a data-store column holds one value.
      throw new BulkSourceError(`judge.schema: field ${name} must be text, a number, an integer or true/false.`);
  }
}

/**
 * Build the rule a run stores from what `bulk_plan` was given, or refuse it. `idField`: the
 * field a list identifies its elements by — a verdict never sets it.
 */
export function normalizeJudgeRule(input: unknown, opts: { idField?: string | undefined } = {}): JudgeRule {
  if (!isPlainObject(input)) throw new BulkSourceError('judge must be an object with rule and schema.');
  const rule = input['rule'];
  if (typeof rule !== 'string' || rule.trim() === '' || rule.length > JUDGE_MAX_RULE_CHARS) {
    throw new BulkSourceError(`judge.rule must be a text of 1–${String(JUDGE_MAX_RULE_CHARS)} characters.`);
  }
  refuseHidden(rule, 'judge.rule');
  const rawSchema = input['schema'];
  if (!isPlainObject(rawSchema)) throw new BulkSourceError('judge.schema must be an object.');
  // Either the properties themselves or a JSON-schema object around them.
  const rawProps = isPlainObject(rawSchema['properties']) ? rawSchema['properties'] : rawSchema;
  const names = Object.keys(rawProps);
  if (names.length === 0 || names.length > JUDGE_MAX_FIELDS) {
    throw new BulkSourceError(`judge.schema must name 1–${String(JUDGE_MAX_FIELDS)} fields.`);
  }
  const properties: Record<string, ExtractSchemaProperty> = {};
  for (const name of names) {
    if (!FIELD_RE.test(name) || RESERVED_NAMES.has(name)) {
      throw new BulkSourceError('judge.schema: a field name must be one top-level name (letters, digits, _), not __proto__, constructor or prototype.');
    }
    if (opts.idField !== undefined && name === opts.idField) {
      throw new BulkSourceError('judge.schema must not decide the id field: the run could not check it reads back the target it listed.');
    }
    properties[name] = normalizeProperty(name, rawProps[name]);
  }
  const schema: ExtractSchema = { type: 'object', properties, required: names, additionalProperties: false };
  if (judgeAfterBound(schema) > JUDGE_MAX_AFTER_BYTES) {
    throw new BulkSourceError('judge.schema allows a verdict larger than a bulk target may hold: lower the maxLength values.');
  }
  const tierRaw = input['tier'];
  const tier = tierRaw === undefined ? 'fast' : normalizeTier(typeof tierRaw === 'string' ? tierRaw : '');
  if (tier === undefined) throw new BulkSourceError('judge.tier must be fast, balanced or deep.');
  return { rule, schema, tier };
}

/**
 * The most bytes a verdict under `schema` can take as JSON — an upper bound, not a count of
 * characters (PRD bulk-loop §3.1): a character takes up to 4 bytes in UTF-8 and up to 6 as a
 * JSON escape, and the keys, quotes, colons and commas count. A run's byte cap is checked against
 * this before any call is paid, so it cannot fail on a verdict afterwards.
 */
export function judgeAfterBound(schema: ExtractSchema): number {
  let bytes = 2; // {}
  for (const [name, prop] of Object.entries(schema.properties)) {
    bytes += Buffer.byteLength(JSON.stringify(name), 'utf8') + 2; // "name": and a comma
    switch (prop.type) {
      case 'string':
        bytes += 2 + (prop.enum
          ? Math.max(...prop.enum.map((e) => Buffer.byteLength(JSON.stringify(e), 'utf8') - 2))
          : 6 * (prop.maxLength ?? JUDGE_MAX_STRING));
        break;
      case 'boolean':
        bytes += 5;
        break;
      default:
        bytes += NUMBER_BYTES;
    }
  }
  return bytes;
}

/**
 * Output tokens a verdict call may take: the verdict's byte bound plus room for the tool call
 * around it — a token is at least one byte, so this is never too few below the cap — and at most
 * 8000. A reply cut off anyway is refused (`refuseCutOff`), never recorded: the bound decides
 * how useful a large schema is, not whether a verdict is whole. A judge model that thinks before
 * it answers gets room on top (`judgeOutputBudget`); the call and the run's worst-case cost check
 * count that budget.
 */
export function judgeMaxOutputTokens(schema: ExtractSchema): number {
  return Math.min(8_000, Math.max(256, judgeAfterBound(schema) + 128));
}
