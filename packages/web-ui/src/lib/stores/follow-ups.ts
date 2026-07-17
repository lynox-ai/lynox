/**
 * Follow-up suggestion parsing — a PURE module (no runes), so it is unit-testable
 * like ./chat-usage.ts. The engine appends "what next" suggestions to the end of
 * an assistant reply; the UI renders them as clickable pills and strips them from
 * the displayed text.
 */

export interface FollowUpSuggestion {
	label: string;
	task: string;
}

const FOLLOW_UP_RE = /<follow_ups>\s*([\s\S]*?)\s*<\/follow_ups>/;
// Fallback for when the agent emits the suggestions as a BARE trailing JSON array
// without the <follow_ups> wrapper (an observed format drift on longer replies) —
// otherwise the raw `[{"label":…,"task":…}]` leaks into the rendered message.
// Anchored to the end and guarded by requiring both "label" and "task" keys so it
// never consumes ordinary trailing JSON the agent might legitimately show.
const FOLLOW_UP_BARE_RE = /(\[\s*\{[\s\S]*?"label"[\s\S]*?"task"[\s\S]*?\])\s*$/;
const MAX_FOLLOW_UPS = 4;
const MAX_LABEL_LENGTH = 40;

export function parseFollowUps(text: string): { suggestions: FollowUpSuggestion[]; cleanText: string } {
	// Preferred: the wrapped <follow_ups>…</follow_ups> form. Fall back to a bare
	// trailing array so a missing wrapper doesn't leak raw JSON into the message.
	let re = FOLLOW_UP_RE;
	let match = FOLLOW_UP_RE.exec(text);
	if (!match) {
		match = FOLLOW_UP_BARE_RE.exec(text);
		re = FOLLOW_UP_BARE_RE;
	}
	if (!match) return { suggestions: [], cleanText: text };

	const cleanText = text.replace(re, '').trimEnd();
	let suggestions: FollowUpSuggestion[] = [];

	try {
		const parsed: unknown = JSON.parse(match[1]!);
		if (!Array.isArray(parsed)) return { suggestions: [], cleanText };

		for (const item of parsed) {
			if (typeof item !== 'object' || item === null) continue;
			const obj = item as Record<string, unknown>;
			if (typeof obj['label'] !== 'string' || typeof obj['task'] !== 'string') continue;
			if (!obj['label'].trim() || !obj['task'].trim()) continue;
			suggestions.push({
				label: obj['label'].trim().slice(0, MAX_LABEL_LENGTH),
				task: obj['task'].trim(),
			});
		}
	} catch {
		return { suggestions: [], cleanText };
	}

	// Deduplicate by label
	const seen = new Set<string>();
	suggestions = suggestions.filter(s => {
		if (seen.has(s.label)) return false;
		seen.add(s.label);
		return true;
	});

	return { suggestions: suggestions.slice(0, MAX_FOLLOW_UPS), cleanText };
}

/** Minimal message shape the history strip operates on (a subset of ChatMessage). */
export interface FollowUpHistoryMessage {
	role: 'user' | 'assistant';
	content: string;
	blocks?: Array<{ type: string; text?: string }>;
	followUps?: FollowUpSuggestion[];
}

/**
 * Re-apply follow-up stripping to a REHYDRATED transcript (thread resume / local snapshot).
 * The live stream-completion handler strips follow-ups client-side, but the server persists the
 * agent's RAW output — the `<follow_ups>` / bare-JSON trailer is still in each assistant turn's
 * `content`. Rendering the server transcript verbatim leaks that raw JSON into the bubble and the
 * pills never reappear (the engine re-entry bug). This mutates in place: strips the trailer from
 * EVERY assistant turn, and keeps the parsed suggestions only on the LAST assistant message (pills
 * are the current "what next", matching the live handler — stale turns get their text cleaned but
 * no pills).
 */
export function stripFollowUpsFromHistory(messages: FollowUpHistoryMessage[]): void {
	let lastAssistantIdx = -1;
	for (let i = 0; i < messages.length; i += 1) {
		if (messages[i]!.role === 'assistant') lastAssistantIdx = i;
	}
	messages.forEach((m, i) => {
		if (m.role !== 'assistant' || !m.content) return;
		const parsed = parseFollowUps(m.content);
		if (parsed.suggestions.length === 0) return;
		m.content = parsed.cleanText;
		if (m.blocks?.length) {
			const lastBlock = m.blocks[m.blocks.length - 1];
			if (lastBlock && lastBlock.type === 'text' && typeof lastBlock.text === 'string') {
				lastBlock.text = parseFollowUps(lastBlock.text).cleanText;
			}
		}
		// Pills only on the last assistant message; earlier turns keep the cleaned text, no pills.
		if (i === lastAssistantIdx) m.followUps = parsed.suggestions;
	});
}
