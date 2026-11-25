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
import { createHash } from 'node:crypto';
import { isArtifactId, type ArtifactStore } from './artifact-store.js';

/** A field name of F: one top-level name, as a list's id field is. */
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Fields one rule may decide. */
export const JUDGE_MAX_FIELDS = 20;
/** The longest a judged text field may be, in characters. */
export const JUDGE_MAX_STRING = 2_000;
/** The longest a judged HTML field may be, in characters: a field the run's list form declares
 *  HTML (`htmlFieldsOfListForm`). Above the longest measured shop description (20,822, PRD
 *  shopify-preset §21.4 item 10), with room for an admin value longer than the storefront's and a
 *  rewrite that grows. */
export const JUDGE_MAX_HTML = 32_000;
/** The longest rule text. */
export const JUDGE_MAX_RULE_CHARS = 4_000;
/** The most a verdict's fields that are not HTML may take together in bytes, as {@link judgeAfterBound}
 *  counts them. The HTML fields are bounded together by {@link JUDGE_MAX_HTML} characters instead. */
export const JUDGE_MAX_AFTER_BYTES = 32 * 1024;
/** Bytes a number in a verdict may take as JSON: the longest a double prints is 25
 *  (`-0.0000012345678901234567`); rounded up. */
const NUMBER_BYTES = 32;
/** Names an object literal does not hold as its own field. */
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export interface JudgeRule {
  /** What the model is told to decide, per target. Never a target's words, but not always the
   *  owner's either: the agent may draft it from third-party data (keyword data for a shop's
   *  meta texts), and the owner approves it without having written it. Nothing in the schema can
   *  bar a string's content, so a field's value check carries that load (`seo-text.ts`). */
  rule: string;
  /** The verdict's shape over F, normalised by {@link normalizeJudgeRule}. */
  schema: ExtractSchema;
  /** The tier that places the judge's call: which provider serves it, and the gate and booking.
   *  The model is set per provider (`JUDGE_MODELS`), not by the tier. Default `fast`. */
  tier: ModelTier;
  /** The verdict's shape. `envelope`: `{ keep, after }`, where `keep: true` leaves the target as it
   *  is without the model repeating it. Absent: the flat verdict over F, as every rule planned
   *  before the envelope was stored; such a rule keeps its hash, and its run its checksum. */
  verdict?: 'envelope' | undefined;
  /** The context C (PRD shopify-preset §20.2 item 7): fields the judge reads beside the record
   *  and never writes — disjoint from F, never the id field, on a Shopify list only
   *  {@link SHOPIFY_CONTEXT_FIELDS}. Shown to the owner before the start. Absent when none is
   *  planned, never empty: a rule planned without C keeps its hash, and its run its checksum. */
  context?: string[] | undefined;
  /** Where the rule's text came from when the planner named a saved artifact instead of typing
   *  it ({@link judgeRuleFromArtifact}): the artifact, its version and the text's SHA-256 as read
   *  at planning. The text itself is `rule`, byte for byte. Absent for a typed rule, never
   *  `undefined`: a typed rule keeps its hash. */
  source?: JudgeRuleSource | undefined;
}

/** The saved text a rule was taken from: read once, at planning, and never again for the run. */
export interface JudgeRuleSource {
  artifact: string;
  version: number;
  sha256: string;
}

/** The artifact types whose content is text a rule can be: not a page, a diagram or a table. */
const RULE_ARTIFACT_TYPES: ReadonlySet<string> = new Set(['markdown', 'text']);

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The judge input with its rule read from a saved artifact, when the planner named one as
 * `judge.rule_artifact` instead of typing `judge.rule`; null when it typed the rule. The model
 * retypes a long rule on the way (it spelled out umlauts, dropped quoted examples, changed
 * quotes), and a rule the owner had approved word for word reached the run changed. Named, the
 * text is the artifact's content as stored, not one byte altered: no trim, no normalisation.
 *
 * The owner's only: an access (a mandate) lists and writes artifacts but does not read their
 * content, and a run's rule is shown to the owner and sent to a model. Under an access the rule
 * is typed, as before.
 */
