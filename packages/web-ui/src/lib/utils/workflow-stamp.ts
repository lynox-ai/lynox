/**
 * The owner's stamp of a workflow that waits for it — one a mandate built or changed, or the owner's
 * own whose steps changed since the last stamp (register 242 (c), contract r3): what the library
 * shows, and what the answers of the two stamp routes mean.
 *
 * `GET /api/workflows/:id/stamp-preview` says what would run and returns the digest of exactly
 * that (`expect`). `POST /api/workflows/:id/confirm` takes the digest back and stamps only if the
 * workflow is still what was shown. A refusal is read by its `code`, never by its message: the
 * view words each code itself.
 *
 * A module and not inline in the view for the reason `run-notice.ts` records: a Svelte component
 * cannot be imported in vitest here, so every decision the view takes has to be drivable from a
 * test, not witnessed by a regex over the component's text.
 */

export interface StampStep {
  id: string;
  task: string;
  /** A recorded step's literal call; `inputTemplate` keeps its `{{params.x}}` placeholders. */
  tool: string | null;
  inputTemplate: unknown;
  /** The effective tool set, not only what the definition names. */
  tools: string[];
  model: string | null;
  inputFrom: string[];
  /** A role can change the step's tools and model at run time, so it is shown by name. */
  role: string | null;
  effort: StampEffort | null;
  thinking: StampThinking | null;
  timeoutMs: number | null;
  /** What the role grants. Which tools a step finally uses is worked out at run time from this
   *  and the step's own `tools` (read-only surface first, then allow, then deny). */
  roleGrant: StampRoleGrant | null;
}

export interface StampRoleGrant {
  model: string | null;
  effort: StampEffort | null;
  allowTools: string[] | null;
  denyTools: string[] | null;
  readOnly: boolean;
}

export const STAMP_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type StampEffort = (typeof STAMP_EFFORTS)[number];
export const STAMP_THINKING = ['enabled', 'adaptive', 'disabled'] as const;
export type StampThinking = (typeof STAMP_THINKING)[number];

export interface StampParameter {
  name: string;
  required: boolean;
  default: unknown;
}

