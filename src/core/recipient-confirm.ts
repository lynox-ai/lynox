/**
 * "Confirm recipients": the owner's way to make a trigger from before its creator was recorded
 * count as their own, so its run sends to the recipients its instruction names again.
 *
 * Only a trigger nobody else had a hand in can be confirmed ({@link recipientsConfirmable}): no
 * creator recorded, nothing taken in from outside when it was set up, no mandate ever changed it,
 * and no one but the owner changed it last. Confirming records the owner as its creator and
 * nothing else; whatever made a trigger foreign stays. The owner confirms the instruction they
 * were shown ({@link recipientConfirmDigest}): a trigger changed since gets nothing.
 */
import { createHash } from 'node:crypto';
import type { TriggerRecord } from '../types/index.js';
import { OWNER_PRINCIPAL, principalTag } from './request-principal.js';

/** The parts of a trigger the check reads. */
export type ConfirmableTrigger = Pick<TriggerRecord, 'created_by' | 'created_untrusted' | 'mandate_editor' | 'edited_by'>;

/** The parts of a trigger whose instruction the owner confirms. */
export type ConfirmedInstruction = Pick<TriggerRecord, 'title' | 'description' | 'effect' | 'pipeline_id' | 'pipeline_params' | 'watch_config'>;

const empty = (v: string | null | undefined): boolean => v === undefined || v === null || v === '';

/** Whether the owner can confirm this trigger's recipients. */
export function recipientsConfirmable(t: ConfirmableTrigger): boolean {
  const untrusted = t.created_untrusted;
  return empty(t.created_by)
    && (empty(untrusted) || untrusted === 'none')
    && empty(t.mandate_editor)
    && (empty(t.edited_by) || t.edited_by === principalTag(OWNER_PRINCIPAL));
}

/** The digest of the instruction the owner is shown, sent back with the confirmation. */
export function recipientConfirmDigest(t: ConfirmedInstruction): string {
  const parts = [t.title, t.description ?? '', t.effect ?? '', t.pipeline_id ?? '', t.pipeline_params ?? '', t.watch_config ?? ''];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** What a confirmation did. */
export type RecipientConfirmOutcome = 'confirmed' | 'not_found' | 'not_confirmable' | 'changed';
