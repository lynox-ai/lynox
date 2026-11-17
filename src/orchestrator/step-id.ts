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
 */
export function shownStepId(id: string, index?: number): string {
  if (isStepIdShape(id)) return id;
  return index === undefined ? OUTSIDE_SHAPE : `#${String(index + 1)} ${OUTSIDE_SHAPE}`;
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

/**
 * A run's copy of a stored plan's steps, where every id outside the allowed shape is replaced by
 * `step-<n>`, its position counted from 1 (`step-<n>-<k>` if that is taken). A plan stored before
 * ids had a shape still runs, and what a run writes on the way (a timeout, a refused replay, a graph
 * or manifest error) names its steps by id; with this, none of it carries the stored text.
 *
 * Each reference moves with its step: an `input_from` entry and a `{{<id>…}}` placeholder in a task
 * or an input template. An `input_from` entry outside the shape that names no step becomes
 * `unknown-step-<j>`, so the graph check refuses it without quoting it. Steps already in the shape,
 * and plans with none outside it, come back unchanged.
 */
export function runStepIds<T extends { id: string; task: string; input_from?: string[] | undefined; input_template?: Record<string, unknown> | undefined }>(steps: readonly T[]): T[] {
  const taken = new Set(steps.map(s => s.id).filter(isStepIdShape));
  const renamed = new Map<string, string>();
  steps.forEach((s, i) => {
    if (isStepIdShape(s.id) || renamed.has(s.id)) return;
    let name = `step-${String(i + 1)}`;
    for (let k = 2; taken.has(name); k++) name = `step-${String(i + 1)}-${String(k)}`;
    taken.add(name);
    renamed.set(s.id, name);
  });
  const dangling = steps.some(s => (s.input_from ?? []).some(r => !isStepIdShape(r) && !renamed.has(r)));
  if (renamed.size === 0 && !dangling) return [...steps];

  // Longest first, so an id that begins with another one is matched whole.
  const olds = [...renamed.keys()].sort((a, b) => b.length - a.length);
  const inText = (text: string): string => text.replace(/\{\{([^}]+)\}\}/g, (match: string, raw: string) => {
    const path = raw.trim();
    const old = olds.find(o => path === o || path.startsWith(`${o}.`));
    return old === undefined ? match : `{{${renamed.get(old)!}${path.slice(old.length)}}}`;
  });
  const inValue = (value: unknown): unknown => {
    if (typeof value === 'string') return inText(value);
    if (Array.isArray(value)) return value.map(inValue);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, inValue(v)]));
    }
    return value;
  };
  let unknown = 0;
  const unknownName = new Map<string, string>();
  const ref = (r: string): string => {
    if (isStepIdShape(r)) return r;
    const now = renamed.get(r);
    if (now !== undefined) return now;
    let name = unknownName.get(r);
    if (name === undefined) {
      do name = `unknown-step-${String(++unknown)}`; while (taken.has(name));
      unknownName.set(r, name);
    }
    return name;
  };
  return steps.map(s => ({
    ...s,
    id: renamed.get(s.id) ?? s.id,
    task: inText(s.task),
    ...(s.input_from !== undefined ? { input_from: s.input_from.map(ref) } : {}),
    ...(s.input_template !== undefined ? { input_template: inValue(s.input_template) as Record<string, unknown> } : {}),
  }));
}
