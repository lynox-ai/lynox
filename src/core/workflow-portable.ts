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

import { z } from 'zod';
import type { PlannedPipeline } from '../types/pipeline.js';
import type { CapabilityContract } from '../types/capability-contract.js';
import { CURRENT_PIPELINE_SCHEMA_VERSION, migratePipelineBlob } from './pipeline-schema-migration.js';
import { MAX_STEPS } from '../orchestrator/validate.js';
import { stripUntrustedSeparators } from './sanitize.js';
import { detectInjectionAttempt } from './data-boundary.js';
import { SECRET_REF_PATTERN, isInfraSecret } from './secret-store.js';
import { isOverbroadHostPattern } from './pre-approve.js';

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

// ===========================================================================
// Import side (Slice 3) — the UNTRUSTED boundary. A pasted block is authored by
// another party; every field is hostile until validated. The pipeline is:
//   extract fenced block → byte-cap → fail-loud JSON parse → envelope shape →
//   version-negotiate (fail-loud on newer) → migrate content up to CURRENT →
//   content shape (real zod + string/step caps, NOT an `as` cast) → sanitise
//   prose → discard the sharer's contract/consent. `getPipeline`'s read path
//   trusts a bare cast and swallows parse errors — this path does neither.
// ===========================================================================

/**
 * CommonMark info-string tagging the export code-fence. The FENCE ITSELF is
 * dynamic-length (see {@link buildFence}); a parser reads the opening fence's
 * backtick count and matches a closing fence of at least that length (never
 * assumes three). The format constant lives here (core) so the serializer, the
 * export tool, and {@link extractPortableBlock} all agree on one tag.
 */
export const LYNOX_WORKFLOW_INFO_STRING = 'lynox-workflow';

/**
 * Smallest backtick fence that safely wraps `body`: at least three, and always
 * longer than the longest backtick run inside it (CommonMark fenced-code rule).
 * JSON does not escape backticks, so a step task like "run the ```sh``` block"
 * travels verbatim — without this, a fixed ``` fence would close early and the
 * copy-block would not round-trip as JSON.
 */
