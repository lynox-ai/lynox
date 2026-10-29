/**
 * Which memory tools an engine registers, as one answer that the registration and the mandate
 * lock both read, so the two cannot drift.
 *
 * The durable tools (`remember`, `recall`, `memory_retire`, …) stand in for the six legacy
 * `memory_*` tools when durable memory is on AND its store opened. Otherwise the legacy tools
 * are registered, and three of them (`memory_delete`, `memory_update`, `memory_promote`) change
 * memory by a pattern the model writes. Their rows in a mandate's trail cannot name what was
 * hit, so a mandate is refused on an engine that registers them. The sign-in is not every way
 * a mandate acts — its plans run later under it — so the tool lock also holds these three back
 * from every mandate turn (`MANDATE_PATTERN_WRITE_TOOLS` in mandate-tool-lock.ts).
 */

/** Why an engine registers the legacy memory tools: durable memory is off, or on without its store. */
export type LegacyMemoryReason = 'dk_off' | 'store_missing';

/** `null` when the durable tools are registered; otherwise why the legacy ones are. */
export function legacyMemoryReason(durableEnabled: unknown, knowledgeStore: object | null | undefined): LegacyMemoryReason | null {
  if (durableEnabled !== true) return 'dk_off';
  if (!knowledgeStore) return 'store_missing';
  return null;
}
