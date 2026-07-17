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
// Looser fallback for a bare array followed by TRAILING PROSE ("… [array]\n\nSoll ich …?"):
// the $-anchored form above misses it and the raw JSON leaks. Global (no end-anchor) so we can
// take the LAST occurrence; JSON.parse below is the real guard — an array that doesn't parse to
// {label,task} objects is left untouched, so ordinary mid-text JSON is never stripped.
const FOLLOW_UP_LOOSE_RE = /\[\s*\{[\s\S]*?"label"[\s\S]*?"task"[\s\S]*?\}\s*\]/g;
const MAX_FOLLOW_UPS = 4;
const MAX_LABEL_LENGTH = 40;

export function parseFollowUps(text: string): { suggestions: FollowUpSuggestion[]; cleanText: string } {
	// Locate the follow-up block: preferred wrapped <follow_ups>…</follow_ups>, else a bare array
	// anchored at the end, else the LAST label+task array anywhere (so trailing prose after the
	// array doesn't cause a leak). We capture the exact span so only the block is stripped.
	let jsonText: string | null = null;
	let spanStart = -1;
	let spanEnd = -1;
	const wrapped = FOLLOW_UP_RE.exec(text);
	if (wrapped) {
		jsonText = wrapped[1]!;
		spanStart = wrapped.index;
		spanEnd = wrapped.index + wrapped[0].length;
	} else {
		const anchored = FOLLOW_UP_BARE_RE.exec(text);
		if (anchored) {
			jsonText = anchored[1]!;
			spanStart = anchored.index;
			spanEnd = anchored.index + anchored[0].length;
		} else {
			// Trailing-prose case: accept the LAST label+task array ONLY as a trailer — there must be
			// reply content BEFORE it (never an array that opens the message) and only a short
			// sentence AFTER it (a follow-up is the tail of a reply, not mid-content JSON). This keeps
			// the $-anchor's false-positive protection while tolerating a short "Soll ich …?" after.
			const all = [...text.matchAll(FOLLOW_UP_LOOSE_RE)];
			const last = all[all.length - 1];
			if (last) {
				const start = last.index!;
				const end = start + last[0].length;
				const before = text.slice(0, start).trim();
				const after = text.slice(end).trim();
				if (before.length > 0 && after.length <= 200) {
					jsonText = last[0];
					spanStart = start;
					spanEnd = end;
				}
			}
		}
	}
	if (jsonText === null) return { suggestions: [], cleanText: text };

	let suggestions: FollowUpSuggestion[] = [];
	try {
		const parsed: unknown = JSON.parse(jsonText);
		// Not a follow-up block → leave the text completely untouched (never strip mid-text JSON).
		if (!Array.isArray(parsed)) return { suggestions: [], cleanText: text };

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
		return { suggestions: [], cleanText: text };
	}

	if (suggestions.length === 0) return { suggestions: [], cleanText: text };

	// Strip ONLY the follow-up span; keep any surrounding text (incl. trailing prose). Collapse a
	// gap left in the middle so removing an inline block doesn't leave a triple newline.
	const cleanText = (text.slice(0, spanStart) + text.slice(spanEnd)).replace(/\n{3,}/g, '\n\n').trim();

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