export function judgeRuleFromArtifact(
  input: unknown,
  store: Pick<ArtifactStore, 'get'> | null,
  ownerPlans: boolean,
): { input: Record<string, unknown>; source: JudgeRuleSource } | null {
  if (!isPlainObject(input) || !Object.hasOwn(input, 'rule_artifact')) return null;
  const { rule_artifact: ref, ...rest } = input;
  if (rest['rule'] !== undefined) throw new BulkSourceError('Give judge.rule or judge.rule_artifact, not both.');
  if (!ownerPlans) {
    throw new BulkSourceError('judge.rule_artifact is for the owner: under an access, type the rule as judge.rule.');
  }
  if (!isArtifactId(ref)) throw new BulkSourceError('judge.rule_artifact must be the id of a saved artifact, as artifact_list shows it.');
  if (store === null) throw new BulkSourceError('Saved artifacts are not available on this instance: type the rule as judge.rule.');
  const artifact = store.get(ref);
  if (artifact === null) throw new BulkSourceError(`There is no saved artifact ${ref}.`);
  if (artifact.lostOnSave === true) throw new BulkSourceError(`Artifact ${ref} lost its document on a save: save the rule again, then plan with its id.`);
  if (!RULE_ARTIFACT_TYPES.has(artifact.type)) {
    throw new BulkSourceError(`Artifact ${ref} is of type ${artifact.type}; a rule is taken only from a markdown or text artifact.`);
  }
  // Named by the artifact, so the planner knows which text to fix: the same checks
  // `normalizeJudgeRule` applies to a typed rule, which would name judge.rule.
  if (artifact.content.trim() === '') throw new BulkSourceError(`Artifact ${ref} is empty; a rule needs text.`);
  refuseHidden(artifact.content, `Artifact ${ref}`);
  if (artifact.content.length > JUDGE_MAX_RULE_CHARS) {
    throw new BulkSourceError(
      `Artifact ${ref} has ${String(artifact.content.length)} characters; a rule may have at most ${String(JUDGE_MAX_RULE_CHARS)}. Save the rule alone as its own artifact and plan with that id.`,
    );
  }
  return {
    input: { ...rest, rule: artifact.content },
    source: { artifact: artifact.id, version: artifact.version, sha256: sha256Of(artifact.content) },
  };
}

/**
 * Why a run whose rule was taken from an artifact may not start: the artifact changed or is gone
 * since the run was planned; null when it holds the same text, or the rule was typed. The run
 * keeps the text it was planned with either way, so nothing switches to the newer version; but an
 * owner who edited the rule meant the edit, and starting on the old text would judge by a rule
 * they replaced.
 */
export function judgeRuleSourceChanged(rule: Pick<JudgeRule, 'source'>, store: Pick<ArtifactStore, 'get'> | null): string | null {
  if (rule.source === undefined) return null;
  if (store === null) return `Saved artifacts cannot be read on this instance right now, so this run's rule cannot be checked against artifact ${rule.source.artifact}. Try again later.`;
  const now = store.get(rule.source.artifact);
  if (now === null) return `The artifact this run's rule was taken from (${rule.source.artifact}) is gone or cannot be read. Plan the run again.`;
  if (sha256Of(now.content) !== rule.source.sha256) {
    // Someone with access to this instance may have changed it, not only the owner.
    return `The rule in artifact ${rule.source.artifact} changed since this run was planned (v${String(rule.source.version)}, now v${String(now.version)}); the change may not be yours. Read the artifact, then plan the run again to judge by its text.`;
  }
  return null;
}

/** The fields a Shopify product run may read as context C: the product's own texts and its
 *  type, vendor and tags, flat as {@link shopifyContextOf} projects them. */
export const SHOPIFY_CONTEXT_FIELDS: readonly string[] = Object.freeze([
  'title', 'descriptionHtml', 'seo_title', 'seo_description', 'productType', 'vendor', 'tags',
]);

/** The names a context may take on a list of this form, or undefined where the form does not
 *  bound them (a list that is not a store's: its elements' fields are the API's). A store form
 *  that takes no judge yet takes no context either. */
export function contextFieldsOfListForm(form: unknown): readonly string[] | undefined {
  // A filtered product list (`shopify_filtered`) reads its products with the same document.
  if (form === 'shopify' || form === 'shopify_filtered') return SHOPIFY_CONTEXT_FIELDS;
  if (form === 'shopify_media') return [];
  return undefined;
}

