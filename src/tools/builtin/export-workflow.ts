import type { ToolEntry } from '../../types/index.js';
import { getPipeline } from './pipeline.js';
import { toPortableWorkflow } from '../../core/workflow-portable.js';
import { getErrorMessage } from '../../core/utils.js';

interface ExportWorkflowInput {
  workflow_id?: string | undefined;
}

/** Info-string tagging the export code-fence — the Slice-3 import path recognises
 *  exactly this tag on the opening fence line. The FENCE ITSELF is dynamic-length
 *  (see {@link buildFence}): CommonMark requires a fenced block's fence to be longer
 *  than any backtick run inside it, so an exported workflow whose step text or
 *  reasoning contains a literal ``` cannot prematurely close the block. A parser
 *  must therefore read the opening fence's backtick count and match a closing fence
 *  of at least that length — never assume three. Kept as a constant so producer +
 *  (future) parser agree on the tag. */
export const LYNOX_WORKFLOW_INFO_STRING = 'lynox-workflow';

/** Smallest backtick fence that safely wraps `body`: at least three, and always
 *  longer than the longest backtick run inside it (CommonMark fenced-code rule).
 *  JSON does not escape backticks, so a step task like "run the ```sh``` block"
 *  travels verbatim — without this, a fixed ``` fence would close early and the
 *  copy-block would not round-trip as JSON. */
export function buildFence(body: string): string {
  const longestRun = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
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
