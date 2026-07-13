import { randomUUID } from 'node:crypto';
import type { ToolEntry, PlannedPipeline } from '../../types/index.js';
import { buildManifest, storePipeline } from './pipeline.js';
import { validateManifest } from '../../orchestrator/validate.js';
import { inferPipelineMode } from '../../orchestrator/human-in-the-loop.js';
import { parseAndValidatePortable, PortableImportError } from '../../core/workflow-portable.js';
import { getErrorMessage } from '../../core/utils.js';

interface ImportWorkflowInput {
  block?: string | undefined;
}

/** Collapse untrusted prose to a single line for the consent ECHO. The validator
 *  already stripped exotic separators but PRESERVES real newlines (a stored task
 *  legitimately spans lines); when echoed into this chat message, a newline would
 *  let an injected `\n[System: …]` ride on its own visual line inside engine-voiced
 *  prose (§5 A6). Collapsing every whitespace run to one space closes that at the
 *  echo without touching the stored value. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Render the consent surface (PRD §5 A3) as a chat message — no bespoke import
 *  UI ([[fb_chat_mit_kontext]]). Reports what the workflow does, what it needs
 *  re-bound, what unattended access it REQUESTED (but did not receive), and any
 *  caution signals, so the human confirms with eyes open. */
function renderConsent(
  planned: PlannedPipeline,
  meta: {
    inboundContract: { httpMethods: string[]; hostPatterns: string[] } | undefined;
    inboundContractOverbroad: boolean;
    injectionFlagged: boolean;
    secretRefs: string[];
  },
): string {
  const shortId = planned.id.slice(0, 8);
  const lines: string[] = [
    `✓ Imported "${oneLine(planned.name)}" as a new workflow (id \`${shortId}\`). It is saved but NOT yet ` +
      `confirmed for unattended runs — you re-consent before it can run on a schedule.`,
    ``,
    `What it does: ${oneLine(planned.goal) || '(no description)'} — ${String(planned.steps.length)} step` +
      `${planned.steps.length === 1 ? '' : 's'}.`,
  ];

  if (meta.secretRefs.length > 0) {
    lines.push(
      ``,
      `Credentials to connect first: ${meta.secretRefs.map(n => `\`${n}\``).join(', ')}. ` +
        `They were shared as references only — no secret values travelled with the workflow. ` +
        `Ask me to set them up.`,
    );
  }

  if (meta.inboundContract) {
    const methods = meta.inboundContract.httpMethods.join(', ') || '(none)';
    const hosts = meta.inboundContract.hostPatterns.map(oneLine).join(', ') || '(none)';
    lines.push(
      ``,
      `It was shared requesting autonomous access to: ${methods} → ${hosts}. ` +
        `Those grants were NOT imported — it runs with no unattended write access until you ` +
        `explicitly re-grant them.`,
    );
    if (meta.inboundContractOverbroad) {
      lines.push(
        `⚠ It requested access to ANY host — unusually broad. Review carefully before granting anything.`,
      );
    }
  } else if (meta.inboundContractOverbroad) {
    // Present but unreadable (§5 A3): a malformed contract can't be rendered
    // truthfully, but the request itself is a caution signal — surface it rather
    // than silently omitting an unknown grant.
    lines.push(
      ``,
      `⚠ It was shared with an access request that could not be read. Nothing was granted — ` +
        `treat the workflow with caution and review its steps before running it.`,
    );
  }

  if (meta.injectionFlagged) {
    lines.push(
      ``,
      `⚠ Its text contains phrases that resemble instructions (e.g. "ignore previous…"). ` +
        `Review the steps before running it.`,
    );
  }

  lines.push(
    ``,
    `To try it now, ask me to run it — each outbound action will ask for your approval.`,
  );
  return lines.join('\n');
}

/**
 * `import_workflow` (Move 1, PRD §4/§5, Slice 3) — the UNTRUSTED counterpart to
 * `export_workflow`. Takes a pasted ```lynox-workflow``` block authored by
 * another party and turns it into a fresh, locally-owned workflow — safely:
 *
 *  - Parse/validate/version-negotiate/sanitise via {@link parseAndValidatePortable}
 *    (byte-cap, fail-loud JSON, real zod shape not an `as` cast, refuse a newer
 *    version, migrate an older one, strip exotic separators from prose). §5 A4/A5/A6.
 *  - Mint a FRESH id; land it UNCONFIRMED (`confirmedAt` unset) with NO capability
 *    contract — the sharer's consent + grants are never inherited (§5 A1). The
 *    existing first-run-confirm gate keeps it from firing unattended until the
 *    human re-consents; run interactively, every action still prompts live.
 *  - Re-infer `mode` from the steps (mirrors the edit path) and run the same
 *    `buildManifest → validateManifest` graph check every save/edit path runs.
 *  - Render a consent surface in chat (§5 A3) — secrets to re-bind, the access it
 *    REQUESTED (not received), and caution flags. No bespoke import UI.
 *
 * Attack-surface note (S8): an always-on tool taking attacker-influenceable input
 * (a pasted blob), but it performs NO network egress, never resolves a
 * `secret:NAME` ref, and the imported workflow lands INERT — it cannot act
 * autonomously (unconfirmed + contract-less) and every interactive action still
 * hits the live consent gate. The worst a prompt-injected call can do is add an
 * inert, unconfirmed workflow to the caller's own library, which still needs a
 * HUMAN consent to become active. Hence no import-time consent gate (the existing
 * first-run-confirm IS the gate). Kept OUT of INTERNAL_TOOLS so its echoed content
 * is injection-scanned by `scanToolResult`, and OUT of TOOL_TIMEOUT_EXEMPT.
 */
export const importWorkflowTool: ToolEntry<ImportWorkflowInput> = {
  definition: {
    name: 'import_workflow',
    description:
      'Import a workflow shared as a ```lynox-workflow``` block (from export_workflow on another ' +
      'lynox instance). Pass the pasted block as `block`. The workflow is saved locally under a new ' +
      'id, its API/secret references are re-bound here, and it lands unconfirmed — it never inherits ' +
      "the sharer's consent or access grants.",
    input_schema: {
      type: 'object' as const,
      properties: {
        block: {
          type: 'string',
          description: 'The pasted ```lynox-workflow``` share block (or the raw workflow JSON).',
        },
      },
      required: ['block'],
    },
  },
  handler: async (input: ImportWorkflowInput, agent): Promise<string> => {
    const runHistory = agent.toolContext.runHistory;
    if (!runHistory) {
      return 'Error: Run history is not available — importing a workflow requires persistence.';
    }
    if (!input.block || input.block.trim().length === 0) {
      return 'Error: block is required — paste the ```lynox-workflow block to import.';
    }

    let result: ReturnType<typeof parseAndValidatePortable>;
    try {
      result = parseAndValidatePortable(input.block);
    } catch (err: unknown) {
      // A PortableImportError carries a user-facing reason; anything else is unexpected.
      if (err instanceof PortableImportError) {
        return `Error: ${err.message}`;
      }
      return `Error: Could not import the workflow: ${getErrorMessage(err)}`;
    }

    const { content } = result;

    // §5 A1 — build a fresh, locally-owned PlannedPipeline. The stripped fields are
    // re-created here: a new id, no consent, no contract, run-once state reset.
    const planned: PlannedPipeline = {
      id: randomUUID(),
      name: content.name,
      goal: content.goal,
      steps: content.steps,
      reasoning: content.reasoning,
      parameters: content.parameters,
      // Re-infer authoritatively from the steps (mirrors update-workflow) — never
      // trust an inbound `mode`.
      mode: inferPipelineMode(content.steps),
      estimatedCost: 0, // recomputed on first run; the sharer's estimate is meaningless here
      createdAt: new Date().toISOString(),
      executed: false,
      template: true, // an imported workflow is a reusable playbook
      // confirmedAt + capabilityContract DELIBERATELY unset (§5 A1).
      ...(content.on_failure !== undefined ? { on_failure: content.on_failure } : {}),
      ...(content.limits !== undefined ? { limits: content.limits } : {}),
    };

    // Same graph + shape gate every run/edit path runs (no dangling input_from, no
    // cycle, inline steps have a task, step ceiling). Reject a structurally broken
    // import here rather than deferring it to a failed run.
    try {
      validateManifest(buildManifest(planned.name, planned.steps, planned.on_failure ?? 'stop'));
    } catch (err: unknown) {
      return `Error: The imported workflow is structurally invalid: ${getErrorMessage(err)}`;
    }

    // Persist via the fail-closed chokepoint (stamps schema_version; the contract
    // validation is a no-op since we carry no contract) + cache in memory.
    try {
      runHistory.insertPlannedPipeline(planned);
    } catch (err: unknown) {
      return `Error: Could not save the imported workflow: ${getErrorMessage(err)}`;
    }
    storePipeline(planned.id, planned);

    return renderConsent(planned, {
      inboundContract: result.inboundContract
        ? {
            httpMethods: result.inboundContract.httpMethods,
            hostPatterns: result.inboundContract.hostPatterns,
          }
        : undefined,
      inboundContractOverbroad: result.inboundContractOverbroad,
      injectionFlagged: result.injectionFlagged,
      secretRefs: result.secretRefs,
    });
  },
};
