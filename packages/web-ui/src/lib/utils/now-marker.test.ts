import { describe, expect, it } from 'vitest';
import { stripNowMarker, stripLoadedContext } from './now-marker.js';

describe('stripNowMarker', () => {
	it('strips the legacy UTC-only marker shape (pre-PR-#246 form)', () => {
		// `[Now: <iso>]` with no local clause — what the engine wrote between
		// PR #242 and PR #246. Threads recorded then still need to render.
		const raw = '[Now: 2026-05-05T11:55:00.000Z]\n\nhello';
		expect(stripNowMarker(raw)).toBe('hello');
	});

	it('strips the marker with local clause (post-PR-#246 form)', () => {
		// The bug Rafael caught on staging: `[Now: …; user local … <tz>]\n\n`
		// was rendering verbatim inside the user's chat bubble.
		const raw = '[Now: 2026-05-05T11:55:00.000Z; user local 2026-05-05 13:55:00 Europe/Zurich]\n\n🎤 Voice test';
		expect(stripNowMarker(raw)).toBe('🎤 Voice test');
	});

	it('preserves text that does not start with the marker', () => {
		// A user-typed message starting with `[` (e.g. a markdown footnote
		// reference or a code snippet) must not get its first line eaten.
		expect(stripNowMarker('[note] hello')).toBe('[note] hello');
		expect(stripNowMarker('plain text')).toBe('plain text');
	});

	it('handles undefined / null / non-string input defensively', () => {
		// msg.content can be reactive; an early render with undefined
		// shouldn't throw.
		expect(stripNowMarker(undefined)).toBe('');
		expect(stripNowMarker(null)).toBe('');
		expect(stripNowMarker(42 as unknown as string)).toBe('');
	});

	it('only strips the marker, not the trailing user text it precedes', () => {
		// Multi-line user text must keep all of its content after the marker.
		const raw = '[Now: 2026-05-05T11:55:00Z]\n\nfirst line\nsecond line';
		expect(stripNowMarker(raw)).toBe('first line\nsecond line');
	});
});

// The samples below mirror the real preamble shapes resolveChatContext emits
// (core/src/core/chat-context.ts) plus the http-api LOADED_CONTEXT_END sentinel
// (`\n[/loaded-context]\n\n`). If those formats change, update these.
const END = '\n[/loaded-context]\n\n';

describe('stripLoadedContext', () => {
	it('strips a single-line-ish workflow preamble, keeping the user text', () => {
		const raw =
			'[Loaded saved workflow for editing — id: wf-1]\n' +
			'Name: "Weekly report"\nMode: autonomous\nSteps:\n  1. [gather] pull metrics\n\n' +
			'To change it, call update_workflow_steps with workflow_id "wf-1". Confirm destructive edits with the user first.' +
			END + 'Add a step that emails the summary.';
		expect(stripLoadedContext(raw)).toBe('Add a step that emails the summary.');
	});

	it('strips a mail preamble that contains its OWN blank line (the case a \\n\\n anchor would break)', () => {
		// The mail kind writes `Message:\n<body>\n\n` inside the preamble, so a
		// naive "cut at the first blank line" would leave the reply instructions
		// in the bubble. The explicit end sentinel is what makes this exact.
		const raw =
			'[Loaded mail for reply — item: item-1]\n' +
			'From: Markus <markus@acme.example>\nSubject: "Angebot"\n' +
			'Message:\nHallo, koennt ihr ein Angebot schicken?\n\n' +
			'To reply, call mail_reply with uid: 42, account: "acme". Draft a reply, confirm the send with the user, then send it.' +
			END + 'Antworte freundlich und frag nach dem Budget.';
		expect(stripLoadedContext(raw)).toBe('Antworte freundlich und frag nach dem Budget.');
	});

	it('composes after stripNowMarker: [Now:] then [Loaded …] then user text', () => {
		const raw =
			'[Now: 2026-05-05T11:55:00Z; user local 2026-05-05 13:55:00 Europe/Zurich]\n\n' +
			'[Loaded workflow run — id: run-9]\nWorkflow: "Sync"\nStatus: failed\n' +
			'Error: step timed out' + END + 'Warum ist der fehlgeschlagen?';
		expect(stripLoadedContext(stripNowMarker(raw))).toBe('Warum ist der fehlgeschlagen?');
	});

	it('preserves the user text when there is no preamble', () => {
		expect(stripLoadedContext('just a normal message')).toBe('just a normal message');
		// A user who merely types "[Loaded …]" WITHOUT the server sentinel is untouched.
		expect(stripLoadedContext('[Loaded my file] here is what I mean')).toBe('[Loaded my file] here is what I mean');
	});

	it('handles undefined / null / non-string input defensively', () => {
		expect(stripLoadedContext(undefined)).toBe('');
		expect(stripLoadedContext(null)).toBe('');
		expect(stripLoadedContext(42 as unknown as string)).toBe('');
	});

	it('strips only the FIRST loaded block, keeping any later sentinel-like user text', () => {
		const raw = '[Loaded mail for reply — item: x]\nFrom: a\n' + '…' + END +
			'Please note: [/loaded-context] should stay in my message.';
		expect(stripLoadedContext(raw)).toBe('Please note: [/loaded-context] should stay in my message.');
	});
});
