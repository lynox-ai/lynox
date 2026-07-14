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
