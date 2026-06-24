import type { InlinePipelineStep } from '../types/pipeline.js';

/**
 * A single step-level edit to a workflow's step list. The vocabulary is shared
 * by two consumers so the mutation logic lives in exactly one place
 * (`applyModifications`):
 *  - the run-volatile `run_workflow` tool (modifies steps for ONE run, never
 *    persisted) — emits only `remove` / `update_task`;
 *  - the persistent `update_workflow_steps` tool (Slice C — edits + saves a
 *    stored workflow) — additionally emits `add_step`.
 */
export interface StepModification {
  action: 'remove' | 'update_task' | 'add_step';
  /** Target step id for `remove`/`update_task`; the NEW step's id for `add_step`. */
  step_id: string;
  /** New task text for `update_task`; the new step's task for `add_step`. */
  value?: string | undefined;
  /** `add_step` only — data-dependency step ids the new step reads from. */
  input_from?: string[] | undefined;
  /** `add_step` only — insert immediately AFTER this step id (default: append). */
  after?: string | undefined;
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
      if (mod.input_from && mod.input_from.length > 0) {
        const known = new Set(steps.map(s => s.id));
        const missing = mod.input_from.filter(dep => !known.has(dep));
        if (missing.length > 0) {
          return `Error: add_step "${mod.step_id}" depends on unknown step(s): ${missing.join(', ')}.`;
        }
      }
      const newStep: InlinePipelineStep = {
        id: mod.step_id,
        task: mod.value,
        ...(mod.input_from && mod.input_from.length > 0 ? { input_from: mod.input_from } : {}),
      };
      if (mod.after !== undefined) {
        const at = steps.findIndex(s => s.id === mod.after);
        if (at === -1) {
          return `Error: add_step "${mod.step_id}" requests insertion after "${mod.after}", which does not exist.`;
        }
        steps.splice(at + 1, 0, newStep);
      } else {
        steps.push(newStep);
      }
      continue;
    }

    const idx = steps.findIndex(s => s.id === mod.step_id);

    if (mod.action === 'remove') {
      if (idx === -1) {
        return `Error: Step "${mod.step_id}" not found for removal.`;
      }
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
      if (idx === -1) {
        return `Error: Step "${mod.step_id}" not found for task update.`;
      }
      if (!mod.value) {
        return 'Error: "value" is required for update_task modification.';
      }
      steps[idx]!.task = mod.value;
    }
  }
  return null; // no error
}