export function buildFence(body: string): string {
  const longestRun = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

/**
 * Hard byte-ceiling on a pasted import (PRD §5 A4). A well-formed workflow block
 * is a few KB; 256 KiB is generous headroom while bounding a paste-bomb before
 * it reaches {@link JSON.parse}. Measured in UTF-8 bytes, not code units, so a
 * multibyte payload can't slip past a length check.
 */
export const MAX_IMPORT_BYTES = 256 * 1024;

/** Per-field character caps on untrusted prose (PRD §5 A4). Bound each field so
 *  a single monster string can't blow up the model context on the run path. */
const IMPORT_CAP = {
  name: 200,
  goal: 2_000,
  reasoning: 4_000,
  task: 8_000,
  paramName: 200,
  paramDesc: 2_000,
  id: 200,
  generic: 2_000,
} as const;

/** A typed failure at the untrusted import boundary. Carries a user-facing
 *  message (safe to surface in chat) + a machine `code` for the tool to branch
 *  on. Distinct from a generic Error so the caller never mistakes a validation
 *  refusal for an internal crash. */
export class PortableImportError extends Error {
  readonly code:
    | 'too_large'
    | 'no_block'
    | 'bad_json'
    | 'bad_envelope'
    | 'version_too_new'
    | 'bad_content';
  constructor(code: PortableImportError['code'], message: string) {
    super(message);
    this.name = 'PortableImportError';
    this.code = code;
  }
}

/** What a validated import yields — the clean content plus the metadata the
 *  consent surface (PRD §5 A3) renders. The sharer's capability contract is
 *  NEVER folded into `content` (it is discarded, §5 A1); it is reported here
 *  only so the importer can SEE what the shared workflow requested. */
export interface PortableImportResult {
  /** Validated + migrated (to CURRENT) + sanitised content. Carries NO
   *  `capabilityContract` and NO `confirmedAt` — the caller mints a fresh id and
   *  re-consents. */
  content: PortableWorkflowContent;
  /** The inbound capability contract, parsed best-effort for transparency ONLY.
   *  Never stored. `undefined` when absent or unparseable. */
  inboundContract: CapabilityContract | undefined;
  /** True when the inbound contract requested a match-(nearly)-anything host
   *  grant (fleet-wide egress intent) — a caution signal for the consent surface. */
  inboundContractOverbroad: boolean;
  /** True when the sanitised prose still resembles a prompt-injection payload —
   *  surfaced as a caution in the consent step (the block echo is independently
   *  scanned by `scanToolResult`). */
  injectionFlagged: boolean;
  /** Distinct `secret:NAME` references the workflow needs re-bound on import
   *  (never values — refs only). Drives the "connect these" consent line. */
  secretRefs: string[];
}

const EnvelopeSchema = z.object({
  lynox_workflow_format_version: z.number(),
  content_schema_version: z.number(),
  workflow: z.object({}).passthrough(),
});

const HTTP_METHOD_VALUES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

/** Best-effort shape of an inbound contract — parsed for the consent render only
 *  (never stored), so it is lenient: a malformed contract does not fail the
 *  import, it is simply not rendered. */
const InboundContractSchema = z.object({
  version: z.number(),
  grantedTools: z.array(z.string().max(IMPORT_CAP.generic)).max(64),
  httpMethods: z.array(z.enum(HTTP_METHOD_VALUES)).max(HTTP_METHOD_VALUES.length),
  hostPatterns: z.array(z.string().max(IMPORT_CAP.generic)).max(64),
  pathPatterns: z.array(z.string().max(IMPORT_CAP.generic)).max(64),
  paramConstraints: z
    .record(
      z.string().max(IMPORT_CAP.paramName),
      z.object({
        enum: z.array(z.union([z.string(), z.number()])).max(256).optional(),
        regex: z.string().max(IMPORT_CAP.generic).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    )
    .default({}),
});

// The optional model/thinking/effort/role HINTS are deliberately NOT modelled
// here: they are enum-typed on `InlinePipelineStep` and casting an untrusted
// string into an engine enum would be a lie (and couples to enum drift). zod
// STRIPS them as unknown keys, so an imported step runs at the importer's own
// default model/effort — a safer, honest loss of a non-essential hint. The
// deterministic-replay pair (`tool` + `input_template`), the data-dependency
// wiring (`input_from`), and the per-step timeout ARE carried.
const ImportStepSchema = z.object({
  id: z.string().min(1).max(IMPORT_CAP.id),
  task: z.string().min(1).max(IMPORT_CAP.task),
  input_from: z.array(z.string().max(IMPORT_CAP.id)).max(MAX_STEPS).optional(),
  timeout_ms: z.number().positive().optional(),
  tool: z.string().max(IMPORT_CAP.generic).optional(),
  input_template: z.record(z.string(), z.unknown()).optional(),
});

const ImportParamSchema = z.object({
  name: z.string().min(1).max(IMPORT_CAP.paramName),
  description: z.string().max(IMPORT_CAP.paramDesc),
  type: z.enum(['string', 'number', 'date']),
  defaultValue: z.unknown().optional(),
  source: z.enum(['user_input', 'relative_date', 'context']),
});

// zod strips unknown keys by default — so a smuggled `id` / `confirmedAt` /
// `executed` / `template` / `estimatedCost` inside `workflow` is DROPPED here,
// belt-and-braces with the explicit re-mint on the build side (§5 A1).
const ImportContentSchema = z.object({
  name: z.string().min(1).max(IMPORT_CAP.name),
  goal: z.string().max(IMPORT_CAP.goal),
  steps: z.array(ImportStepSchema).min(1).max(MAX_STEPS),
  reasoning: z.string().max(IMPORT_CAP.reasoning),
  parameters: z.array(ImportParamSchema).max(64),
  // `mode` is accepted if present but NOT authoritative — the caller re-infers it
  // from the steps (mirrors the edit path), so a lie here changes nothing.
  mode: z.enum(['interactive', 'autonomous']).optional(),
  // Accept any shape; parsed separately for the consent render, then discarded.
  capabilityContract: z.unknown().optional(),
  on_failure: z.enum(['stop', 'continue', 'notify']).optional(),
  limits: z
    .object({
      maxWallClockMs: z.number().positive().optional(),
      maxIterations: z.number().positive().optional(),
      maxSpendUsd: z.number().nonnegative().optional(),
    })
    .optional(),
});

type ImportContent = z.infer<typeof ImportContentSchema>;

/**
 * Extract the JSON body of a `lynox-workflow` share block from pasted text. The
 * fence is variable-length (CommonMark): read the opening fence's backtick run
 * and match a closing fence of at least that length. Falls back to the trimmed
 * input when no fenced block is present (the user pasted raw JSON). Never throws.
 */
export function extractPortableBlock(text: string): string {
  // Opening fence: a line of ≥3 backticks immediately followed by the info string.
  const open = new RegExp('(^|\\n)(`{3,})' + LYNOX_WORKFLOW_INFO_STRING + '[^\\n]*\\n');
  const m = open.exec(text);
  if (!m) return text.trim();
  const fence = m[2] ?? '```';
  const bodyStart = m.index + m[0].length;
  // Closing fence: the first line (at or after bodyStart) that is ≥ the opening
  // fence length of backticks, optionally with trailing whitespace.
  // `\r?` tolerates a CRLF-pasted block (Windows copy-paste) — without it a valid
  // block's closing fence never matches and the whole thing is rejected as bad_json.
  const close = new RegExp('\\n(`{' + String(fence.length) + ',})[ \\t]*\\r?(\\n|$)');
  const rest = text.slice(bodyStart);
  const cm = close.exec(rest);
  const body = cm ? rest.slice(0, cm.index) : rest;
  return body.trim();
}

function sanitiseProse(s: string): string {
  return stripUntrustedSeparators(s);
}

/** Max object/array nesting an imported blob may carry. A real workflow envelope
 *  nests only a few levels (envelope → workflow → steps[] → input_template); 64 is
 *  generous headroom. */
const MAX_IMPORT_DEPTH = 64;

/**
 * Reject a blob nested past {@link MAX_IMPORT_DEPTH}. `JSON.parse` accepts arbitrary
 * depth, but the downstream `JSON.stringify` calls (the migration reconstruction,
 * the secret-ref scan, the persist write) recurse and would throw an untyped
 * `RangeError` on a deeply-nested paste — the untrusted boundary must fail with a
 * typed {@link PortableImportError} instead. Iterative (explicit stack) so the
 * checker itself cannot stack-overflow on the input it exists to reject.
 */
function assertBoundedDepth(value: unknown): void {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (d > MAX_IMPORT_DEPTH) {
      throw new PortableImportError('bad_content', 'This workflow is nested too deeply to import.');
    }
    if (v !== null && typeof v === 'object') {
      for (const child of Object.values(v as Record<string, unknown>)) {
        stack.push({ v: child, d: d + 1 });
      }
    }
  }
}

/**
 * Parse + validate + version-negotiate + migrate + sanitise a pasted portable
 * workflow block (PRD §4/§5, Slice 3a). Returns the clean content ready for the
 * import tool to build a fresh, UNCONFIRMED, contract-less {@link PlannedPipeline}
 * around, or throws {@link PortableImportError} with a user-facing reason. Pure:
 * resolves no secrets, touches no store, mints no id.
 */
export function parseAndValidatePortable(rawText: string): PortableImportResult {
  // A4 — byte-cap FIRST, before any parse work, measured in UTF-8 bytes.
  if (Buffer.byteLength(rawText, 'utf8') > MAX_IMPORT_BYTES) {
    throw new PortableImportError(
      'too_large',
      `This workflow block is too large to import (over ${String(Math.floor(MAX_IMPORT_BYTES / 1024))} KB). ` +
        `A shared workflow should be a few KB — this looks malformed.`,
    );
  }

  const body = extractPortableBlock(rawText);
  if (body.length === 0) {
    throw new PortableImportError('no_block', 'No workflow content found to import.');
  }

  // A4 — fail-LOUD JSON parse (getPipeline swallows; the untrusted boundary must not).
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PortableImportError(
      'bad_json',
      'This does not look like a valid lynox workflow block (could not parse it as JSON). ' +
        'Copy the whole ```lynox-workflow block, including the fence lines.',
    );
  }

  // Bound nesting BEFORE any downstream JSON.stringify recurses over it.
  assertBoundedDepth(parsed);

  const env = EnvelopeSchema.safeParse(parsed);
  if (!env.success) {
    throw new PortableImportError(
      'bad_envelope',
      'This is not a recognised lynox workflow block (missing the version envelope).',
    );
  }

  // A5 — version negotiation, fail-loud on NEWER, BEFORE any content cast/migrate.
  if (env.data.lynox_workflow_format_version > LYNOX_WORKFLOW_FORMAT_VERSION) {
    throw new PortableImportError(
      'version_too_new',
      `This workflow was exported from a newer version of lynox (share format v${String(env.data.lynox_workflow_format_version)}). ` +
        `Update this instance to import it.`,
    );
  }
  if (env.data.content_schema_version > CURRENT_PIPELINE_SCHEMA_VERSION) {
    throw new PortableImportError(
      'version_too_new',
      `This workflow was exported from a newer version of lynox (content v${String(env.data.content_schema_version)}). ` +
        `Update this instance to import it.`,
    );
  }

  // Migrate an OLDER content version up to CURRENT before shape validation, reusing
  // the same per-blob forward migrator the boot loop uses. `migratePipelineBlob`
  // gates on the blob's own stamped version and returns null when already current.
  const stamped = JSON.stringify({ ...env.data.workflow, schema_version: env.data.content_schema_version });
  const migrated = migratePipelineBlob(stamped);
  let workflowObj: unknown = env.data.workflow;
  if (migrated !== null) {
    try {
      workflowObj = JSON.parse(migrated);
    } catch {
      /* migratePipelineBlob re-serialises its own parsed object — a parse failure
         here is impossible in practice; fall back to the pre-migration object. */
      workflowObj = env.data.workflow;
    }
  }

  // A4 — real shape validation (NOT an `as` cast). Unknown keys are stripped.
  const parsedContent = ImportContentSchema.safeParse(workflowObj);
  if (!parsedContent.success) {
    const detail = parsedContent.error.issues
      .slice(0, 5)
      .map(e => `${e.path.map(String).join('.') || '(root)'}: ${e.message}`)
      .join('; ');
    throw new PortableImportError('bad_content', `This workflow block is not valid: ${detail}`);
  }
  const c: ImportContent = parsedContent.data;

  // A6 — sanitise every prose field that reaches the model at runtime (step.task)
  // or the consent surface (name/goal/reasoning/param descriptions). Structural
  // keys (step.id, param.name, input_from, tool, input_template) are left intact:
  // they are validated by zod + the graph check and re-writing them would break
  // {{params.*}} / input_from references. Removes the "own-visual-line" separator
  // injection vector permanently from the stored blob.
  const content: PortableWorkflowContent = {
    name: sanitiseProse(c.name),
    goal: sanitiseProse(c.goal),
    reasoning: sanitiseProse(c.reasoning),
    mode: c.mode ?? 'autonomous', // placeholder; the tool re-infers authoritatively
    parameters: c.parameters.map(p => ({
      name: p.name,
      description: sanitiseProse(p.description),
      type: p.type,
      source: p.source,
      ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}),
    })),
    steps: c.steps.map(s => ({
      id: s.id,
      task: sanitiseProse(s.task),
      ...(s.input_from !== undefined ? { input_from: s.input_from } : {}),
      ...(s.timeout_ms !== undefined ? { timeout_ms: s.timeout_ms } : {}),
      ...(s.tool !== undefined ? { tool: s.tool } : {}),
      ...(s.input_template !== undefined ? { input_template: s.input_template } : {}),
    })),
    ...(c.on_failure !== undefined ? { on_failure: c.on_failure } : {}),
    ...(c.limits !== undefined ? { limits: c.limits } : {}),
    // capabilityContract is DELIBERATELY absent — the sharer's grant is never
    // trusted or stored (§5 A1); it is reported separately for consent only.
  };

  // A3 — parse the inbound contract best-effort for the consent render (never stored).
  let inboundContract: CapabilityContract | undefined;
  let inboundContractOverbroad = false;
  if (c.capabilityContract !== undefined) {
    const parsedContract = InboundContractSchema.safeParse(c.capabilityContract);
    if (parsedContract.success) {
      const raw = parsedContract.data as CapabilityContract;
      // Breadth is a property of the glob semantics — check the RAW patterns
      // (sanitising first could mask a wildcard). Sanitise host/path strings for
      // the consent render only: they are echoed into the agent's tool result, so
      // an exotic separator in a pattern must not slip the A6 boundary either.
      inboundContractOverbroad = raw.hostPatterns.some(isOverbroadHostPattern);
      inboundContract = {
        ...raw,
        hostPatterns: raw.hostPatterns.map(sanitiseProse),
        pathPatterns: raw.pathPatterns.map(sanitiseProse),
      };
    } else {
      // An unreadable contract cannot be rendered truthfully; flag over-broad so
      // the consent step warns rather than silently omitting an unknown grant.
      inboundContractOverbroad = true;
    }
  }

  // A6 — injection-scan the sanitised prose; a hit becomes a consent-surface caution.
  const proseForScan = [
    content.name,
    content.goal,
    content.reasoning,
    ...content.steps.map(s => s.task),
    ...content.parameters.map(p => p.description),
  ].join('\n');
  const injectionFlagged = detectInjectionAttempt(proseForScan).detected;

  // Distinct secret:NAME refs the importer must re-bind (refs, never values).
  // Infra-secret refs (MANAGED_/LYNOX_/SMTP_/…) are dropped: they are admin-only,
  // the user cannot bind them, and `resolveSecretRefs` refuses to resolve them —
  // advertising them as "connect these" would be wrong (and needless disclosure).
  const secretRefs = [
    ...new Set(
      (JSON.stringify(content).match(SECRET_REF_PATTERN) ?? [])
        .map(r => r.slice('secret:'.length))
        .filter(n => !isInfraSecret(n)),
    ),
  ].sort();

  return {
    content,
    inboundContract,
    inboundContractOverbroad,
    injectionFlagged,
    secretRefs,
  };
}
