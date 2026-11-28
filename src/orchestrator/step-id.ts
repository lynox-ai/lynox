import { stripHiddenInName } from '../core/hidden-text.js';
import { placeholders, replacePlaceholders } from './placeholders.js';
/**
 * The shape of a workflow step's id. An id reaches the model wherever a run, a diagnosis or an edit
 * names its step, and the owner needs it to repair a plan, so it cannot be left out. Its shape is
 * therefore limited: free text in an id would read as lynox's own words next to it (U-204).
 *
 * A new id (saved, run inline, added or renamed by an edit) must have this shape. An id stored
 * before the limit is shown by its position instead of its text (U-314), and a run still runs it.
 */

/** The longest a step id may be. */
export const STEP_ID_MAX = 40;

const STEP_ID_SHAPE = new RegExp(`^[a-z0-9_-]{1,${String(STEP_ID_MAX)}}$`);

/** Whether `id` is a step id in the allowed shape: 1 to 40 characters from a-z, 0-9, `_` and `-`. */
export function isStepIdShape(id: unknown): id is string {
  return typeof id === 'string' && STEP_ID_SHAPE.test(id);
}

/**
 * Why a step id outside the shape is refused, naming where it is (`step #3 (steps[2].id)`) and never the id
 * itself: the model reads this text, so it carries no stored or typed text back (U-314). Where the
 * model writes the whole step list (a save, an inline run), the last sentence asks it to carry the new
 * id into the steps that read this one: their `input_from` and their `{{<id>.result}}` references are
 * checked against the ids (`template-refs.ts`), so a missed one is refused. An edit's `rename_step`
 * carries the references itself, and an `add_step` has none, so `refs: false` leaves the sentence out
 * there.
 */
export function stepIdRefusal(where: string, { refs = true }: { refs?: boolean } = {}): string {
  return `${where}: a step id is 1 to ${String(STEP_ID_MAX)} characters, lowercase a-z, digits 0-9, _ or -, for example fetch_orders. `
    + 'Choose an id in that form.' + (refs ? ' If other steps refer to this step, use the new id there too.' : '');
}

/**
 * Ids in the shape that a step still cannot take, because the context of a run already uses the
 * name: `params` holds the workflow's parameters (`{{params.<name>}}`), and a plain object reads
 * `__proto__` and `constructor` through to its prototype. A step under `params` would take its place
 * in the context of each step that reads it (`buildStepContext`), so a reference meant for the
 * parameters would read the step's output instead. The contexts are built without a prototype, so
 * the other two are kept out for any reader that is not.
 */
export const RESERVED_STEP_IDS: ReadonlySet<string> = new Set(['params', '__proto__', 'constructor']);

/** Whether `id` is one of {@link RESERVED_STEP_IDS}. */
export function isReservedStepId(id: unknown): boolean {
  return typeof id === 'string' && RESERVED_STEP_IDS.has(id);
}

/** {@link RESERVED_STEP_IDS} as a fix names them: `params, __proto__ or constructor`. */
export function reservedStepIdsInWords(): string {
  const ids = [...RESERVED_STEP_IDS];
  return ids.length < 2 ? ids.join('') : `${ids.slice(0, -1).join(', ')} or ${ids[ids.length - 1]!}`;
}

/** Why a reserved id is refused as a step id, naming where it is; the reserved names are lynox's own words. */
export function reservedStepIdRefusal(where: string, { refs = true }: { refs?: boolean } = {}): string {
  return `${where}: "params", "__proto__" and "constructor" cannot be step ids, because a run already uses these names ("params" holds the workflow's parameters). `
    + 'Choose another id in the allowed form, for example fetch_orders.' + (refs ? ' If other steps refer to this step, use the new id there too.' : '');
}

/**
 * Why a step reference (`input_from`) outside the shape is refused: it names a step that should exist,
 * so the model is told to point at that step, not to choose a new id (U-316).
 */
