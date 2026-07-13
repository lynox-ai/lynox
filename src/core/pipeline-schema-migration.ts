/**
 * Content-model versioning for the workflow DEFINITION blob (`PlannedPipeline`,
 * stored as engine.db `workflows.definition_json`). This is the CONTENT schema
 * version carried INSIDE the blob — orthogonal to the engine.db DDL
 * `schema_version` TABLE (which versions the table STRUCTURE and is migrated by
 * the static-SQL `_migrate` runner in engine-db.ts). A stored definition with no
 * version is the gap this closes: a future breaking change to the blob shape
 * would otherwise strand user-authored workflows with no migration path (PRD
 * §4.1, Move 1).
 *
 * The forward migration is applied at boot by `WorkflowStore.migrateContentSchema`
 * (per-blob, version-gated, idempotent, forward-only) and the version is stamped
 * on every native write by `RunHistory.insertPlannedPipeline`.
 */

/**
 * Current content-model version of a stored workflow definition. Bump this in
 * lock-step with adding a {@link TRANSFORMS} entry that restructures the blob.
 *
 * - v1 (Slice 1a): the shape at first versioning. Legacy blobs (no
 *   `schema_version`) are treated as v0 and reach v1 via an identity step —
 *   validating the harness on real stored data.
 * - v2 (Slice 1b): drop the dead `executionMode` tombstone — the first real
 *   content transform.
 */
export const CURRENT_PIPELINE_SCHEMA_VERSION = 2;

/**
 * Per-version content transforms: `TRANSFORMS[N]` upgrades a blob from v(N-1) to
 * vN by MUTATING it in place. A missing entry is an identity step (version bump
 * with no content change) — which is exactly v0→v1 here.
 *
 * INVARIANT: a transform only ever runs on a blob at exactly v(N-1) and never
 * twice, because {@link migratePipelineBlob} gates on the blob's own stamped
 * version. A transform therefore does NOT need to be internally idempotent, but
 * MUST NOT depend on any state outside the blob it is handed.
 */
const TRANSFORMS: Record<number, (blob: Record<string, unknown>) => void> = {
  // v1→v2: drop the legacy `executionMode` tombstone. Every workflow runs through
  // the orchestrator (the 'tracked' path was removed, D9); nothing reads the
  // field, so deleting it shrinks the content model with no behaviour change.
  // New writes never carry it (the producers no longer set it).
  2: (blob) => { delete blob['executionMode']; },
};

/**
 * The blob's declared content version. A non-number, NaN/Infinity, fractional,
 * or negative `schema_version` (only reachable from a corrupt or hostile blob —
 * incl. a slice-3 untrusted import) is treated as 0 = pre-versioning, so the
 * integer migration chain re-stamps it cleanly AND a huge NEGATIVE can never
 * drive the `v + 1` loop into a boot-hang. A huge POSITIVE is left to the
 * forward-only guard in {@link migratePipelineBlob} (`>= CURRENT` ⇒ untouched).
 */
function readVersion(blob: Record<string, unknown>): number {
  const v = blob['schema_version'];
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.trunc(v));
}

/**
 * Forward-migrate one stored definition blob to
 * {@link CURRENT_PIPELINE_SCHEMA_VERSION}. Returns the re-serialized JSON when it
 * changed, or `null` when the blob is already current OR cannot be parsed as a
 * JSON object (a malformed row is left UNTOUCHED — never silently rewritten).
 *
 * Pure + idempotent: feeding the output back in returns `null`. Forward-only: a
 * blob already at or beyond the current version is never downgraded (returns
 * `null`) — an older engine reading a newer blob is handled by the snapshot-
 * gated deploy discipline and, on the import path, by the version-negotiation
 * validator (Slice 3), NOT here.
 */
export function migratePipelineBlob(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed — leave the row untouched
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const blob = parsed as Record<string, unknown>;
  let v = readVersion(blob);
  if (v >= CURRENT_PIPELINE_SCHEMA_VERSION) return null;
  while (v < CURRENT_PIPELINE_SCHEMA_VERSION) {
    const next = v + 1;
    TRANSFORMS[next]?.(blob);
    blob['schema_version'] = next;
    v = next;
  }
  return JSON.stringify(blob);
}
