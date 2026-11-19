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
import { placeholders } from './placeholders.js';
import { isReservedStepId, isStepIdShape, reservedStepIdRefusal } from './step-id.js';

interface RefStep {
  id: string;
  task?: string | undefined;
  input_from?: string[] | undefined;
  input_template?: Record<string, unknown> | undefined;
}

/** Every reference path in `text` (the placeholders `resolveTaskTemplate` and `resolveInputTemplate`
 *  substitute), trimmed as the resolvers trim it. */
function referencePaths(text: string): string[] {
  return placeholders(text).map(p => p.inner.trim());
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

/** Whether a placeholder path may be quoted back: one or two parts, each in the step id shape. */
function quotablePlaceholder(ref: string): boolean {
  const parts = ref.split('.');
  return parts.length <= 2 && parts.every(isStepIdShape);
}

/** A referenced step as a refusal shows it: its id when that has the step id shape, otherwise described. */
function shownStep(name: string): string {
  return isStepIdShape(name) ? `step "${name}"` : 'a step whose id is outside the allowed form';
}

/**
 * Why a run of `steps` in `context` is refused before its first step, or null. The runner asks this of
 * every manifest it runs, a nested pipeline's included, so no caller skips it:
 *
 * - A step whose id is reserved (`RESERVED_STEP_IDS`), or is a key the run's context already holds:
 *   its output would take that key's place in each step that reads it (`buildStepContext`), so a
 *   reference meant for the context value would read the step's output. A stored workflow can hold
 *   such an id from before a save refused it; it is renamed with `rename_step`.
 * - A reference no run resolves ({@link templateRefIssue}).
 *
 * A step is named by its position and the field, never by its id: in a nested pipeline or a direct
 * call the id is not checked against the shape before this.
 */
export function runStepsIssue(
  steps: readonly RefStep[],
  context: Readonly<Record<string, unknown>> = {},
  path = 'agents',
): string | null {
  for (const [i, step] of steps.entries()) {
    const where = `step #${String(i + 1)} (${path}[${String(i)}].id)`;
    if (isReservedStepId(step.id)) {
      return `${reservedStepIdRefusal(where, { refs: false })} In a saved workflow, rename the step with rename_step; the steps that read it follow.`;
    }
    if (Object.hasOwn(context, step.id)) {
      return `${where}: the run's context already holds a value under this step's id, and the step's output would take its place. Give the step another id, or the value another name.`;
    }
  }
  return templateRefIssue(steps, context, path);
}

/**
 * Why the first reference in `steps` that no run can resolve is refused, or null.
 *
 * - A reference whose first part is another step's id must have that step in its own `input_from`:
 *   the context holds only those steps' outputs.
 * - A reference to the step's own output never resolves: a step cannot read itself.
 * - A reference `{{<name>.result…}}` in a task whose name is no step, not `params` and no key of
 *   `context` names a step that is not there (a typo, a step renamed by hand, one removed). In an input
 *   template it passes: those are a tool's arguments, which may hand such a placeholder on as text to
 *   the system the tool writes to (a mail merge), as a run does when the name is no step.
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
          const named = isStepIdShape(name) ? `"${name}"` : `step #${String(steps.findIndex(s => s.id === name) + 1)}`;
          return `${where}: it refers to the output of ${shownStep(name)}, which is not in this step's input_from, so the reference would stay unresolved. `
            + `Add ${named} to this step's input_from (in a saved workflow: set_input_from)`
            // In a tool's argument it may be text for the system the tool writes to: renaming the step
            // it matches leaves that text as written (`rename_step` rewrites only the steps that read it).
            // The placeholder is quoted only as `<id>.<part>`, each in the step id shape (`step-id.ts`),
            // so it stays as short as two ids; any longer one is described.
            + (inTemplate
              ? `. If ${quotablePlaceholder(ref) ? `"{{${ref}}}"` : 'the placeholder'} is text for the system the tool writes to (for example a mail-merge field), `
                + `not this workflow's step, rename ${isStepIdShape(name) ? `step "${name}"` : named} (rename_step) so its id no longer matches; `
                + 'the text then stays as written. If you cannot tell which is meant, ask the user.'
              : ', or leave the reference out.');
        }
        if (second === 'result' && !inTemplate) {
          return `${where}: it refers to the result of ${isStepIdShape(name) ? `step "${name}"` : 'a step id outside the allowed form'}, and this workflow has no such step. `
            + "Refer to the step it should read by that step's id, and list it in input_from.";
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
