/**
 * What the view says about a trigger's last escalation — a failed scheduled workflow or a
 * watch finding opens a thread and sends a wakeup, and the engine records whether that
 * wakeup reached anyone (`triggers.last_escalation_outcome`, `summarizeDelivery`).
 *
 * `null` when there is nothing to say: the trigger never escalated, or the payload carries a
 * value the engine does not write. A guess here would read as a fact about whether the owner
 * was told, so an unknown value shows nothing rather than a default.
 */
export type EscalationNotice = { key: 'triggers.escalation_delivered' | 'triggers.escalation_not_delivered' | 'triggers.escalation_no_channel' | 'triggers.escalation_unconfirmed'; warn: boolean; at: string };

export function escalationNotice(trigger: {
	last_escalation_at?: string | null | undefined;
	last_escalation_outcome?: string | null | undefined;
}): EscalationNotice | null {
	const at = trigger.last_escalation_at;
	if (!at) return null;
	switch (trigger.last_escalation_outcome) {
		case 'delivered': return { key: 'triggers.escalation_delivered', warn: false, at };
		case 'not_delivered': return { key: 'triggers.escalation_not_delivered', warn: true, at };
		case 'no_channel': return { key: 'triggers.escalation_no_channel', warn: true, at };
		// Started, and no channel has answered: not a delivery the owner can rely on.
		case 'unconfirmed': return { key: 'triggers.escalation_unconfirmed', warn: true, at };
		default: return null;
	}
}
