/**
 * Step references in a step's task and input template (`{{<id>.result}}`), checked against the step
 * list before a save and before a run. A reference resolves only from the run's context: the steps a
 * step lists in `input_from`, `params`, and the run's own context keys (`context.ts`). One that does
 * not resolve stays as raw text in what the step reads, and the run goes on without that input, so a
 * reference no run can resolve is refused instead, as an `input_from` entry naming no step is.
 *
 * A refusal names the step by its position and the field (`step #3 (steps[2].task)`), and a
 * referenced name only when it has the step id shape: the model reads this text, so it carries no
 * other stored or typed text back (`step-id.ts`).
 */
import { isStepIdShape } from './step-id.js';

interface RefStep {
  id: string;
  task?: string | undefined;
  input_from?: string[] | undefined;
  input_template?: Record<string, unknown> | undefined;
}

/** The same placeholder `resolveTaskTemplate` and `resolveInputTemplate` substitute. */
const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

/** Every reference path in `text`, trimmed as the resolvers trim it. */
function referencePaths(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map(m => m[1]!.trim());
}

/** Every string leaf of an input template with its path below `input_template`. A key is part of
 *  the path only when it has the step id shape; any other key is stored text and is named by its
 *  position among its siblings instead (`step-id.ts`). */
function templateStrings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => templateStrings(v, `${path}[${String(i)}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v], i) =>
      templateStrings(v, isStepIdShape(k) ? `${path}.${k}` : `${path}.<key #${String(i + 1)}>`));
  }
  return [];
}

/** The first field of `step` (`task`, `input_template.<path>`) with a reference to the output of `id`, or null. */
export function fieldReferencing(step: RefStep, id: string): string | null {
  const fields: Array<[string, string]> = [];
  if (typeof step.task === 'string') fields.push(['task', step.task]);
  if (step.input_template) fields.push(...templateStrings(step.input_template, 'input_template'));
  for (const [field, text] of fields) {
    if (referencePaths(text).some(ref => ref.split('.')[0] === id)) return field;
  }
  return null;
}

/** A referenced step as a refusal shows it: its id when that has the step id shape, otherwise described. */
function shownStep(name: string): string {
  return isStepIdShape(name) ? `step "${name}"` : 'a step whose id is outside the allowed form';
}

/**
 * Why the first reference in `steps` that no run can resolve is refused, or null.
 *
 * - A reference whose first part is another step's id must have that step in its own `input_from`:
 *   the context holds only those steps' outputs.
 * - A reference to the step's own output never resolves: a step cannot read itself.
 * - A reference `{{<name>.result…}}` whose name is no step, not `params` and no key of `context` names
 *   a step that is not there (a typo, a step renamed by hand, one removed).
 *
 * Any other name may be a context key a run supplies (`{{customer}}` in an inline run), so it is left
 * to the run. `context` is the run's context where it is known; at a save it is not, and such a name
 * passes there.
 */
export function templateRefIssue(
  steps: readonly RefStep[],
  context?: Readonly<Record<string, unknown>>,
  path = 'steps',
): string | null {
  const ids = new Set(steps.map(s => s.id));
  for (const [i, step] of steps.entries()) {
    const fields: Array<[string, string]> = [];
    if (typeof step.task === 'string') fields.push(['task', step.task]);
    if (step.input_template) fields.push(...templateStrings(step.input_template, 'input_template'));
    for (const [field, text] of fields) {
      for (const ref of referencePaths(text)) {
        const [name = '', second] = ref.split('.');
        if (name === 'params' || (context !== undefined && Object.hasOwn(context, name))) continue;
        const where = `step #${String(i + 1)} (${path}[${String(i)}].${field})`;
        // An input template cannot be edited in a saved workflow; a task can (update_task). Removing the
        // step is the way that loses the most, so it is named last, and alone only with the user's word.
        const removeOnly = `Its input template cannot be edited. Remove step #${String(i + 1)} only if the user wants that step gone; `
          + 'otherwise tell the user this step cannot run as written.';
        const inTemplate = field !== 'task';
        if (name === step.id) {
          return `${where}: it refers to this step's own output, which no run has yet. `
            + (inTemplate ? removeOnly : 'Refer to an earlier step, listed in input_from, or leave the reference out.');
        }
        if (ids.has(name)) {
          if ((step.input_from ?? []).includes(name)) continue;
          return `${where}: it refers to the output of ${shownStep(name)}, which is not in this step's input_from, so the reference would stay unresolved. `
            + `Add ${isStepIdShape(name) ? `"${name}"` : `step #${String(steps.findIndex(s => s.id === name) + 1)}`} to this step's input_from (in a saved workflow: set_input_from)`
            + (inTemplate ? '.' : ', or leave the reference out.');
        }
        if (second === 'result') {
          const missing = `${where}: it refers to the result of ${isStepIdShape(name) ? `step "${name}"` : 'a step id outside the allowed form'}, and this workflow has no such step. `;
          if (!inTemplate) return missing + "Refer to the step it should read by that step's id, and list it in input_from.";
          // No step can be renamed to an id outside the shape, so removing is the only way there.
          return missing + (isStepIdShape(name)
            ? `Its input template cannot be edited. To resolve it, rename the step it should read to "${name}" (rename_step) and add it with set_input_from, or remove step #${String(i + 1)}.`
            : removeOnly);
        }
      }
    }
  }
  return null;
}

/** The position (1-based) of the step a refusal of `templateRefIssue` names. */
export function templateRefStep(issue: string): number {
  return Number(/^step #(\d+) /.exec(issue)?.[1] ?? '0');
}
