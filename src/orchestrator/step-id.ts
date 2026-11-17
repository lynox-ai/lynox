import { stripHiddenInName } from '../core/hidden-text.js';
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
 * id into the steps that read this one: their `input_from` is checked against the ids, so a missed one
 * is refused, while a `{{<id>.result}}` in a task is not. An edit's `rename_step` carries the
 * references itself, and an `add_step` has none, so `refs: false` leaves the sentence out there.
 */
export function stepIdRefusal(where: string, { refs = true }: { refs?: boolean } = {}): string {
  return `${where}: a step id is 1 to ${String(STEP_ID_MAX)} characters, lowercase a-z, digits 0-9, _ or -, for example fetch_orders. `
    + 'Choose an id in that form.' + (refs ? ' If other steps refer to this step, use the new id there too.' : '');
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
export const OUTSIDE_SHAPE = '(id outside the allowed form)';

/**
 * A stored step id as the model reads it: the id itself when it has the shape, otherwise its position
 * (`#2`, as `update_workflow_steps` takes it) with a note, or the note alone where no position is known.
 * `runName`, where known, is the name its runs use (`stepRunNames`), so a run's message leads to the
 * step: `#2 (id outside the allowed form; runs as "step-2")` (U-325).
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
        return { ...step, id: typeof step.id === 'string' ? step.id : '', task: typeof step.task === 'string' ? step.task : '' };
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
  return [...text.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]!.trim().split('.')[0]!);
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

/**
 * A run's copy of a plan's steps, where every id outside the allowed shape runs under its name from
 * {@link stepRunNames}, so nothing the run writes on the way (a timeout, a refused replay, a graph or
 * manifest error) quotes the stored text. Each reference moves with its step: an `input_from` entry
 * and a `{{<id>…}}` placeholder in a task or an input template; a `{{params.…}}` placeholder is never
 * touched. `names` defaults to those of `steps`; a run that changed its copy (a removed step) passes
 * the names of the stored plan. Steps in the shape, and plans with none outside it, come back as they were.
 */
export function runStepIds<T extends RunnableStep>(steps: readonly T[], names: ReadonlyMap<string, string> = stepRunNames(steps)): T[] {
  if (names.size === 0) return [...steps];
  // Longest first, so an id that begins with another one is matched whole.
  const olds = [...names.keys()].sort((a, b) => b.length - a.length);
  const inText = (text: string): string => text.replace(/\{\{([^}]+)\}\}/g, (match: string, raw: string) => {
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
