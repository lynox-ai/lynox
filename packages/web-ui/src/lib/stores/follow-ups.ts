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

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return { suggestions: [], cleanText: text };
	}
	// Not a follow-up block → leave the text completely untouched (never strip mid-text JSON).
	if (!Array.isArray(parsed)) return { suggestions: [], cleanText: text };

	const suggestions = normalizeSuggestions(parsed);
	if (suggestions.length === 0) return { suggestions: [], cleanText: text };

	// Strip ONLY the follow-up span; keep any surrounding text (incl. trailing prose). Collapse a
	// gap left in the middle so removing an inline block doesn't leave a triple newline.
	const cleanText = (text.slice(0, spanStart) + text.slice(spanEnd)).replace(/\n{3,}/g, '\n\n').trim();

	return { suggestions, cleanText };
}

/**
 * Validate + normalize a raw array of suggestion candidates into the rendered
 * shape: skip malformed items (missing/blank label or task), trim + cap the
 * label length, deduplicate by label, and cap the count. Shared by the text
 * parser and the `suggest_follow_ups` tool-input path so both apply identical
 * rules. Returns `[]` for anything that isn't a conforming array.
 */
function normalizeSuggestions(parsed: unknown): FollowUpSuggestion[] {
	if (!Array.isArray(parsed)) return [];
	const out: FollowUpSuggestion[] = [];
	const seen = new Set<string>();
	for (const item of parsed) {
		if (typeof item !== 'object' || item === null) continue;
		const obj = item as Record<string, unknown>;
		if (typeof obj['label'] !== 'string' || typeof obj['task'] !== 'string') continue;
		const label = obj['label'].trim().slice(0, MAX_LABEL_LENGTH);
		const task = obj['task'].trim();
		if (!label || !task) continue;
		if (seen.has(label)) continue;
		seen.add(label);
		out.push({ label, task });
		if (out.length >= MAX_FOLLOW_UPS) break;
	}
	return out;
}

/**
 * Build follow-up suggestions from the `suggest_follow_ups` tool-call input
 * (`{ suggestions: [{label, task}] }`) — the structured replacement for the
 * text `<follow_ups>` block. Same validation as the text parser (dedup, cap,
 * label length), but there is no visible text to strip: the tool call carries
 * only its input. Returns `[]` for any non-conforming input.
 */
export function followUpsFromToolInput(input: unknown): FollowUpSuggestion[] {
	if (typeof input !== 'object' || input === null) return [];
	return normalizeSuggestions((input as Record<string, unknown>)['suggestions']);
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