/** Targets with a verdict a write can use: not invalid (before the judge or by its answer), and
 *  not still waiting for one. The run's summary and `bulk_status` count the same way. */
export function judgedTargets(s: { total: number; changes: { invalid: number }; judge: { unjudged: number } | null }): number {
  return Math.max(0, s.total - s.changes.invalid - (s.judge?.unjudged ?? 0));
}

/** The fields F a rule decides, in the schema's order. */
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

function normalizeProperty(name: string, raw: unknown, maxString: number): ExtractSchemaProperty {
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
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > maxString) {
        throw new BulkSourceError(`judge.schema: text field ${name} needs maxLength (1–${String(maxString)}) or enum.`);
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
 * The context C a rule plans, or undefined for none: 0 to {@link JUDGE_MAX_FIELDS} top-level
 * names under F's name rule, no duplicates, none of F, not the id field, and where `allowed` is
 * given only its names. An empty list is no context, so it is left out of the rule.
 */
function normalizeContext(
  raw: unknown, fields: readonly string[], idField: string | undefined, allowed: readonly string[] | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > JUDGE_MAX_FIELDS) {
    throw new BulkSourceError(`judge.context must be a list of 0–${String(JUDGE_MAX_FIELDS)} field names.`);
  }
  const seen = new Set<string>();
  for (const name of raw) {
    if (typeof name !== 'string' || !FIELD_RE.test(name) || RESERVED_NAMES.has(name)) {
      throw new BulkSourceError('judge.context: a field name must be one top-level name (letters, digits, _), not __proto__, constructor or prototype.');
    }
    if (seen.has(name)) throw new BulkSourceError(`judge.context names ${name} twice.`);
    if (fields.includes(name)) {
      throw new BulkSourceError(`judge.context names ${name}, which judge.schema decides: a field is either read as context or decided, not both.`);
    }
    if (idField !== undefined && name === idField) {
      throw new BulkSourceError('judge.context must not name the id field: the run reads it already, as the target.');
    }
    if (allowed !== undefined && !allowed.includes(name)) {
      throw new BulkSourceError(`judge.context names ${name}, which this form does not read. It reads: ${allowed.join(', ')}.`);
    }
    seen.add(name);
  }
  return seen.size === 0 ? undefined : [...seen];
}

/**
 * Build the rule a run stores from what `bulk_plan` was given, or refuse it. `idField`: the
 * field a list identifies its elements by — a verdict never sets it, and the context never names
 * it. `contextFields`: the names a context may take where the source's form bounds them (a
 * Shopify list: {@link SHOPIFY_CONTEXT_FIELDS}); any name of F's rule without it. `htmlFields`:
 * the fields the run's list form declares HTML, which may ask for up to {@link JUDGE_MAX_HTML}
 * characters; every other text field up to {@link JUDGE_MAX_STRING}.
 */