export interface StampPreview {
  expect: string;
  stampedAt: string | null;
  changedBy: 'mandate' | 'owner' | null;
  awaitsStamp: boolean;
  mode: string | null;
  parameters: StampParameter[];
  onFailure: string | null;
  limits: unknown;
  /** The contract tuples, one line per (method, URL), or null without a contract. */
  contract: string[] | null;
  steps: StampStep[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Marks a value that is present but not of its type, so the whole preview is refused. */
const BAD = Symbol('bad');
/** Absent or null is "none"; a string is itself; anything else is BAD. */
const optStr = (v: unknown): string | null | typeof BAD => (v === undefined || v === null ? null : typeof v === 'string' ? v : BAD);
/** Absent or null is none; one of `values` is itself; anything else is BAD. */
const optOneOf = <T extends string>(v: unknown, values: readonly T[]): T | null | typeof BAD =>
  v === undefined || v === null ? null : typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : BAD;
/** Absent or null is none; a finite, non-negative number is itself; anything else is BAD. */
const optMs = (v: unknown): number | null | typeof BAD =>
  v === undefined || v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : BAD;
/** Absent or null is none; a grant read whole is itself; anything else is BAD. */
const optGrant = (v: unknown): StampRoleGrant | null | typeof BAD => {
  if (v === undefined || v === null) return null;
  if (!isRecord(v) || typeof v['readOnly'] !== 'boolean') return BAD;
  const model = optStr(v['model']);
  const effort = optOneOf(v['effort'], STAMP_EFFORTS);
  const allow = v['allowTools'] === null || v['allowTools'] === undefined ? null : optStrings(v['allowTools']);
  const deny = v['denyTools'] === null || v['denyTools'] === undefined ? null : optStrings(v['denyTools']);
  if (model === BAD || effort === BAD || allow === BAD || deny === BAD) return BAD;
  return { model, effort, allowTools: allow, denyTools: deny, readOnly: v['readOnly'] };
};
/** Absent or null is the empty list; an array of strings is itself; anything else, or any non-string entry, is BAD. */
const optStrings = (v: unknown): string[] | typeof BAD => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return BAD;
  return v as string[];
};

/**
 * The preview as the view may show it, or null for an answer that is not one.
 *
 * ⚠ Null on anything it cannot read whole, and null means "offer no stamp": a stamp sent with a
 * digest over a list the view did not render would confirm steps the owner was not shown. So a step
 * it cannot read makes the whole preview unreadable — dropping it would hide exactly the step that
 * differs — and so does a field that decides what runs (a step's call, its tools, the contract, a
 * parameter) when it is present but not of its type: read leniently, it would be shown as "none".
 * Only absent or null means none.
 */
export function parseStampPreview(body: unknown): StampPreview | null {
  if (!isRecord(body) || typeof body['expect'] !== 'string' || body['expect'] === '') return null;
  if (!Array.isArray(body['steps'])) return null;
  const steps: StampStep[] = [];
  for (const s of body['steps']) {
    if (!isRecord(s) || typeof s['id'] !== 'string' || typeof s['task'] !== 'string') return null;
    const tool = optStr(s['tool']);
    const tools = optStrings(s['tools']);
    const model = optStr(s['model']);
    const inputFrom = optStrings(s['inputFrom']);
    const role = optStr(s['role']);
    const effort = optOneOf(s['effort'], STAMP_EFFORTS);
    const thinking = optOneOf(s['thinking'], STAMP_THINKING);
    const timeoutMs = optMs(s['timeoutMs']);
    const roleGrant = optGrant(s['roleGrant']);
    if (roleGrant === BAD) return null;
    // What a role grants without the role: the view shows the grant under the role, so it would vanish.
    if (roleGrant !== null && role === null) return null;
    if (tool === BAD || tools === BAD || model === BAD || inputFrom === BAD) return null;
    if (role === BAD || effort === BAD || thinking === BAD || timeoutMs === BAD) return null;
    const inputTemplate = s['inputTemplate'] ?? null;
    // A call's input without the call: the view prints the input under the tool, so it would vanish.
    if (inputTemplate !== null && tool === null) return null;
    steps.push({ id: s['id'], task: s['task'], tool, inputTemplate, tools, model, inputFrom, role, effort, thinking, timeoutMs, roleGrant });
  }
  const contract = body['contract'] === undefined || body['contract'] === null ? null : optStrings(body['contract']);
  if (contract === BAD) return null;
  const rawParams = body['parameters'] ?? [];
  if (!Array.isArray(rawParams)) return null;
  const parameters: StampParameter[] = [];
  for (const p of rawParams) {
    if (!isRecord(p) || typeof p['name'] !== 'string') return null;
    parameters.push({ name: p['name'], required: p['required'] === true, default: p['default'] ?? null });
  }
  const mode = optStr(body['mode']);
  const onFailure = optStr(body['onFailure']);
  const stampedAt = optStr(body['stampedAt']);
  if (mode === BAD || onFailure === BAD || stampedAt === BAD) return null;
  const changedBy = body['changedBy'];
  return {
    expect: body['expect'],
    stampedAt,
    changedBy: changedBy === 'mandate' || changedBy === 'owner' ? changedBy : null,
    awaitsStamp: body['awaitsStamp'] === true,
    mode,
    parameters,
    onFailure,
    limits: body['limits'] ?? null,
    contract,
    steps,
  };
}

/**
 * Characters that change how text reads without being seen — direction overrides and isolates,
 * zero-width characters — printed as their code point instead. The view's threat is the helper who
 * wrote the steps: a host written with U+202E reads reversed, so another host looks familiar.
 */
// Tag characters (U+E0000–E007F) are invisible when rendered but read by a model: text hidden in a
// harmless task. Variation selectors (U+FE00–FE0F, U+E0100–E01EF) can carry data the same way.
// Every format character (`\p{Cf}`: the soft hyphen, the Arabic letter mark, the invisible
// operators and the rest of the class) and every default-ignorable code point (the Hangul and
// Mongolian fillers and variation selectors, the combining grapheme joiner, the unassigned
// ignorables) reads as nothing or as something else, so the whole classes are printed, not a list
// of their members; the class `hidden-chars.ts` uses, without its exceptions for emoji and letters.
// So are noncharacters, the line and paragraph separators, the Braille pattern blank (U+2800) and
// the control characters other than tab, line feed and carriage return, which a multi-line task
// text keeps as written. Whole code points (`u`), so the astral ranges match.
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\p{Zl}\p{Zp}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2800]/gu;
export function visible(text: string): string {
  return text.replace(HIDDEN, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
}

// The name of each mode and failure strategy the engine knows. A mode is named as the setting is
// and says nothing about asking: an interactive workflow can be saved without a step that asks, so
// a name that described asking would be false for some workflow. A failure strategy is named by
// what a run does. Under a stop no step of a later phase starts; after a step fails or a gate
// rejects, the steps of its own phase still start and finish (the view says so under the name).
// `notify` carries the name of `continue`: it runs the same and tells no one but a debug log, so a
// name that promised a report would promise what no run does. A value outside these is printed as
// it came (with hidden characters shown): no name is guessed.
const MODE_KEYS: ReadonlyMap<string, string> = new Map([
  ['interactive', 'workflow_library.stamp.mode_interactive'],
  ['autonomous', 'workflow_library.stamp.mode_autonomous'],
]);
const ON_FAILURE_KEYS: ReadonlyMap<string, string> = new Map([
  ['stop', 'workflow_library.stamp.on_failure_stop'],
  ['continue', 'workflow_library.stamp.on_failure_continue'],
  ['notify', 'workflow_library.stamp.on_failure_continue'],
]);
/** The key of a mode's name, or null for a mode this view does not know. */
export function modeKey(mode: string): string | null {
  return MODE_KEYS.get(mode) ?? null;
}
/** The key of a failure strategy's name, or null for one this view does not know. */
export function onFailureKey(onFailure: string): string | null {
  return ON_FAILURE_KEYS.get(onFailure) ?? null;
}

/** What moved between the preview that was shown and the one loaded after a refusal. */
export interface StampChanges {
  /** Mode, failure strategy, limits, parameters or contract. */
  settings: boolean;
  /** Positions in the new preview of steps that are new or differ from the step of that id before. */
  steps: ReadonlySet<number>;
  /** Ids of steps that were shown before and are gone now. */
  removed: string[];
}

/**
 * Compares two previews of the same workflow, step by step id. `stepKey` is what a step shows: by
 * default the step itself; the takeover adds the note it prints at a step. A step that only moved
 * is not marked.
 */
export function stampChanges<P extends StampPreview>(before: P, after: P, stepKey: (p: P, i: number) => string = (p, i) => JSON.stringify(p.steps[i])): StampChanges {
  // Mode and failure strategy by what the view shows for them: two values with one name (notify and
  // continue) are no change the owner could find.
  const shown = (key: string | null, raw: string | null): string | null => key ?? raw;
  const settingsOf = (p: P): string => JSON.stringify([
    p.mode === null ? null : shown(modeKey(p.mode), p.mode),
    p.onFailure === null ? null : shown(onFailureKey(p.onFailure), p.onFailure),
    p.limits, p.parameters, p.contract,
  ]);
  const was = new Map<string, string>();
  before.steps.forEach((s, i) => { if (!was.has(s.id)) was.set(s.id, stepKey(before, i)); });
  const steps = new Set<number>();
  const now = new Set<string>();
  after.steps.forEach((s, i) => {
    now.add(s.id);
    if (was.get(s.id) !== stepKey(after, i)) steps.add(i);
  });
  return { settings: settingsOf(before) !== settingsOf(after), steps, removed: [...was.keys()].filter((id) => !now.has(id)) };
}

/** A recorded step's input template as the view prints it: the literal call, nothing hidden. */
export function templateText(template: unknown): string {
  if (template === null || template === undefined) return '';
  return visible(typeof template === 'string' ? template : JSON.stringify(template, null, 2));
}

/**
 * Whether the library offers the owner the stamp of this workflow. Not where its person's access
 * ended: the takeover stamps it as well, and is the one thing offered there.
 */
export function offersStamp(wf: { awaitsStamp?: boolean | undefined; runs_as?: { ended: boolean } | null | undefined }, viewer: string | undefined): boolean {
  return wf.awaitsStamp === true && viewer === 'owner' && wf.runs_as?.ended !== true;
}

export type ConfirmOutcome =
  | { kind: 'stamped' }
  /** The steps changed since they were shown: the view loads the new version and asks again. */
  | { kind: 'changed' }
  | { kind: 'failed'; key: string };

/**
 * A step's time limit as a person reads it: milliseconds below a second (a tiny limit decides
 * whether the step can finish at all, so it is not rounded up), seconds below a minute, minutes
 * (and seconds) above.
 */
export function timeoutText(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

/**
 * The line after a stamp about plans that stay off. The wait switches off a plan that fires while
 * the workflow waits (one that runs once, a webhook — not a cron or watch schedule) and leaves it
 * off: someone has to switch it on again. `stillOff` is how many there are; an engine that does
 * not count sends none, and the line is then worded as a condition, since there may be none.
 */
export function stillOffLine(stillOff: unknown): { key: string; n: number } | null {
  if (typeof stillOff !== 'number' || !Number.isInteger(stillOff) || stillOff < 0) {
    return { key: 'workflow_library.stamp.still_off_unknown', n: 0 };
  }
  if (stillOff === 0) return null;
  return { key: stillOff === 1 ? 'workflow_library.stamp.still_off_one' : 'workflow_library.stamp.still_off_many', n: stillOff };
}

/** Which line a schedule refused for the stamp shows: the owner's own change reads differently. */
export function awaitsLineKey(changedBy: StampPreview['changedBy']): string {
  return changedBy === 'owner' ? 'workflow_library.stamp.awaits_at_schedule_own' : 'workflow_library.stamp.awaits_at_schedule';
}

/**
 * What an answer of `POST /api/workflows/:id/confirm` means for the view.
 *
 * Only a 2xx stamps. `steps_changed` is the one refusal with a way forward inside the view; every
 * other answer, including a 409 with another code or none, is a failure — never read as "stamped".
 */
export function confirmOutcome(status: number, code: string | undefined): ConfirmOutcome {
  if (status >= 200 && status < 300) return { kind: 'stamped' };
  if (status === 409 && code === 'steps_changed') return { kind: 'changed' };
  return { kind: 'failed', key: 'common.save_failed' };
}

/**
 * Whether a refused schedule is refused because its workflow waits for the owner's stamp, and
 * which workflow: the view then opens that workflow's stamp view in place of the schedule dialog.
 * The `pipelineId` must be the workflow being scheduled — a refusal naming another one is not
 * this one's way out.
 */
export function awaitsStampRefusal(status: number, body: unknown, pipelineId: string): boolean {
  return status === 409 && isRecord(body) && body['code'] === 'workflow_awaits_stamp' && body['pipelineId'] === pipelineId;
}
