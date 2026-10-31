import type { InlinePipelineStep } from '../types/pipeline.js';
import { findHiddenInName, stripHiddenInName } from '../core/hidden-text.js';

/**
 * A single step-level edit to a workflow's step list. The vocabulary is shared
 * by two consumers so the mutation logic lives in exactly one place
 * (`applyModifications`):
 *  - the run-volatile `run_workflow` tool (modifies steps for ONE run, never
 *    persisted) — emits only `remove` / `update_task`;
 *  - the persistent `update_workflow_steps` tool (Slice C — edits + saves a
 *    stored workflow) — additionally emits `add_step` and `rename_step`.
 */
export interface StepModification {
  action: 'remove' | 'update_task' | 'add_step' | 'rename_step';
  /** Target step id for `remove`/`update_task`/`rename_step`; the NEW step's id for `add_step`. */
  step_id: string;
  /** New task text for `update_task`; the new step's task for `add_step`; the new id for `rename_step`. */
  value?: string | undefined;
  /** `add_step` only — data-dependency step ids the new step reads from. */
  input_from?: string[] | undefined;
  /** `add_step` only — insert immediately AFTER this step id (default: append). */
  after?: string | undefined;
}

/**
 * The index of the step `id` names, `missing`, or `ambiguous`. An id stored before the save refused
 * characters that render as nothing reaches the model without them (`hidden-text.ts`), so the model
 * cannot name it exactly: an id no step has exactly names the one step whose id reads the same
 * without them. Two such steps, and the id names neither.
 */
function stepIndex(steps: readonly InlinePipelineStep[], id: string): number | 'missing' | 'ambiguous' {
  const exact = steps.findIndex(s => s.id === id);
  if (exact !== -1) return exact;
  const shown = stripHiddenInName(id);
  const alike = steps.flatMap((s, i) => (stripHiddenInName(s.id) === shown ? [i] : []));
  if (alike.length > 1) return 'ambiguous';
  return alike[0] ?? 'missing';
}

/** The refusal for an id that names two steps, which `what` cannot choose between. */
function ambiguousText(id: string, what: string): string {
  return `Error: More than one step reads as "${stripHiddenInName(id)}" (their ids differ only in characters that do not show), so ${what} cannot tell which one is meant. Rename one with rename_step first.`;
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
 * `add_step` followed by a `remove` of that same id is valid.
 */
export function applyModifications(steps: InlinePipelineStep[], modifications: StepModification[]): string | null {
  for (const mod of modifications) {
    if (mod.action === 'add_step') {
      if (steps.some(s => s.id === mod.step_id)) {
        return `Error: Step "${mod.step_id}" already exists — cannot add a duplicate id.`;
      }
      if (!mod.value) {
        return `Error: "value" (the task) is required for add_step "${mod.step_id}".`;
      }
      const inputFrom: string[] = [];
      const missing: string[] = [];
      for (const dep of mod.input_from ?? []) {
        const at = stepIndex(steps, dep);
        if (at === 'ambiguous') return ambiguousText(dep, `the input of add_step "${mod.step_id}"`);
        if (at === 'missing') missing.push(stripHiddenInName(dep));
        else inputFrom.push(steps[at]!.id);
      }
      if (missing.length > 0) {
        return `Error: add_step "${mod.step_id}" depends on unknown step(s): ${missing.join(', ')}.`;
      }
      const newStep: InlinePipelineStep = {
        id: mod.step_id,
        task: mod.value,
        ...(inputFrom.length > 0 ? { input_from: inputFrom } : {}),
      };
      if (mod.after !== undefined) {
        const at = stepIndex(steps, mod.after);
        if (at === 'ambiguous') return ambiguousText(mod.after, `the insertion after it (add_step "${mod.step_id}")`);
        if (at === 'missing') return `Error: add_step "${mod.step_id}" requests insertion after "${stripHiddenInName(mod.after)}", which does not exist.`;
        steps.splice(at + 1, 0, newStep);
      } else {
        steps.push(newStep);
      }
      continue;
    }

    const what = mod.action === 'remove' ? 'removal' : mod.action === 'update_task' ? 'task update' : 'renaming';
    const idx = stepIndex(steps, mod.step_id);
    if (idx === 'ambiguous') return ambiguousText(mod.step_id, what);
    if (idx === 'missing') return `Error: Step "${stripHiddenInName(mod.step_id)}" not found for ${what}.`;

    if (mod.action === 'rename_step') {
      // A new id for a step, and every reference to it follows: the steps that read its output
      // (`input_from`) and the `{{<id>.…}}` references in their tasks and input templates. The way
      // out for an id stored with a character the save now refuses.
      const to = mod.value;
      if (!to) return `Error: "value" (the new id) is required for rename_step "${stripHiddenInName(mod.step_id)}".`;
      const hidden = findHiddenInName(to, 'the new id');
      if (hidden) return `Error: rename_step: the new id contains a character that renders as nothing (${hidden.codePoint}). Type the id again.`;
      const from = steps[idx]!.id;
      if (to !== from && steps.some(s => s.id === to)) return `Error: Step "${to}" already exists — cannot rename "${stripHiddenInName(from)}" to it.`;
      steps[idx]!.id = to;
      for (const s of steps) {
        if (s.input_from) s.input_from = s.input_from.map(dep => (dep === from ? to : dep));
        s.task = renamedRefs(s.task, from, to);
        if (s.input_template) s.input_template = renamedInTemplate(s.input_template, from, to) as Record<string, unknown>;
      }
      continue;
    }

    if (mod.action === 'remove') {
      const removedId = steps[idx]!.id;
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
  return null; // no error
}
