import type { ToolEntry } from '../../types/index.js';
import { getPipeline } from './pipeline.js';
import { toPortableWorkflow, buildFence, LYNOX_WORKFLOW_INFO_STRING } from '../../core/workflow-portable.js';
import { getErrorMessage } from '../../core/utils.js';

// The share-format constants (info-string + dynamic fence builder) live in core
// alongside the envelope + import validator so producer and parser can never drift.

interface ExportWorkflowInput {
  workflow_id?: string | undefined;
}

/**
 * `export_workflow` (Move 1, PRD §4) — turn a SAVED workflow into a portable,
 * copy-pasteable share block. Reads the stored definition, strips tenant-local
 * runtime + consent state via {@link toPortableWorkflow}, and returns a fenced
 * ```lynox-workflow``` block the user can paste into another lynox instance
 * (which re-mints the id, re-binds hosts/secrets, and re-consents on import).
 *
 * There is NO bespoke export/share UI — sharing is a chat capability (the agent
 * has the workflow loaded as context and emits the block). The block is the
 * artifact; the user copies it.
 *
 * Attack-surface note (S8): this is an always-on agent tool, but a low-surface
 * one — it reads the caller's OWN saved workflow and emits a block into the
 * caller's OWN chat. It performs no network egress, is not destructive, and (via
 * `toPortableWorkflow`) never resolves a `secret:NAME` ref to its value, so a
 * prompt-injected call can at worst surface a definition the tenant already owns,
 * with secrets as refs. Hence no consent gate (read-only own-data).
 */
export const exportWorkflowTool: ToolEntry<ExportWorkflowInput> = {
  definition: {
    name: 'export_workflow',
    description:
      'Export a saved workflow as a portable share block. Returns a ```lynox-workflow``` ' +
      'block the user can copy and import into another lynox instance. API connections and ' +
      'secrets travel as references (never values) and are re-bound on import.',
    input_schema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Saved workflow id to export.' },
      },
      required: ['workflow_id'],
    },
  },
  handler: async (input: ExportWorkflowInput, agent): Promise<string> => {
    const runHistory = agent.toolContext.runHistory;
    if (!runHistory) {
      return 'Error: Run history is not available — exporting a saved workflow requires persistence.';
    }
    if (!input.workflow_id) return 'Error: workflow_id is required.';

    const planned = getPipeline(input.workflow_id, runHistory);
    if (!planned) {
      return `Error: Workflow "${input.workflow_id}" not found.`;
    }
    // Only SAVED workflows (templates) are shareable. A one-shot plan_task
    // pipeline is a transient run, not a reusable playbook worth porting.
    if (planned.template !== true) {
      return `Error: "${planned.id}" is a one-shot run, not a saved workflow, so it cannot be exported. Save it as a workflow first.`;
    }

    let block: string;
    try {
      const portable = toPortableWorkflow(planned);
      block = JSON.stringify(portable, null, 2);
    } catch (err: unknown) {
      return `Error: Could not serialize the workflow for export: ${getErrorMessage(err)}`;
    }

    const fence = buildFence(block);
    return (
      `✓ Exported "${planned.name}" as a portable workflow. Copy the block below and paste it ` +
      `into another lynox instance to import it — its API connections and secrets are re-bound ` +
      `there, so nothing sensitive travels with it.\n\n` +
      `${fence}${LYNOX_WORKFLOW_INFO_STRING}\n${block}\n${fence}`
    );
  },
};
