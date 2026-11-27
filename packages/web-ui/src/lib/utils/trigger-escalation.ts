/**
 * What the view says about a trigger's last escalation — a failed scheduled workflow, a watch
 * finding or a scheduled run's question sends a wakeup, and the engine records whether that
 * wakeup reached anyone (`triggers.last_escalation_outcome`, `summarizeDelivery`).
 *
 * `null` when there is nothing to say: the trigger never escalated, or the payload carries a
 * value the engine does not write. A guess here would read as a fact about whether the owner
 * was told, so an unknown value shows nothing rather than a default.
 */
export type EscalationNotice = {
	key: 'triggers.escalation_delivered' | 'triggers.escalation_delivered_question' | 'triggers.escalation_unconfirmed_question' | 'triggers.escalation_not_delivered' | 'triggers.escalation_not_delivered_no_subscription' | 'triggers.escalation_not_delivered_send_failed' | 'triggers.escalation_no_channel' | 'triggers.escalation_unconfirmed';
	warn: boolean;
	at: string;
};

/** Which sentence a `not_delivered` escalation gets: by why it reached nobody, when the engine knows. */
function notDeliveredKey(escalationCase: string | null | undefined): EscalationNotice['key'] {
	switch (escalationCase) {
		// No device of the owner's was set up for push, or its setup expired: the settings help.
		case 'no_subscription': return 'triggers.escalation_not_delivered_no_subscription';
		// A send was tried and the push service refused or could not be reached: the settings do not.
		case 'send_failed': return 'triggers.escalation_not_delivered_send_failed';
		// Recorded before the engine kept the case, or a value it does not write.
		default: return 'triggers.escalation_not_delivered';
	}
}

export function escalationNotice(trigger: {
	last_escalation_at?: string | null | undefined;
	last_escalation_outcome?: string | null | undefined;
	last_escalation_case?: string | null | undefined;
	last_escalation_kind?: string | null | undefined;
}): EscalationNotice | null {
	const at = trigger.last_escalation_at;
	if (!at) return null;
	// A run's question says "question"; an alert, or one recorded before the kind was kept, "alert".
	const question = trigger.last_escalation_kind === 'question';
	switch (trigger.last_escalation_outcome) {
		case 'delivered': return { key: question ? 'triggers.escalation_delivered_question' : 'triggers.escalation_delivered', warn: false, at };
		case 'not_delivered': return { key: notDeliveredKey(trigger.last_escalation_case), warn: true, at };
		case 'no_channel': return { key: 'triggers.escalation_no_channel', warn: true, at };
		// Started, and no channel has answered: not a delivery the owner can rely on.
		case 'unconfirmed': return { key: question ? 'triggers.escalation_unconfirmed_question' : 'triggers.escalation_unconfirmed', warn: true, at };
		default: return null;
	}
}

/**
 * The link from a trigger's escalation to the chat where its question or alert stands: only
 * beside a notice, and only while the engine still names the chat (it leaves it out once the
 * chat is deleted). `null` otherwise, and for a kind it does not write.
 */
export function escalationChatLink(trigger: {
	last_escalation_at?: string | null | undefined;
	last_escalation_outcome?: string | null | undefined;
	last_escalation_chat?: { threadId?: unknown; kind?: unknown } | null | undefined;
}): { href: string; key: 'triggers.escalation_chat_question' | 'triggers.escalation_chat_alert' } | null {
	if (escalationNotice(trigger) === null) return null;
	const chat = trigger.last_escalation_chat;
	if (!chat || typeof chat.threadId !== 'string' || chat.threadId === '') return null;
	const key = chat.kind === 'question' ? 'triggers.escalation_chat_question' : chat.kind === 'alert' ? 'triggers.escalation_chat_alert' : null;
	if (key === null) return null;
	return { href: `/app?thread=${encodeURIComponent(chat.threadId)}`, key };
}
