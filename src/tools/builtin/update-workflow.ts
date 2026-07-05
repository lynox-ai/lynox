import type { ToolEntry, InlinePipelineStep, PlannedPipeline } from '../../types/index.js';
import { applyModifications, type StepModification } from '../../orchestrator/workflow-edit.js';
import { getPipeline, forgetPipeline, buildManifest } from './pipeline.js';
import { inferPipelineMode } from '../../orchestrator/human-in-the-loop.js';
import { MAX_STEPS, validateManifest } from '../../orchestrator/validate.js';
import { validateContractAgainstSteps } from '../../orchestrator/contract-validation.js';
import { getErrorMessage } from '../../core/utils.js';

interface UpdateWorkflowInput {
  workflow_id?: string | undefined;
  modifications?: StepModification[] | undefined;
  confirm?: boolean | undefined;
}

/**
 * `update_workflow_steps` (Slice C, §4.6) — the real backend write-path for
 * editing a SAVED workflow's steps. The agent uses this when the user opens an
 * "💬 Bearbeiten" chat and asks for a change ("add a step that emails the
 * summary", "drop step 3"); there is no bespoke step-editor form. It applies the
 * edits to a deep copy, re-validates (step count, unique ids, capability
 * contract), re-infers the interaction mode, persists, and evicts the cache.
 *
 * Marked `destructive: data` so it WARNS in a live chat (the user is editing a
 * persistent playbook) and is BLOCKED autonomously — a headless workflow run can
 * never rewrite itself or another saved workflow.
 *
 * The destructive-edit guard (U5): if the workflow is currently scheduled,
 * editing changes its next run, so the tool refuses without `confirm:true` and
 * the agent surfaces that to the user. A contract-governed edit additionally
 * resets the first-run-confirm (the human consented to the OLD steps).
 */
