import type { ToolEntry } from '../../types/index.js';

interface DiagnoseInput {
  run_id?: string | undefined;
}

const MAX_ERR = 600;

/**
 * Collapse all whitespace (incl. newlines AND the Unicode line/paragraph
 * separators U+2028/U+2029, which `\s` matches) to single spaces and clamp.
 * Applied to EVERY free-text field interpolated into the result — the run/step
 * error, the workflow name, and step ids — so an embedded line break + a fake
 * `[System: …]` line can't inject a pseudo-directive into the tool output the
 * agent reads back (the result also passes through `scanToolResult`, but the
 * tool defangs at the source to match the context-seam's defence).
 */
function flat(s: string): string {
  const out = s.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  return out.length > MAX_ERR ? `${out.slice(0, MAX_ERR - 1)}…` : out;
}

/**
 * `diagnose_workflow_run` (Slice C2, §4.6) — read the persisted step-by-step
 * trace of a (usually failed) workflow run so the agent can explain what broke
 * and fix it IN CHAT. The "💬 Fixen" button and the escalation thread both put a
 * run id in front of the agent; this tool turns it into the per-step status +
 * error + cost, plus the run's source workflow id (so the agent can then call
 * `update_workflow_steps` to fix it and `run_workflow` to re-run it). Read-only.
 */
export const diagnoseWorkflowTool: ToolEntry<DiagnoseInput> = {
  definition: {
    name: 'diagnose_workflow_run',
    description:
      'Read a workflow run\'s per-step trace + error to explain why it failed. Returns the source ' +
      'workflow id so you can fix it with update_workflow_steps and re-run it with run_workflow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'The run id to diagnose (from the loaded run context / escalation).' },
      },
      required: ['run_id'],
    },
  },
  handler: async (input: DiagnoseInput, agent): Promise<string> => {
    const runHistory = agent.toolContext.runHistory;
    if (!runHistory) return 'Error: Run history is not available.';
    if (!input.run_id) return 'Error: run_id is required.';

    const run = runHistory.getPipelineRun(input.run_id);
    if (!run) return `Error: Run "${input.run_id}" not found.`;

    const steps = runHistory.getPipelineStepResults(run.id);
    const failed = steps.filter(s => s.status === 'failed' || s.error);

    const lines: string[] = [];
    lines.push(`Run ${run.id} — workflow "${flat(run.manifest_name)}" — status: ${run.status}`);
    if (run.workflow_id) lines.push(`Workflow id: ${run.workflow_id}`);
    if (run.error) lines.push(`Run error: ${flat(run.error)}`);
    lines.push(`Cost: $${run.total_cost_usd.toFixed(4)}`);
    lines.push('');
    if (steps.length === 0) {
      lines.push('No step results were recorded for this run.');
    } else {
      lines.push('Steps:');
      for (const s of steps) {
        const cost = `$${s.cost_usd.toFixed(4)}`;
        lines.push(`  [${s.status}] ${flat(s.step_id)} (${cost})${s.error ? ` — ${flat(s.error)}` : ''}`);
      }
    }
    lines.push('');
    // Only steer the user to edit the workflow if it still EXISTS — a run can
    // outlive a deleted workflow, and naming a gone id would send the agent into
    // a "workflow not found" dead end.
    const wfExists = !!run.workflow_id && runHistory.getPlannedPipeline(run.workflow_id) !== undefined;
    if (failed.length > 0) {
      lines.push(
        wfExists
          ? `${failed.length} step(s) failed. Fix the workflow with update_workflow_steps (workflow_id "${run.workflow_id}"), then re-run with run_workflow.`
          : run.workflow_id
            ? `${failed.length} step(s) failed. Its source workflow (${run.workflow_id}) no longer exists — recreate it before re-running.`
            : `${failed.length} step(s) failed. This was an ad-hoc run with no saved workflow to edit.`,
      );
    } else {
      lines.push('No failed steps — the run completed.');
    }
    return lines.join('\n');
  },
};