export function stepRefRefusal(where: string): string {
  return `${where}: this refers to a step id outside the allowed form (1 to ${String(STEP_ID_MAX)} characters, lowercase a-z, digits 0-9, _ or -). `
    + "Refer to the step it should read by that step's id.";
}

/**
 * The first step whose id is outside the shape, as `stepIdRefusal` names it, or null. The step is
 * named first as every other text names a step to the model, counted from 1 (`step #3`), then by the
 * path into the list it just wrote, counted from 0 (`steps[2].id`) (U-316).
 */
export function stepIdIssue(steps: ReadonlyArray<{ id?: unknown; input_from?: unknown }>, path = 'steps'): string | null {
  const at = steps.findIndex(s => !isStepIdShape(s.id));
  if (at !== -1) return stepIdRefusal(`step #${String(at + 1)} (${path}[${String(at)}].id)`);
  const reserved = steps.findIndex(s => isReservedStepId(s.id));
  if (reserved !== -1) return reservedStepIdRefusal(`step #${String(reserved + 1)} (${path}[${String(reserved)}].id)`);
  // A step's `input_from` names step ids too, and the graph check quotes one it cannot find: an entry
  // outside the shape is refused here, by its place, before that check could repeat its text.
  for (const [i, s] of steps.entries()) {
    const refs = Array.isArray(s.input_from) ? s.input_from as unknown[] : [];
    const j = refs.findIndex(r => !isStepIdShape(r));
    if (j !== -1) return stepRefRefusal(`step #${String(i + 1)} (${path}[${String(i)}].input_from[${String(j)}])`);
  }
  return null;
}

/** What stands in for a stored id outside the shape where the model reads it. */
export const OUTSIDE_SHAPE = '(lynox does not show its id)';

/**
 * A stored step id as the model reads it: the id itself when it has the shape, otherwise its position
 * (`#2`, as `update_workflow_steps` takes it) with a note, or the note alone where no position is known.
 * `runName`, where known, is the name its runs use (`stepRunNames`), so a run's message leads to the
 * step: `#2 (lynox does not show its id; runs as "step-2")` (U-325, U-362).
 */
export function shownStepId(id: string, index?: number, runName?: string): string {
  if (isStepIdShape(id)) return id;
  if (index === undefined) return OUTSIDE_SHAPE;
  const note = runName === undefined ? OUTSIDE_SHAPE : `${OUTSIDE_SHAPE.slice(0, -1)}; runs as "${runName}")`;
  return `#${String(index + 1)} ${note}`;
}

/**
 * A step id a run recorded, as a diagnosis or a preamble shows it: an id in the shape as it is, unless
 * it is the run name of a stored step outside the shape, which is then named by its stored position
 * with the bridge; an id outside the shape (a run from before run names) by its stored position.
 */
export function shownRunStepId(id: string, stored: readonly RunnableStep[] | undefined): string {
  const steps = stored ?? [];
  const names = stepRunNames(steps);
  const at = stepRunPositions(steps).get(id);
  if (at !== undefined) return shownStepId(steps[at]!.id, at, id);
  if (isStepIdShape(id)) return id;
  const index = steps.findIndex(s => s.id === id);
  return index === -1 ? OUTSIDE_SHAPE : shownStepId(id, index, names.get(id));
}

/** The steps of a stored workflow row, or undefined when there is no row or its definition does not parse. */
export function storedSteps(row: { manifest_json: string } | undefined): RunnableStep[] | undefined {
  if (!row) return undefined;
  try {
    const steps = (JSON.parse(row.manifest_json) as { steps?: unknown }).steps;
    // Every step keeps its place, so the positions stay those of the stored plan.
    return Array.isArray(steps)
      ? steps.map((s: unknown) => {
        const step = (s ?? {}) as Partial<RunnableStep>;
        const from = Array.isArray(step.input_from) ? step.input_from.filter((r): r is string => typeof r === 'string') : undefined;
        const template = step.input_template !== null && typeof step.input_template === 'object' && !Array.isArray(step.input_template) ? step.input_template : undefined;
        return {
          id: typeof step.id === 'string' ? step.id : '',
          task: typeof step.task === 'string' ? step.task : '',
          ...(from !== undefined ? { input_from: from } : {}),
          ...(template !== undefined ? { input_template: template } : {}),
        };
      })
      : undefined;
  } catch {
    return undefined;
  }
}

