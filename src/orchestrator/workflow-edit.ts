import type { InlinePipelineStep } from '../types/pipeline.js';
import { findHiddenInName, stripHiddenInName } from '../core/hidden-text.js';
import { isStepIdShape, stepIdRefusal, stepRunIds } from './step-id.js';
import { fieldReferencing } from './template-refs.js';

/**
 * A single step-level edit to a workflow's step list. The vocabulary is shared
 * by two consumers so the mutation logic lives in exactly one place
 * (`applyModifications`):
 *  - the run-volatile `run_workflow` tool (modifies steps for ONE run, never
 *    persisted) — emits only `remove` / `update_task`;
 *  - the persistent `update_workflow_steps` tool (Slice C — edits + saves a
 *    stored workflow) — additionally emits `add_step`, `rename_step` and `set_input_from`.
 */
export interface StepModification {
  action: 'remove' | 'update_task' | 'add_step' | 'rename_step' | 'set_input_from';
  /** Target step id for `remove`/`update_task`/`rename_step`/`set_input_from` (or its position, `#<n>`); the NEW step's id for `add_step`. */
  step_id: string;
  /** New task text for `update_task`; the new step's task for `add_step`; the new id for `rename_step`. */
  value?: string | undefined;
  /** `add_step`: the step ids the new step reads from; `set_input_from`: the step ids the target step
   *  reads from from now on, replacing its list (empty clears it). */
  input_from?: string[] | undefined;
  /** `add_step` only — insert immediately AFTER this step id (default: append). */
  after?: string | undefined;
}

/** Why `id` cannot be a new step's id, or null: an id outside the shape (`step-id.ts`). The shape
 *  also keeps out what a reference could not name: a dot or a brace (`{{<id>.result}}` is cut at each
 *  dot and ends at `}`) and a leading `#`, which names a step by its position. */
function newIdProblem(id: string, action: 'add_step' | 'rename_step'): string | null {
  return isStepIdShape(id) ? null : `Error: ${action}: ${stepIdRefusal('the new id', { refs: false })}`;
}

/** A step id as a refusal quotes it: as it reads, escaped, and short. */
export function quotedId(id: string): string {
  const shown = Array.from(stripHiddenInName(id));
  return shown.length > 64 ? `${JSON.stringify(shown.slice(0, 64).join(''))}…` : JSON.stringify(shown.join(''));
}

/** The indexes of the steps whose id reads as `id` once the characters that render as nothing go. */
function alikeIndexes(steps: readonly InlinePipelineStep[], id: string): number[] {
  const shown = stripHiddenInName(id);
  return steps.flatMap((s, i) => (stripHiddenInName(s.id) === shown ? [i] : []));
}

/**
 * The index of the step `id` names, `missing`, or `ambiguous`. An id stored before the save refused
 * characters that render as nothing reaches the model without them (`hidden-text.ts`), so the model
 * cannot name it exactly: an id names the one step whose id reads the same without them. Where two
 * steps read alike, only an id typed with its hidden characters names one of them; the model names
 * either by its position instead, `#<n>` as the step list numbers it. A step stored with the id
 * `#<n>` (before new ids refused it) is what `#<n>` names; renamed, `#<n>` is position n again.
 */
function resolveStep(steps: readonly InlinePipelineStep[], id: string, runNames?: ReadonlyMap<string, string>): number | 'missing' | 'ambiguous' {
  // The stored id first, so every step stays reachable by its own id, whatever ids it shares a
  // list with; a refusal that names a position someone's id takes says to rename that step first
  // (`byPosition`).
  const position = /^#([1-9]\d{0,3})$/.exec(id);
  if (position) {
    const literal = steps.findIndex(s => s.id === id);
    if (literal !== -1) return literal;
    const at = Number(position[1]) - 1;
    return at < steps.length ? at : 'missing';
  }
  const alike = alikeIndexes(steps, id);
  // A run names a step stored outside the shape `step-<n>` (`stepRunNames`): that name reaches it too.
  // It stands for the stored id it had before this call's first change, so a step this call removed
  // or renamed earlier does not hand its name to another one.
  if (alike.length === 0) {
    const storedId = runNames?.get(id);
    if (storedId === undefined) return 'missing';
    const at = steps.findIndex(s => s.id === storedId);
    // Two steps stored with the same id share a run name: it names neither for sure.
    if (at !== -1 && steps.some((s, j) => j !== at && s.id === storedId)) return 'ambiguous';
    return at === -1 ? 'missing' : at;
  }
  if (alike.length === 1) return alike[0]!;
  const exact = steps.findIndex(s => s.id === id);
  return exact !== -1 && id !== stripHiddenInName(id) ? exact : 'ambiguous';
}