export const updateWorkflowTool: ToolEntry<UpdateWorkflowInput> = {
  definition: {
    name: 'update_workflow_steps',
    description:
      'Edit + save a stored workflow\'s steps. Re-validates and re-infers whether it can still run ' +
      'unattended. Scheduled workflow → needs confirm:true.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Saved workflow id.' },
        modifications: {
          type: 'array',
          description: 'Ordered step edits.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['remove', 'update_task', 'add_step'] },
              step_id: { type: 'string', description: 'Target step id; the new id for add_step.' },
              value: { type: 'string', description: 'New task text (update_task / add_step).' },
              input_from: { type: 'array', items: { type: 'string' }, description: 'add_step: dependency step ids.' },
              after: { type: 'string', description: 'add_step: insert after this step id (default: append).' },
            },
            required: ['action', 'step_id'],
          },
        },
        confirm: { type: 'boolean', description: 'Proceed when the workflow is scheduled.' },
      },
      required: ['workflow_id', 'modifications'],
    },
  },
  destructive: { mode: 'data' },
  handler: async (input: UpdateWorkflowInput, agent): Promise<string> => {
    const runHistory = agent.toolContext.runHistory;
    if (!runHistory) {
      return 'Error: Run history is not available — editing a saved workflow requires persistence.';
    }
    if (!input.workflow_id) return 'Error: workflow_id is required.';
    if (!input.modifications || input.modifications.length === 0) {
      return 'Error: At least one modification is required.';
    }

    const planned = getPipeline(input.workflow_id, runHistory);
    if (!planned) {
      return `Error: Workflow "${input.workflow_id}" not found.`;
    }
    // Only SAVED workflows (templates) are editable. A one-shot plan_task
    // pipeline is a transient run, not a reusable playbook.
    if (planned.template !== true) {
      return `Error: "${planned.id}" is a one-shot run, not a saved workflow, so it cannot be edited. Save it as a workflow first.`;
    }

    // Destructive-edit guard (U5): editing a scheduled workflow changes what its
    // next run does — require explicit confirmation the agent relays to the user.
    const activeTriggers = runHistory.getTriggersByPipelineId(planned.id);
    if (activeTriggers.length > 0 && input.confirm !== true) {
      const cronCount = activeTriggers.filter(t => t.schedule_cron).length;
      const confirmResetNote = planned.confirmedAt
        ? ' The edit also resets its first-run-confirm — the schedule pauses until it is re-confirmed.'
        : '';
      return (
        `⚠️ This workflow is scheduled (${activeTriggers.length} active task${activeTriggers.length === 1 ? '' : 's'}` +
        `${cronCount > 0 ? `, ${cronCount} on a cron` : ''}) — editing its steps changes what the next run does. ` +
        `Confirm with the user, then call update_workflow_steps again with "confirm": true.${confirmResetNote}`
      );
    }

    // Apply edits to a deep copy — discarded on any validation error below. The
    // copy clones each step's `input_from` array too (not just the step object),
    // so applyModifications can never mutate an array that aliases the cached
    // `planned` (which would corrupt the in-memory pipelineStore even on abort).
    const steps: InlinePipelineStep[] = planned.steps.map(s => ({
      ...s,
      ...(s.input_from ? { input_from: [...s.input_from] } : {}),
    }));
    const modErr = applyModifications(steps, input.modifications);
    if (modErr) return modErr;

    if (steps.length === 0) {
      return 'Error: The edit would remove every step. A workflow needs at least one step.';
    }
    if (steps.length > MAX_STEPS) {
      return `Error: The edit exceeds the maximum of ${MAX_STEPS} steps (got ${steps.length}).`;
    }
    const seen = new Set<string>();
    for (const s of steps) {
      if (seen.has(s.id)) return `Error: Duplicate step id "${s.id}" after the edit.`;
      seen.add(s.id);
    }

    // Graph parity with every RUN path: validate the edited steps as a manifest
    // (zod shape + dependency-graph check — no dangling input_from, no cycle)
    // BEFORE persisting, so a structurally broken edit is rejected here at save
    // rather than deferred to a failed cron run. The run-volatile path validates
    // the same way (executePipelineById → buildManifest → validateManifest).
    try {
      validateManifest(buildManifest(planned.name, steps, planned.on_failure ?? 'stop'));
    } catch (err: unknown) {
      return `Error: The edit produces an invalid workflow: ${getErrorMessage(err)}`;
    }

    // Re-infer the interaction mode: adding an ask_user step flips an autonomous
    // (cron-eligible) workflow to interactive, which can no longer run headless.
    const newMode = inferPipelineMode(steps);
    const updated: PlannedPipeline = { ...planned, steps, mode: newMode };

    // Re-validate the capability contract against the edited steps: an edit that
    // routes a new {{params.x}} the contract doesn't constrain into a tool call
    // reopens the S1 re-target vector → reject before persisting.
    const contractErr = validateContractAgainstSteps(updated);
    if (contractErr) return contractErr;

    // Any step edit invalidates the human's first-run consent (given against
    // the OLD steps), so clear `confirmedAt` whenever it was set. The interactive
    // run_workflow path already refuses to run a workflow whose `confirmedAt` is
    // unset; the autonomous/scheduled worker-loop enforcement is the deferred
    // scheduling-consent slice (see `types/pipeline.ts` — not yet load-bearing).
    // This reset is the defense-in-depth that makes an edited workflow re-require
    // consent once that gate lands. A no-op for an unconfirmed workflow.
    const wasConfirmed = planned.confirmedAt !== undefined;
    if (wasConfirmed) {
      updated.confirmedAt = undefined;
    }

    // Persist (INSERT OR REPLACE, same id) — insertPlannedPipeline re-runs the
    // fail-closed contract validation at the chokepoint as a backstop — then
    // evict the in-memory cache so the next getPipeline re-reads the edited row.
    try {
      runHistory.insertPlannedPipeline(updated);
    } catch (err: unknown) {
      return `Error: Could not save the edited workflow: ${getErrorMessage(err)}`;
    }
    forgetPipeline(planned.id);

    const modeNote = newMode !== planned.mode
      ? ` Mode changed ${planned.mode} → ${newMode}.${newMode === 'interactive' ? ' ⚠️ It is now interactive and can no longer run on a cron/schedule.' : ''}`
      : '';
    const confirmNote = wasConfirmed
      ? ' Its first-run-confirm was reset — re-confirm before the next scheduled run.'
      : '';
    const stepList = steps.map((s, i) => `${i + 1}. ${s.id}: ${s.task}`).join('\n');
    return `✓ Updated workflow "${planned.name}" (${steps.length} step${steps.length === 1 ? '' : 's'}).${modeNote}${confirmNote}\n\n${stepList}`;
  },
};