/** The step ids of a stored workflow row in their stored order, or undefined when there is no row or
 *  its definition does not parse: the positions {@link shownStepId} names. */
export function storedStepOrder(row: { manifest_json: string } | undefined): string[] | undefined {
  if (!row) return undefined;
  try {
    const steps = (JSON.parse(row.manifest_json) as { steps?: unknown }).steps;
    return Array.isArray(steps) ? steps.map(s => String((s as { id?: unknown } | null)?.id ?? '')) : undefined;
  } catch {
    return undefined;
  }
}

/** What a run takes of a step: its id, and what refers to other steps. */
export type RunnableStep = { id: string; task: string; input_from?: string[] | undefined; input_template?: Record<string, unknown> | undefined };

/** The first segment of each `{{…}}` placeholder in a text. */
function placeholderHeads(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  return placeholders(text).map(p => p.inner.trim().split('.')[0]!);
}

function templateStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(templateStrings);
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(templateStrings);
  return [];
}

/**
 * The names a stored plan's steps run under: for each id outside the allowed shape, `step-<n>`, its
 * position in the STORED plan counted from 1 (`step-<n>a`, `step-<n>b`, … if that is taken); for each
 * `input_from` entry outside the shape that names no step, `unknown-step-<j>`. A name counts as taken
 * if a step has it as its id, or a reference or placeholder in the shape uses it, so a renamed step
 * never answers a reference its author wired to something else. Computed from the stored plan, never
 * from one run's changed copy, so the same step has the same name in every run.
 */
export function stepRunNames(steps: readonly RunnableStep[]): Map<string, string> {
  // Each read as it reads without the characters that render as nothing: an id stored as `step-2`
  // plus one of them reads as `step-2` (and an edit finds it by that), so it holds that name too, and a
  // run that strips a task first sees the same heads as one that does not.
  const taken = new Set<string>(['params']);
  const take = (name: unknown): void => { if (typeof name !== 'string') return; const shown = stripHiddenInName(name); if (isStepIdShape(shown)) taken.add(shown); };
  for (const s of steps) {
    take(s.id);
    for (const r of s.input_from ?? []) take(r);
    for (const text of [s.task, ...templateStrings(s.input_template)]) {
      for (const head of placeholderHeads(text)) take(head);
    }
  }
  const names = new Map<string, string>();
  const free = (base: string): string => {
    if (!taken.has(base)) return base;
    for (let k = 0; k < 26; k++) {
      const name = `${base}${String.fromCharCode(97 + k)}`;
      if (!taken.has(name)) return name;
    }
    for (let k = 2; ; k++) if (!taken.has(`${base}_${String(k)}`)) return `${base}_${String(k)}`;
  };
  steps.forEach((s, i) => {
    if (isStepIdShape(s.id) || names.has(s.id)) return;
    const name = free(`step-${String(i + 1)}`);
    taken.add(name);
    names.set(s.id, name);
  });
  let unknown = 0;
  for (const s of steps) {
    for (const r of s.input_from ?? []) {
      if (isStepIdShape(r) || names.has(r)) continue;
      let name: string;
      do name = `unknown-step-${String(++unknown)}`; while (taken.has(name));
      taken.add(name);
      names.set(r, name);
    }
  }
  return names;
}

/**
 * The stored position (from 0) of each step a run names by its run name (`stepRunNames`): how a
 * name a run wrote leads back to the step in the stored plan, for an edit or a diagnosis.
 */
export function stepRunPositions(steps: readonly RunnableStep[]): Map<string, number> {
  const names = stepRunNames(steps);
  const at = new Map<string, number>();
  steps.forEach((s, i) => {
    const name = names.get(s.id);
    if (name !== undefined && !at.has(name)) at.set(name, i);
  });
  return at;
}