/**
 * How a refusal tells the model to name the step at index `i` by its position: `step_id "#<i+1>"`,
 * and where another step is stored with that very id, which `#<i+1>` then names, to rename that one
 * first in the same call.
 */
export function byPosition(steps: readonly InlinePipelineStep[], i: number): string {
  const ref = `#${i + 1}`;
  const other = steps.findIndex((s, j) => j !== i && s.id === ref);
  return other === -1
    ? `step_id "${ref}"`
    : `step_id "${ref}", after a rename_step with step_id "${ref}" that gives step #${other + 1}, stored with the id "${ref}", a new id`;
}

/** Positions as a reader lists them: "#1 and #3", "#1, #3 and #5". */
function listedPositions(indexes: readonly number[]): string {
  const positions = indexes.map(i => `#${i + 1}`);
  return positions.length > 1 ? `${positions.slice(0, -1).join(', ')} and ${positions[positions.length - 1]}` : positions.join('');
}

/** The refusal for an id that names two steps, which `what` cannot choose between. */
function ambiguousText(steps: readonly InlinePipelineStep[], id: string, what: string, runNames?: ReadonlyMap<string, string>): string {
  const change = what === 'task update' ? 'this update' : what === 'removal' ? 'this removal' : what === 'renaming' ? 'this rename' : what;
  const alike = alikeIndexes(steps, id);
  if (alike.length === 0) {
    // A run name two steps share: they were stored with the same id, outside the shape.
    const storedId = runNames?.get(id);
    const shared = steps.flatMap((s, i) => (s.id === storedId ? [i] : []));
    const at = shared[shared.length - 1] ?? 0;
    return `Error: Steps ${listedPositions(shared)} were stored with the same id, which runs as ${quotedId(id)}, so ${change} cannot tell which one is meant. Name the step by its position instead, e.g. ${byPosition(steps, at)}. To end the clash, give one of them its own id (rename_step with ${byPosition(steps, at)}).`;
  }
  const last = alike[alike.length - 1]!;
  return `Error: Steps ${listedPositions(alike)} all read as ${quotedId(id)} (their ids differ only in characters that do not show), so ${change} cannot tell which one is meant. Name the step by its position instead, e.g. ${byPosition(steps, last)}.`;
}

/** `text` with every `{{<from>…}}` reference to a step's output pointed at `to`. */
function renamedRefs(text: string, from: string, to: string): string {
  return text.replace(/\{\{(\s*)([^}]+)\}\}/g, (match: string, ws: string, path: string) => {
    // As `resolveTaskTemplate` reads a path: trimmed, the step id up to the first dot.
    if (path.trimEnd() !== from && !path.startsWith(`${from}.`)) return match;
    return `{{${ws}${to}${path.slice(from.length)}}}`;
  });
}

/** `value` (a step's `input_template`) with every string's step references renamed. */
function renamedInTemplate(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return renamedRefs(value, from, to);
  if (Array.isArray(value)) return value.map(v => renamedInTemplate(v, from, to));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renamedInTemplate(v, from, to)]));
  }
  return value;
}

/**
 * Apply a list of step modifications in order, mutating `steps` in place.
 * Returns null on success or an error string on the first invalid modification
 * (leaving `steps` partially mutated — callers operate on a deep copy and
 * discard it on error). Modifications are applied in array order, so an
 * `add_step` followed by a `remove` of that same id is valid. `notes`, when given, gets a sentence
 * for each `#<n>` that named a step stored with that id at another position than n, so the answer
 * says which step it reached.
 */
