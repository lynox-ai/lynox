/**
 * Portable, shareable representation of a workflow DEFINITION (Move 1, PRD §4).
 * A saved workflow is already tenant-portable — it references APIs by hostname
 * and secrets by `secret:NAME` (never by resolved value), and carries no
 * tenant-local run state in the parts a user authors. This module turns a stored
 * {@link PlannedPipeline} into a versioned, self-describing envelope that can be
 * copied out of one instance and imported into another (Slice 3), and back-fills
 * nothing tenant-specific on the way out.
 *
 * The two invariants that make the artifact safe to hand to another party:
 *  1. It NEVER resolves a `secret:NAME` reference to its value — refs travel as
 *     refs and are re-bound on import. (They are already refs in the blob; the
 *     serializer simply copies the content verbatim and never touches the vault.)
 *  2. It STRIPS everything that authorises unattended execution or is tenant-local
 *     runtime state — the receiving instance mints a new id and re-consents
 *     (`confirmedAt` is cleared so the import cannot inherit the sharer's consent;
 *     PRD §5 A1).
 */

import type { PlannedPipeline } from '../types/pipeline.js';
import { CURRENT_PIPELINE_SCHEMA_VERSION } from './pipeline-schema-migration.js';

/**
 * Version of the SHARE ENVELOPE shape itself — the outer container
 * `{ lynox_workflow_format_version, content_schema_version, workflow }`. Orthogonal to
 * {@link CURRENT_PIPELINE_SCHEMA_VERSION} (which versions the inner workflow
 * CONTENT): the envelope can gain fields (a signature, provenance) without the
 * content model changing, and vice-versa. The Slice-3 import validator negotiates
 * BOTH independently — a newer envelope OR a newer content version is refused
 * fail-loud (PRD §5 A5).
 */
export const LYNOX_WORKFLOW_FORMAT_VERSION = 1;

/**
 * The user-authored subset of a workflow that is safe + meaningful to port to
 * another instance. Defined as a `Pick` over the canonical {@link PlannedPipeline}
 * so a rename or type change to any kept field breaks THIS at compile time (the
 * keep-list can never silently drift from the source of truth).
 *
 * Kept: the authored shape (name/goal/steps incl. `tool`/`input_template`/
 * `{{params.*}}`, reasoning), the re-target contract (`parameters`), the outbound
 * authorisation SHAPE (`capabilityContract` — re-consented on import, never
 * auto-trusted), the run contract (`mode`, `on_failure`, `limits`).
 *
 * Deliberately absent (stripped by {@link toPortableWorkflow}): `id` (re-minted on
 * import), `executed` / `createdAt` (tenant-local runtime state), `estimatedCost`
 * (re-computed for the importing tenant's pricing), `confirmedAt` (the sharer's
 * consent must NOT authorise the importer's unattended runs — §5 A1), `template`
 * (the importer decides), `schema_version` (lifted to the envelope so version
 * negotiation has a single authoritative field).
 */
export type PortableWorkflowContent = Pick<
  PlannedPipeline,
  | 'name'
  | 'goal'
  | 'steps'
  | 'reasoning'
  | 'parameters'
  | 'capabilityContract'
  | 'mode'
  | 'on_failure'
  | 'limits'
>;

/** The versioned, self-describing envelope a workflow is shared as. */
export interface PortableWorkflow {
  /** Envelope-shape version (see {@link LYNOX_WORKFLOW_FORMAT_VERSION}). Named in
   *  parallel with {@link PortableWorkflow.content_schema_version}: both are
   *  integer version axes the Slice-3 importer negotiates independently. */
  lynox_workflow_format_version: number;
  /**
   * Content-model version of {@link PortableWorkflow.workflow}. Equals the
   * exporting engine's {@link CURRENT_PIPELINE_SCHEMA_VERSION}: the serializer
   * extracts the current known field set (see {@link PortableWorkflowContent}), so
   * the emitted content is current-shaped by construction, and this is what the
   * importer negotiates against (older → migrate up; newer → refuse, §5 A5).
   */
  content_schema_version: number;
  /** The portable, tenant-neutral workflow content. */
  workflow: PortableWorkflowContent;
}

/**
 * Build the portable envelope for a stored workflow. Pure: reads only the passed
 * blob, resolves no secrets, touches no vault. Returns a fresh ENVELOPE object,
 * but its nested `workflow` fields (`steps`/`parameters`/`capabilityContract`/
 * `limits`) are shared by reference with the input — the sole caller stringifies
 * the result immediately (JSON.stringify does not mutate), so no copy is warranted;
 * a future caller that MUTATES the returned graph must clone first. Optional fields
 * are only attached when present, honouring `exactOptionalPropertyTypes`.
 */
export function toPortableWorkflow(planned: PlannedPipeline): PortableWorkflow {
  // Required kept fields (present on every well-formed PlannedPipeline; legacy
  // rows are backfilled at read — see backfillPlannedPipelineDefaults).
  const workflow: PortableWorkflowContent = {
    name: planned.name,
    goal: planned.goal,
    steps: planned.steps,
    reasoning: planned.reasoning,
    parameters: planned.parameters,
    mode: planned.mode,
  };
  // Optional kept fields — attach only when set (exactOptionalPropertyTypes).
  if (planned.capabilityContract !== undefined) {
    workflow.capabilityContract = planned.capabilityContract;
  }
  if (planned.on_failure !== undefined) {
    workflow.on_failure = planned.on_failure;
  }
  if (planned.limits !== undefined) {
    workflow.limits = planned.limits;
  }

  return {
    lynox_workflow_format_version: LYNOX_WORKFLOW_FORMAT_VERSION,
    content_schema_version: CURRENT_PIPELINE_SCHEMA_VERSION,
    workflow,
  };
}
