import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toPromptOrigin, originFromEvent, originFromPending } from './prompt-origin.js';

describe('toPromptOrigin', () => {
	it('keeps every field that carries something', () => {
		expect(toPromptOrigin('bexio Triage', 'load_contacts', 'Paginate contacts'))
			.toEqual({ workflowName: 'bexio Triage', stepId: 'load_contacts', stepTask: 'Paginate contacts' });
	});

	it('is undefined when nothing was supplied — no origin means no origin line', () => {
		expect(toPromptOrigin(undefined, undefined, undefined)).toBeUndefined();
		expect(toPromptOrigin(null, null, null)).toBeUndefined();
	});

	it('treats an empty string as absent, not as a nameless workflow', () => {
		// An origin line reading `Workflow ""` is worse than none: it asserts a
		// workflow asked and then fails to say which.
		expect(toPromptOrigin('', '', '')).toBeUndefined();
		expect(toPromptOrigin('', 'load_contacts', '')).toEqual({ stepId: 'load_contacts' });
	});

	it('ignores non-string values instead of stringifying them', () => {
		expect(toPromptOrigin(42, { id: 'x' }, ['a'])).toBeUndefined();
	});

	it('survives on the workflow name alone', () => {
		expect(toPromptOrigin('bexio Triage', undefined, undefined)).toEqual({ workflowName: 'bexio Triage' });
	});
});

describe('originFromEvent — live SSE frame', () => {
	it('reads the snake_case wire fields the engine emits', () => {
		expect(originFromEvent({
			promptId: 'p1',
			question: 'Allow?',
			workflow_name: 'bexio Triage Phase 1-3',
			step_id: 'load_contacts',
			step_task: 'Paginate GET /2.0/contact',
		})).toEqual({
			workflowName: 'bexio Triage Phase 1-3',
			stepId: 'load_contacts',
			stepTask: 'Paginate GET /2.0/contact',
		});
	});

	it('is undefined for a main-agent prompt, which carries no origin fields', () => {
		expect(originFromEvent({ promptId: 'p2', question: 'Allow?' })).toBeUndefined();
	});

	it('does not read the camelCase spelling off a live frame', () => {
		// The two transports genuinely differ — SSE is flat snake_case, the
		// resume endpoint is a nested camelCase object. A parser that silently
		// accepted both would hide the day one of them changes shape.
		expect(originFromEvent({ workflowName: 'bexio Triage' })).toBeUndefined();
	});
});

describe('originFromPending — resumed prompt', () => {
	it('reads the nested object persisted in v52', () => {
		expect(originFromPending({ workflowName: 'bexio Triage', stepId: 'load_contacts' }))
			.toEqual({ workflowName: 'bexio Triage', stepId: 'load_contacts' });
	});

	it('is undefined for a prompt that was stored without an origin', () => {
		expect(originFromPending(undefined)).toBeUndefined();
		expect(originFromPending(null)).toBeUndefined();
		expect(originFromPending('bexio Triage')).toBeUndefined();
	});
});

/**
 * Source-level wiring guard.
 *
 * The parsers above are pure and provable; what they cannot prove is that the
 * store CALLS them. That is the half that actually broke: the engine has shipped
 * `step_id`/`step_task` on every prompt event since the pipeline spawners
 * existed, and the client read neither — a prompt state built without `origin:`
 * looks completely healthy from the parser's side.
 *
 * `chat.svelte.ts` is a Svelte 5 rune module and the root vitest config carries
 * no svelte plugin, so importing it throws `$state is not defined` (same reason
 * `chat-detach-reset.test.ts` reads the source). So: read the source, and
 * require every prompt-state assignment to carry an origin.
 */
describe('chat store wires the origin into every prompt state', () => {
	const SRC = readFileSync(
		fileURLToPath(new URL('../stores/chat.svelte.ts', import.meta.url)),
		'utf-8',
	);

	/** The four SSE events that can carry a prompt a workflow step raised. */
	const PROMPT_EVENTS = ['prompt', 'prompt_tabs', 'secret_prompt', 'mail_connect_prompt'] as const;

	it.each(PROMPT_EVENTS)('case %s builds its state with an origin', (event) => {
		const start = SRC.indexOf(`case '${event}':`);
		expect(start, `no handler for SSE event ${event}`).toBeGreaterThan(-1);
		// Bounded by the NEXT `case`, not by the first `break` — `prompt_tabs`
		// breaks early on a malformed frame, so a `break`-bounded slice would stop
		// before the state literal and report a wired handler as unwired.
		const next = SRC.indexOf("case '", start + 1);
		const body = SRC.slice(start, next > -1 ? next : undefined);
		expect(body, `${event} handler drops the prompt's origin`).toContain('origin: originFromEvent(data)');
	});

	it('the reload path restores an origin too', () => {
		// Without this the fix holds until someone refreshes the page — which is
		// exactly when a long workflow is most likely to be sitting on a prompt.
		const fn = SRC.slice(SRC.indexOf('export async function checkPendingPrompt'));
		const body = fn.slice(0, fn.indexOf('\n}'));
		expect(body).toContain("originFromPending(data['origin'])");
		// All four restore branches consume it — a branch that silently omits
		// `origin` is the same defect as the SSE side, one transport later.
		expect(body.match(/\borigin,/g) ?? []).toHaveLength(4);
	});
});
