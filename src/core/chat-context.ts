import type { RunHistory } from './run-history.js';
import type { PlannedPipeline } from '../types/index.js';

/**
 * A typed reference to an object a chat is opened ON — the payload of the
 * Slice-C context-injection seam (§4.6). A "💬 Bearbeiten" button passes
 * `{kind, id}`; the server resolves it to a context preamble it prepends to the
 * user's first message, so the agent has the object loaded without the user
 * pasting it. This is the reusable entry — any future "discuss this X"
 * affordance passes the same shape and the server owns how each `kind` renders.
 * `workflow` = a saved workflow to edit ("💬 Bearbeiten"); `run` = a (failed)
 * workflow run to diagnose + fix ("💬 Fixen").
 */
export interface ChatContextRef {
  kind: 'workflow' | 'run';
  id: string;
}

const MAX_STEP_TASK_CHARS = 280;
const MAX_NAME_CHARS = 200;
const MAX_STEP_ID_CHARS = 80;
const MAX_ERR_CHARS = 500;

/**
 * Collapse control characters (incl. newlines/tabs) to spaces and clamp the
 * length. The preamble interpolates user/agent-authored fields (the workflow
 * name, step ids, step tasks) into a multi-line block that OPENS with a
 * trusted-looking `[Loaded …]` marker; without this, a crafted name/task
 * carrying an embedded line break + a fake `[System: …]` line could inject
 * pseudo-system text that reads as a server directive. Provenance of these
 * fields is not guaranteed user-authored (a prior agent run, an import, or a
 * sync can write them), so sanitise always. The character class covers ASCII
 * control chars AND the Unicode line/paragraph separators U+2028/U+2029 +
 * DEL (U+007F), which JS and many model tokenizers treat as line breaks but a
 * plain `[\r\n]` class misses.
 */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Resolve a context reference to a preamble string, or null when it can't be
 * loaded (no run history, unknown id, or a non-template one-shot run that isn't
 * an editable saved workflow). Best-effort by design: the caller prepends a
 * non-null result to the task and otherwise just runs the chat normally, so a
 * stale/foreign id degrades to a plain chat rather than an error. Single-tenant
 * container ⇒ every id resolved here is the tenant's own.
 */
export function resolveChatContext(runHistory: RunHistory | null, ref: ChatContextRef): string | null {
  if (!runHistory) return null;

  if (ref.kind === 'workflow') {
    const row = runHistory.getPlannedPipeline(ref.id);
    if (!row) return null;
    let wf: PlannedPipeline;
    try {
      wf = JSON.parse(row.manifest_json) as PlannedPipeline;
    } catch {
      return null;
    }
    if (wf.template !== true) return null; // only saved workflows are editable
    const steps = (wf.steps ?? [])
      .map((s, i) => `  ${i + 1}. [${oneLine(s.id, MAX_STEP_ID_CHARS)}] ${oneLine(s.task ?? '', MAX_STEP_TASK_CHARS)}`)
      .join('\n');
    return (
      `[Loaded saved workflow for editing — id: ${wf.id}]\n` +
      `Name: "${oneLine(wf.name, MAX_NAME_CHARS)}"\n` +
      `Mode: ${wf.mode ?? 'autonomous'}${wf.capabilityContract ? ' · contract-governed' : ''}\n` +
      `Steps:\n${steps}\n\n` +
      `To change it, call update_workflow_steps with workflow_id "${wf.id}". ` +
      `Confirm destructive edits with the user first.`
    );
  }

  // ref.kind === 'run' — a (failed) workflow run to diagnose + fix in chat.
  const run = runHistory.getPipelineRun(ref.id);
  if (!run) return null;
  const stepResults = runHistory.getPipelineStepResults(run.id);
  const trace = stepResults
    .map(s => `  [${s.status}] ${oneLine(s.step_id, MAX_STEP_ID_CHARS)}${s.error ? ` — ${oneLine(s.error, MAX_ERR_CHARS)}` : ''}`)
    .join('\n');
  const hasFailure = run.status === 'failed' || stepResults.some(s => s.status === 'failed' || s.error);
  // Only point at the editable workflow if it still exists — a run can outlive a
  // deleted workflow, and naming a gone id would dead-end the fix.
  const wfExists = !!run.workflow_id && runHistory.getPlannedPipeline(run.workflow_id) !== undefined;
  return (
    `[Loaded workflow run — id: ${run.id}]\n` +
    `Workflow: "${oneLine(run.manifest_name, MAX_NAME_CHARS)}"${run.workflow_id ? ` (id: ${run.workflow_id})` : ''}\n` +
    `Status: ${run.status}${run.error ? `\nError: ${oneLine(run.error, MAX_ERR_CHARS)}` : ''}\n` +
    (trace ? `Steps:\n${trace}\n` : '') +
    (hasFailure
      ? `\nDiagnose with diagnose_workflow_run (run_id "${run.id}")` +
        (wfExists ? `, fix with update_workflow_steps (workflow_id "${run.workflow_id}"), then re-run with run_workflow.` : '.')
      : '')
  );
}