export function normalizeJudgeRule(
  input: unknown,
  opts: { idField?: string | undefined; contextFields?: readonly string[] | undefined; htmlFields?: readonly string[] | undefined; source?: JudgeRuleSource | undefined } = {},
): JudgeRule {
  if (!isPlainObject(input)) throw new BulkSourceError('judge must be an object with rule and schema.');
  const rule = input['rule'];
  if (typeof rule !== 'string' || rule.trim() === '') {
    throw new BulkSourceError(`judge.rule must be a text of 1–${String(JUDGE_MAX_RULE_CHARS)} characters, or name a saved artifact as judge.rule_artifact.`);
  }
  if (rule.length > JUDGE_MAX_RULE_CHARS) {
    // The counted length, so the model shortens by a number instead of an estimate.
    throw new BulkSourceError(
      `judge.rule has ${String(rule.length)} characters; it may have at most ${String(JUDGE_MAX_RULE_CHARS)}. Shorten it by at least ${String(rule.length - JUDGE_MAX_RULE_CHARS)}.`,
    );
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
    properties[name] = normalizeProperty(name, rawProps[name], opts.htmlFields?.includes(name) === true ? JUDGE_MAX_HTML : JUDGE_MAX_STRING);
  }
  const schema: ExtractSchema = { type: 'object', properties, required: names, additionalProperties: false };
  // An HTML field is bounded by its own maxLength (JUDGE_MAX_HTML); the other fields together by
  // the byte bound, as before.
  const plain: ExtractSchema = { ...schema, properties: Object.fromEntries(Object.entries(properties).filter(([n]) => opts.htmlFields?.includes(n) !== true)) };
  // Every HTML field together: one call's output cap (JUDGE_HTML_OUTPUT_CAP) is measured for one
  // description of the longest length, not two (WooCommerce has two HTML fields).
  const html = Object.entries(properties).filter(([n]) => opts.htmlFields?.includes(n) === true)
    .reduce((sum, [, p]) => sum + (p.type !== 'string' ? 0 : p.enum ? Math.max(...p.enum.map((e) => [...e].length)) : p.maxLength ?? 0), 0);
  if (html > JUDGE_MAX_HTML) {
    throw new BulkSourceError(`judge.schema: the HTML fields together may ask for at most ${String(JUDGE_MAX_HTML)} characters; lower their maxLength values or shorten their choices.`);
  }
  if (judgeAfterBound(plain) > JUDGE_MAX_AFTER_BYTES) {
    throw new BulkSourceError('judge.schema allows a verdict larger than a bulk target may hold: lower the maxLength values.');
  }
  const tierRaw = input['tier'];
  const tier = tierRaw === undefined ? 'fast' : normalizeTier(typeof tierRaw === 'string' ? tierRaw : '');
  if (tier === undefined) throw new BulkSourceError('judge.tier must be fast, balanced or deep.');
  const context = normalizeContext(input['context'], names, opts.idField, opts.contextFields);
  // Left out, never `undefined`: `canonicalJson` writes an undefined key as null, and the rule's
  // hash would change for every rule planned without a context.
  // The source only as the caller read it (`judgeRuleFromArtifact`), never from the input: a
  // planner that wrote one itself would claim a text it typed came from a saved artifact.
  return { rule, schema, tier, verdict: 'envelope', ...(context !== undefined ? { context } : {}), ...(opts.source !== undefined ? { source: opts.source } : {}) };
}

/** The schema the judge's call is bound by: the rule's own over F, or around it the envelope
 *  `{ keep, after }`. `after` keeps F's `required` and `additionalProperties: false`, so a verdict
 *  that changes a target names every field of F and no other; only `keep` is required, because
 *  a kept target needs no `after` (a missing one on `keep: false` is refused after the call). */
export function judgeCallSchema(rule: Pick<JudgeRule, 'schema' | 'verdict'>): ExtractSchema {
  if (rule.verdict !== 'envelope') return rule.schema;
  return {
    type: 'object',
    properties: {
      keep: { type: 'boolean' },
      after: { type: 'object', properties: rule.schema.properties, required: rule.schema.required ?? [], additionalProperties: false },
    },
    required: ['keep'],
    additionalProperties: false,
  };
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
      case 'object':
        bytes += judgeAfterBound(prop as unknown as ExtractSchema);
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
 * 8000, or {@link JUDGE_HTML_OUTPUT_CAP} for a schema with a text field longer than
 * {@link JUDGE_MAX_STRING}, which only an HTML field may be. A reply cut off anyway is refused (`refuseCutOff`), never recorded: the bound decides
 * how useful a large schema is, not whether a verdict is whole. A judge model that thinks before
 * it answers gets room on top (`judgeOutputBudget`); the call and the run's worst-case cost check
 * count that budget.
 */
export function judgeMaxOutputTokens(schema: ExtractSchema): number {
  return Math.min(judgeOutputCap(schema), Math.max(256, judgeAfterBound(schema) + 128));
}

/** The output cap of a verdict call: {@link JUDGE_HTML_OUTPUT_CAP} for a schema with a text field
 *  longer than {@link JUDGE_MAX_STRING} — only an HTML field may be (`normalizeJudgeRule`) — and
 *  8,000 otherwise (PRD shopify-preset §21.4 item 10). */
function judgeOutputCap(schema: ExtractSchema): number {
  const long = Object.values(schema.properties).some((p) => p.type === 'string' && (p.maxLength ?? 0) > JUDGE_MAX_STRING
    || p.type === 'object' && judgeOutputCap(p as unknown as ExtractSchema) === JUDGE_HTML_OUTPUT_CAP);
  return long ? JUDGE_HTML_OUTPUT_CAP : 8_000;
}

/** Output tokens a verdict call with an HTML field may take. */
export const JUDGE_HTML_OUTPUT_CAP = 16_000;
