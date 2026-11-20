import type { TriggerRecord } from '../types/pipeline.js';
import { MANDATE_TAG_PREFIX, isOwnerPrincipal, principalTag, type RequestPrincipal } from './request-principal.js';

/** The marks on a trigger that name who set it up or changed it, each with the grant id stored beside it. */
const TRIGGER_MARKS = [
  ['created_by', 'created_mandate_id'],
  ['edited_by', null],
  ['mandate_editor', 'mandate_editor_id'],
  ['covered_created_by', 'covered_created_id'],
  ['covered_edited_by', 'covered_edited_id'],
] as const satisfies readonly (readonly [keyof TriggerRecord, keyof TriggerRecord | null])[];

/**
 * A trigger's columns as a mandate may read them. A mark that names another mandate says only
 * that a mandate set it, never which one: the tag keeps its prefix, so the view still tells a
 * helper's schedule from the owner's (`awaitsOwnerStamp`), and the grant id beside it leaves.
 * A schedule another mandate set up or last changed keeps its values to itself
 * (`pipeline_params`): they may be that mandate's choice. Its own schedule a mandate reads with
 * its values, whoever changed it since. The owner's marks and the mandate's own stay as stored.
 * A takeover's covered marks name a mandate the schedule no longer belongs to, so they hide
 * whose they were and leave the values. A to-do's own `created_by` is always the reader's own or
 * the owner's (a mandate changes only its own to-do), so it passes as it is.
 */
export function withoutForeignMarks<T extends object>(stored: T, principal: RequestPrincipal): T {
  if (isOwnerPrincipal(principal)) return stored;
  const own = principal.kind === 'mandate' ? principalTag(principal) : null;
  const isForeign = (tag: unknown): boolean => typeof tag === 'string' && tag.startsWith(MANDATE_TAG_PREFIX) && tag !== own;
  const out: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  let foreignSchedule = false;
  for (const [tagKey, idKey] of TRIGGER_MARKS) {
    if (!isForeign(out[tagKey])) continue;
    out[tagKey] = MANDATE_TAG_PREFIX;
    if (idKey !== null) delete out[idKey];
    if (tagKey === 'created_by' || tagKey === 'edited_by' || tagKey === 'mandate_editor') foreignSchedule = true;
  }
  if (foreignSchedule && (own === null || (stored as Partial<TriggerRecord>).created_by !== own)) delete out['pipeline_params'];
  return out as T;
}