export function applyModifications(steps: InlinePipelineStep[], modifications: StepModification[], notes?: string[]): string | null {
  // The names runs give steps stored outside the shape, taken once from the list as it came in.
  const runNames = stepRunIds(steps);
  const stepIndex = (list: readonly InlinePipelineStep[], id: string): number | 'missing' | 'ambiguous' => {
    const at = resolveStep(list, id, runNames);
    if (typeof at === 'number' && /^#\d+$/.test(id) && at !== Number(id.slice(1)) - 1) {
      notes?.push(`${quotedId(id)} named step #${at + 1}, stored with that id, not the step at position ${id.slice(1)}.`);
    }
    return at;
  };
  // The steps this edit removes: a reference to one that is still read once every action has run is
  // refused below, so an edit that removes a step and changes what read it is one edit.
  const removed = new Set<string>();
  // Each step's id and position in the list the edit starts from: a refused edit is discarded, so the
  // caller's next edit starts from that list, and a refusal after the edit names a step as it reads
  // there (steps keep their object through update_task, rename_step and set_input_from).
  const stored = new Map(steps.map((s, i) => [s, { id: s.id, at: i + 1 }] as const));
  for (const mod of modifications) {
    if (mod.action === 'add_step') {
      // The shape first, so no refusal quotes an id outside it back to the model.
      const problem = newIdProblem(mod.step_id, 'add_step');
      if (problem) return problem;
      if (steps.some(s => s.id === mod.step_id)) {
        return `Error: Step ${quotedId(mod.step_id)} already exists — cannot add a duplicate id.`;
      }
      if (!mod.value) {
        return `Error: "value" (the task) is required for add_step ${quotedId(mod.step_id)}.`;
      }
      const inputFrom: string[] = [];
      const missing: string[] = [];
      for (const dep of mod.input_from ?? []) {
        const at = stepIndex(steps, dep);
        if (at === 'ambiguous') return ambiguousText(steps, dep, `the input of add_step ${quotedId(mod.step_id)}`, runNames);
        if (at === 'missing') missing.push(quotedId(dep));
        else inputFrom.push(steps[at]!.id);
      }
      if (missing.length > 0) {
        return `Error: add_step ${quotedId(mod.step_id)} depends on unknown step(s): ${missing.join(', ')}.`;
      }
      const newStep: InlinePipelineStep = {
        id: mod.step_id,
        task: mod.value,
        ...(inputFrom.length > 0 ? { input_from: inputFrom } : {}),
      };
      if (mod.after !== undefined) {
        const at = stepIndex(steps, mod.after);
        if (at === 'ambiguous') return ambiguousText(steps, mod.after, `the insertion after it (add_step ${quotedId(mod.step_id)})`, runNames);
        if (at === 'missing') return `Error: add_step ${quotedId(mod.step_id)} requests insertion after ${quotedId(mod.after)}, which does not exist.`;
        steps.splice(at + 1, 0, newStep);
      } else {
        steps.push(newStep);
      }
      continue;
    }

    if (mod.action === 'set_input_from') {
      // The way to make a `{{<id>.result}}` reference resolve in a stored step: the steps it reads
      // (`template-refs.ts`). Each entry is resolved as add_step resolves its inputs.
      const at = stepIndex(steps, mod.step_id);
      if (at === 'ambiguous') return ambiguousText(steps, mod.step_id, 'set_input_from');
      if (at === 'missing') return `Error: Step ${quotedId(mod.step_id)} not found for set_input_from.`;
      const inputFrom: string[] = [];
      const missing: string[] = [];
      for (const dep of mod.input_from ?? []) {
        const d = stepIndex(steps, dep);
        if (d === 'ambiguous') return ambiguousText(steps, dep, `the input of step #${String(at + 1)} (set_input_from)`);
        if (d === 'missing') { missing.push(quotedId(dep)); continue; }
        if (d === at) return `Error: set_input_from: step #${String(at + 1)} cannot read its own output.`;
        if (!inputFrom.includes(steps[d]!.id)) inputFrom.push(steps[d]!.id);
      }
      if (missing.length > 0) return `Error: set_input_from for step #${String(at + 1)} names unknown step(s): ${missing.join(', ')}.`;
      steps[at]!.input_from = inputFrom.length > 0 ? inputFrom : undefined;
      continue;
    }

    const what = mod.action === 'remove' ? 'removal' : mod.action === 'update_task' ? 'task update' : 'renaming';
    const idx = stepIndex(steps, mod.step_id);
    if (idx === 'ambiguous') return ambiguousText(steps, mod.step_id, what, runNames);
    if (idx === 'missing') return `Error: Step ${quotedId(mod.step_id)} not found for ${what}.`;

    if (mod.action === 'rename_step') {
      // A new id for a step, and every reference to it follows: the steps that read its output
      // (`input_from`) and the `{{<id>.…}}` references in their tasks and input templates. The way
      // out for an id stored with a character the save now refuses.
      const to = mod.value;
      if (!to) return `Error: "value" (the new id) is required for rename_step ${quotedId(mod.step_id)}.`;
      const hidden = findHiddenInName(to, 'the new id');
      if (hidden) return `Error: rename_step: the new id contains a character that renders as nothing (${hidden.codePoint}). Type the id again.`;
      const problem = newIdProblem(to, 'rename_step');
      if (problem) return problem;
      const from = steps[idx]!.id;
      if (to !== from && steps.some(s => s.id === to)) return `Error: Step ${quotedId(to)} already exists — cannot rename step #${idx + 1} to it.`;
      // A step that reads this one and already holds `{{<to>.…}}` as text (a placeholder for the
      // system a tool writes to) would read this step's output there once its input_from names `to`;
      // in the step itself, that text would become a reference to itself.
      if (to !== from) {
        for (const [i, s] of steps.entries()) {
          if (i !== idx && !(s.input_from ?? []).includes(from)) continue;
          const field = fieldReferencing(s, to);
          if (!field) continue;
          if (i === idx) {
            return `Error: rename_step: step #${String(idx + 1)} holds text starting with "{{${to}" in its ${field}, `
              + 'which the new id would turn into a reference to the step itself. Choose another id.';
          }
          const reader = isStepIdShape(s.id) ? `step "${s.id}"` : `step #${String(i + 1)}`;
          return `Error: rename_step: ${reader} reads step #${String(idx + 1)} and holds text starting with "{{${to}" in its ${field}, `
            + `which the new id would turn into a reference to step #${String(idx + 1)}. Choose another id.`;
        }
      }
      steps[idx]!.id = to;
      for (const s of steps) {
        // A `{{<from>.…}}` is a reference only in a step that lists `from` in its input_from: the
        // run builds a step's context from those steps alone (`context.ts`). Anywhere else it is
        // text, such as a placeholder a tool hands on to the system it writes to, and stays as written.
        const reads = s.input_from?.includes(from) === true;
        if (s.input_from) s.input_from = s.input_from.map(dep => (dep === from ? to : dep));
        if (!reads) continue;
        s.task = renamedRefs(s.task, from, to);
        if (s.input_template) s.input_template = renamedInTemplate(s.input_template, from, to) as Record<string, unknown>;
      }
      continue;
    }

    if (mod.action === 'remove') {
      const removedId = steps[idx]!.id;
      removed.add(removedId);
      steps.splice(idx, 1);
      // Drop the removed step from every other step's data dependencies so the
      // edited list never references a step that no longer exists.
      for (const s of steps) {
        if (s.input_from) {
          s.input_from = s.input_from.filter(dep => dep !== removedId);
          if (s.input_from.length === 0) {
            s.input_from = undefined;
          }
        }
      }
    } else if (mod.action === 'update_task') {
      if (!mod.value) {
        return 'Error: "value" is required for update_task modification.';
      }
      steps[idx]!.task = mod.value;
    }
  }
  // A `{{<id>.…}}` reference to a removed step would stay as raw text in the step that reads it (its
  // `input_from` entry was dropped with the step), so the edit is refused, naming that step as the list
  // the edit started from has it. An id the same edit gave to another step (add_step, rename_step) is
  // not removed any more.
  for (const removedId of removed) {
    if (steps.some(s => s.id === removedId)) continue;
    for (const s of steps) {
      const field = fieldReferencing(s, removedId);
      if (!field) continue;
      // By its stored id when that has the shape: a `#n` in the next edit counts in the list as that
      // edit has changed it so far, an id does not. A step this edit adds is not in that list; its id
      // has the shape (`newIdProblem`).
      const was = stored.get(s);
      const which = was === undefined ? `the step this edit adds ("${s.id}")`
        : isStepIdShape(was.id) ? `step "${was.id}"` : `step #${String(was.at)} (its position before this edit)`;
      // An input template cannot be edited, so keeping the step it reads is the way that loses nothing;
      // removing the reader too is named last, and only with the user's word.
      if (field !== 'task') {
        const renamedToo = was !== undefined && was.id !== s.id && isStepIdShape(was.id)
          ? ` This edit also renames ${which}: if you remove it, name it by its new id.` : '';
        return `Error: remove: ${which} reads the output of a step this edit removes, in its ${field}, and its input template cannot be edited. `
          + `Keep the step it reads, or remove ${which} too only if the user wants it gone.${renamedToo}`;
      }
      const fix = `Change that reference in the same edit (update_task), or remove ${which} too.`;
      // A step this edit renames is named by its old id, which no longer finds it after the rename: an
      // update_task goes before the rename, a removal names the new id (or the rename is dropped). A
      // step named by its position is found by it before and after a rename.
      const renamed = was === undefined || was.id === s.id || !isStepIdShape(was.id) ? ''
        : ' This edit renames that step: put the update_task before the rename, or remove it by its new id.';
      return `Error: remove: ${which} reads the output of a step this edit removes, in its ${field}. ${fix}${renamed}`;
    }
  }
  return null; // no error
}