/** Each run name of a step stored outside the shape, with the stored id it stands for. */
export function stepRunIds(steps: readonly RunnableStep[]): Map<string, string> {
  const names = stepRunNames(steps);
  const ids = new Map<string, string>();
  for (const s of steps) {
    const name = names.get(s.id);
    if (name !== undefined && !ids.has(name)) ids.set(name, s.id);
  }
  return ids;
}

/** The keys of a step's entry in a run's context (`buildStepContext` in context.ts). */
const CONTEXT_ENTRY_KEYS = ['result', 'costUsd'] as const;

/**
 * Whether a stored id reads as another step's id plus a key of that step's context entry
 * (`a.result` beside a step `a`), so a `{{a.result}}` placeholder means step a's result, not this
 * step. `ids` holds the other steps' ids (for a run, those of the stored plan, so a step its copy
 * dropped still counts). A head that is no step's id is not one: `{{foo.result}}` beside a stored
 * `foo.result` and no step `foo` means that step. Such an id never takes a placeholder: not when a
 * run names it (`runStepIds`), not when a rename moves it (workflow-edit.ts).
 */
export function readsAsContextKey(id: string, ids: ReadonlySet<string>): boolean {
  return CONTEXT_ENTRY_KEYS.some(k => {
    if (!id.endsWith(`.${k}`)) return false;
    const head = id.slice(0, -(k.length + 1));
    return ids.has(head);
  });
}

/**
 * A run's copy of a plan's steps, where every id outside the allowed shape runs under its name from
 * {@link stepRunNames}, so nothing the run writes on the way (a timeout, a refused replay, a graph or
 * manifest error) quotes the stored text. Each reference moves with its step: an `input_from` entry
 * and a `{{<id>…}}` placeholder in a task or an input template; a `{{params.…}}` placeholder is never
 * touched. `names` and `storedIds` default to those of `steps`; a run that changed its copy (a
 * removed step) passes the names and the ids of the stored plan. Steps in the shape, and plans with
 * none outside it, come back as they were.
 *
 * A placeholder is never moved to a stored id that {@link readsAsContextKey}: before run names,
 * `{{a.result}}` read step a's result, and it keeps reading it. The step itself and its
 * `input_from` entries still move.
 */
export function runStepIds<T extends RunnableStep>(
  steps: readonly T[],
  names: ReadonlyMap<string, string> = stepRunNames(steps),
  storedIds: Iterable<string> = steps.map(s => s.id),
): T[] {
  if (names.size === 0) return [...steps];
  // Another step's id: one of this copy or of the stored plan (a run whose copy dropped a step passes
  // the stored plan's names and ids).
  const ids = new Set<string>([...steps.map(s => s.id), ...names.keys(), ...storedIds]);
  // Longest first, so an id that begins with another one is matched whole.
  const olds = [...names.keys()].filter(o => !readsAsContextKey(o, ids)).sort((a, b) => b.length - a.length);
  const inText = (text: string): string => replacePlaceholders(text, (match: string, raw: string) => {
    const path = raw.trim();
    if (path === 'params' || path.startsWith('params.')) return match;
    const old = olds.find(o => path === o || path.startsWith(`${o}.`));
    return old === undefined ? match : `{{${names.get(old)!}${path.slice(old.length)}}}`;
  });
  const inValue = (value: unknown): unknown => {
    if (typeof value === 'string') return inText(value);
    if (Array.isArray(value)) return value.map(inValue);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, inValue(v)]));
    }
    return value;
  };
  return steps.map(s => ({
    ...s,
    id: names.get(s.id) ?? s.id,
    task: inText(s.task),
    ...(s.input_from !== undefined ? { input_from: s.input_from.map(r => names.get(r) ?? r) } : {}),
    ...(s.input_template !== undefined ? { input_template: inValue(s.input_template) as Record<string, unknown> } : {}),
  }));
}
