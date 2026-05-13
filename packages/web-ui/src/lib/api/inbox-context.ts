// === Inbox Mail-Context-Sidebar HTTP client ===
//
// `GET /api/inbox/items/:id/context` returns the four sidebar sections
// (recent threads, open follow-ups, outbound history, reminders) plus
// the resolved sender. All sections are deterministic; the caller
// renders empty sections inline (PRD-INBOX-PHASE-4 §"per-section empty
// states") rather than failing the envelope.

export interface InboxContextSender {
	address: string;
	name: string | null;
}

export interface InboxContextRecentThread {
	id: string;
	subject: string;
	mailDate?: string | undefined;
	classifiedAt: string;
	bucket: 'requires_user' | 'draft_ready' | 'auto_handled';
	userAction?: 'archived' | 'replied' | 'snoozed' | 'unhandled' | undefined;
}

export interface InboxContextFollowup {
	id: string;
	recipient: string;
	type: string;
	reason: string;
	reminderAt: string;
	status: string;
}

export interface InboxContextOutbound {
	id: string;
	messageId: string;
	subject: string;
	sentAt: string;
}

export interface InboxContextReminder {
	id: string;
	subject: string;
	snoozeUntil?: string | undefined;
	notifiedAt?: string | undefined;
}

export interface InboxContext {
	sender: InboxContextSender;
	recentThreads: ReadonlyArray<InboxContextRecentThread>;
	openFollowups: ReadonlyArray<InboxContextFollowup>;
	outboundHistory: ReadonlyArray<InboxContextOutbound>;
	reminders: ReadonlyArray<InboxContextReminder>;
}

export async function getItemContext(
	apiBase: string,
	itemId: string,
): Promise<InboxContext | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/items/${encodeURIComponent(itemId)}/context`);
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<InboxContext>;
		if (!data.sender) return null;
		return {
			sender: {
				address: data.sender.address ?? '',
				name: data.sender.name ?? null,
			},
			recentThreads: Array.isArray(data.recentThreads) ? data.recentThreads : [],
			openFollowups: Array.isArray(data.openFollowups) ? data.openFollowups : [],
			outboundHistory: Array.isArray(data.outboundHistory) ? data.outboundHistory : [],
			reminders: Array.isArray(data.reminders) ? data.reminders : [],
		};
	} catch {
		return null;
	}
}
