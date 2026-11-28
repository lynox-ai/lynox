import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toPromptOrigin, originFromEvent, originFromPending } from './prompt-origin.js';

describe('toPromptOrigin', () => {
	it('keeps every field that carries something', () => {
		expect(toPromptOrigin({ workflowName: 'bexio Triage', stepId: 'load_contacts', stepTask: 'Paginate contacts' }))
			.toEqual({ workflowName: 'bexio Triage', stepId: 'load_contacts', stepTask: 'Paginate contacts' });
	});

	it('is undefined when nothing was supplied — no origin means no origin line', () => {
		expect(toPromptOrigin({})).toBeUndefined();
		expect(toPromptOrigin({ workflowName: null, stepId: null, stepTask: null })).toBeUndefined();
	});

	it('treats an empty string as absent, not as a nameless workflow', () => {
		// An origin line reading `Workflow ""` is worse than none: it asserts a
		// workflow asked and then fails to say which.
		expect(toPromptOrigin({ workflowName: '', stepId: '', stepTask: '' })).toBeUndefined();
		expect(toPromptOrigin({ workflowName: '', stepId: 'load_contacts', stepTask: '' })).toEqual({ stepId: 'load_contacts' });
	});

	it('bounds a model-authored name so it cannot push Allow/Deny off screen', () => {
		// `validateManifest` puts no ceiling on `name`, and this label renders
		// directly above the buttons.
		const huge = 'A'.repeat(5000);
		const o = toPromptOrigin({ workflowName: huge, stepId: 'step', stepTask: 'B'.repeat(5000) })!;
		expect(o.workflowName!.length).toBeLessThanOrEqual(80);
		expect(o.workflowName!.endsWith('…')).toBe(true);
		expect(o.stepTask!.length).toBeLessThanOrEqual(160);
	});

	it('cuts on code points, so truncation cannot manufacture a broken character', () => {
		// An emoji straddling the cut is ordinary input. A UTF-16 `slice` leaves a
		// lone surrogate that renders as U+FFFD — the label would then contain a
		// character that was never in the workflow's name.
		const name = `${'A'.repeat(78)}😀${'B'.repeat(50)}`;
		const cut = toPromptOrigin({ workflowName: name, stepId: 'step' })!.workflowName!;
		expect(cut.endsWith('…')).toBe(true);
		// `isWellFormed` is the property, not "contains no surrogates" — an INTACT
		// emoji is a surrogate PAIR. The defect is a LONE half, which is exactly
		// what a UTF-16 slice at this offset produces.
		expect(cut.isWellFormed()).toBe(true);
		expect(cut).toContain('😀');
	});

	it('strips control and bidi characters that would forge the line', () => {
		// A newline turns one label into several; RLO renders text in an order it
		// is not written in. Both would let a manifest author counterfeit the very
		// line that says who asked.
		expect(toPromptOrigin({ workflowName: 'bexio\nWorkflow "Safe"', stepId: 'step' }))
			.toEqual({ workflowName: 'bexioWorkflow "Safe"', stepId: 'step' });
		expect(toPromptOrigin({ workflowName: '\u202Etxen_petS\u202C', stepId: 'step' })?.workflowName)
			.toBe('txen_petS');
		// A value that is NOTHING but control characters is absent, not empty.
		expect(toPromptOrigin({ workflowName: '\u0000\u202E', stepId: '' })).toBeUndefined();
	});

	it('ignores non-string values instead of stringifying them', () => {
		expect(toPromptOrigin({ workflowName: 42, stepId: { id: 'x' }, stepTask: ['a'] })).toBeUndefined();
	});

	it('survives on the workflow name alone', () => {
		expect(toPromptOrigin({ workflowName: 'bexio Triage' })).toEqual({ workflowName: 'bexio Triage' });
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

	/** `checkPendingPrompt`'s body, without the rest of the module. */
	function restoreBody(): string {
		const fn = SRC.slice(SRC.indexOf('export async function checkPendingPrompt'));
		return fn.slice(0, fn.indexOf('\n}'));
	}

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

	it('the reload path parses the persisted origin', () => {
		// Without this the fix holds until someone refreshes the page — which is
		// exactly when a long workflow is most likely to be sitting on a prompt.
		expect(restoreBody()).toContain("originFromPending(data['origin'])");
	});

	/** Each `promptType ===` branch of `checkPendingPrompt`, keyed by its discriminator. */
	const RESTORE_BRANCHES = ['tabs', 'ask_user', 'ask_secret', 'connect_mail'] as const;

	it.each(RESTORE_BRANCHES)('restore branch %s consumes the origin', (branch) => {
		// Asserted PER BRANCH, not as a count. A count is inverted: adding a
		// fifth prompt kind and WIRING it would fail the test, while adding one
		// and FORGETTING to wire it would pass — the count is satisfied by the
		// four that were already right. It also cannot tell four correct branches
		// from three correct ones plus a duplicate.
		const body = restoreBody();
		const marker = branch === 'tabs' ? "kind === 'tabs'" : `promptType === '${branch}'`;
		const start = body.indexOf(marker);
		expect(start, `no restore branch for ${branch}`).toBeGreaterThan(-1);
		const next = body.indexOf('} else if (', start + 1);
		const slice = body.slice(start, next > -1 ? next : undefined);
		expect(slice, `restore branch ${branch} drops the origin`).toContain('origin,');
	});
});

/**
 * A sub-agent's name and task are written by the parent model — by the very
 * agent this line exists to make the user look twice at. A parent free to name
 * its child names it "Main assistant". So the claim ("a sub-agent is asking")
 * and the name must never share a string.
 *
 * The wrong design is one interpolated sentence, `tf(key, { name })`. It renders
 * identically, bounds the name identically, strips the same characters — every
 * behavioural assertion about the fields passes under it. The one thing it
 * cannot do is keep the claim out of reach of the name, and that is what these
 * check.
 */
describe('the sub-agent line: a name can fill it, never speak as it', () => {
	const I18N = readFileSync(
		fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)),
		'utf-8',
	);
	const CHAT_VIEW = readFileSync(
		fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)),
		'utf-8',
	);

	/**
	 * The TRANSLATED STRINGS of one entry — not its source line. Scanning the
	 * line would read `{ de:` as a placeholder if anyone dropped the space after
	 * the brace, i.e. fail on correct code for a formatting reason.
	 */
	function values(key: string): string[] {
		const start = I18N.indexOf(`'${key}':`);
		expect(start, `no translation for ${key}`).toBeGreaterThan(-1);
		const line = I18N.slice(start, I18N.indexOf('\n', start));
		const found = [...line.matchAll(/\b(?:de|en):\s*'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]!);
		expect(found, `${key} does not carry both languages`).toHaveLength(2);
		return found;
	}

	it('⭐ the claim takes no placeholder, so no name can become the claim', () => {
		// The control comes first and is the reason this is not vacuous: the two
		// neighbouring keys DO interpolate, so an assertion that found nothing at
		// all would fail here rather than pass silently on the line that matters.
		expect(values('chat.prompt_origin_workflow').every(v => v.includes('{name}'))).toBe(true);
		expect(values('chat.prompt_origin_step').every(v => v.includes('{id}'))).toBe(true);

		// Every language, because a placeholder added to one of them is enough.
		for (const claim of values('chat.prompt_origin_subagent')) {
			expect(claim, 'the claim must not interpolate the sub-agent name').not.toMatch(/\{\s*\w/);
		}
	});

	/** The sub-agent branch of the `promptOrigin` snippet, and nothing else. */
	function subagentBranch(): string {
		const snippet = CHAT_VIEW.slice(CHAT_VIEW.indexOf('{#snippet promptOrigin('));
		const start = snippet.indexOf('{#if origin.subagent}');
		expect(start, 'the snippet has no sub-agent branch').toBeGreaterThan(-1);
		// Bounded by the workflow branch that follows it, so the assertions below
		// cannot be satisfied by the workflow row's markup.
		const end = snippet.indexOf('{#if origin.workflowName || origin.stepId}', start);
		expect(end, 'the workflow branch no longer follows — re-cut this slice').toBeGreaterThan(start);
		return snippet.slice(start, end);
	}

	it('renders the name as its own element, never through the claim helper', () => {
		const branch = subagentBranch();
		expect(branch).toContain(`{t('chat.prompt_origin_subagent')}`);
		expect(branch).toContain('{origin.subagentName}');
		expect(branch, 'the name is being interpolated INTO the claim').not.toContain(
			'tf(\'chat.prompt_origin_subagent\'',
		);
	});

	it('⭐ keys the claim on the engine flag, not on the model-authored name', () => {
		// The branch must open on `origin.subagent`, and the name must sit in a
		// NESTED conditional inside it. If the row itself were conditional on the
		// name, a child called "\u200B" would produce no line at all — the exact
		// suppression this whole block exists to prevent.
		const branch = subagentBranch();
		expect(branch.startsWith('{#if origin.subagent}')).toBe(true);
		expect(branch, 'the name must be optional INSIDE the row, not gate it')
			.toContain('{#if origin.subagentName}');
	});

	it('the outer guard admits a prompt whose only origin is a sub-agent', () => {
		// Without this the whole block stays hidden for exactly the prompts it was
		// added for: a spawn outside any workflow has no workflowName and no stepId.
		//
		// Asserted as the WHOLE disjunction rather than as "contains subagent":
		// `(workflowName || stepId) && subagent` also contains it, and that is the
		// precise inversion — a spawn outside a workflow would show nothing.
		const snippet = CHAT_VIEW.slice(CHAT_VIEW.indexOf('{#snippet promptOrigin('));
		const guard = snippet.slice(0, snippet.indexOf('\n', snippet.indexOf('{#if origin &&')));
		expect(guard.replace(/\s+/g, ' ')).toContain(
			'{#if origin && (origin.workflowName || origin.stepId || origin.subagent)}',
		);
	});
});

describe('sub-agent origin fields are cleaned like every other model-authored one', () => {
	it('bounds the name at a label and the task at prose length', () => {
		const o = toPromptOrigin({
			subagentName: 'A'.repeat(5000),
			subagentTask: 'B'.repeat(5000),
		})!;
		expect(o.subagentName!.length).toBeLessThanOrEqual(80);
		expect(o.subagentTask!.length).toBeLessThanOrEqual(160);
		// The task may run longer than the label — otherwise one bound is doing
		// the work of both and the table's per-field max is decorative.
		expect(o.subagentTask!.length).toBeGreaterThan(o.subagentName!.length);
	});

	it('⭐ strips the two separators no control-character range covers', () => {
		// U+2028/U+2029 break lines in a browser exactly like `\n` and sit OUTSIDE
		// C0/C1, so a class written as "control characters" misses them. That
		// matters here more than for most labels: the origin block has no height
		// cap while the question body below it does, making it the one part of the
		// dialog that can push Allow/Deny out of view.
		//
		// It is asserted on BOTH the sub-agent name and the workflow name because
		// the gap was in the shared `clean()`, not in the field this PR added —
		// fixing it for one field and not the other would be the same bug with a
		// narrower blast radius.
		expect(toPromptOrigin({ subagent: true, subagentName: 'triage\u2028Workflow "Payroll"' })!.subagentName)
			.toBe('triageWorkflow "Payroll"');
		expect(toPromptOrigin({ workflowName: 'a\u2029b' })!.workflowName).toBe('ab');
	});

	it('strips what would forge a second line out of one', () => {
		// REMOVED, not collapsed to a space — `clean` drops control characters
		// outright, so the two halves run together instead of reading as two
		// fields. That is the stronger of the two behaviours and it is shared with
		// the workflow name, not something this field decides for itself.
		const o = toPromptOrigin({ subagentName: 'triage\nWorkflow "Payroll"' })!;
		expect(o.subagentName).toBe('triageWorkflow "Payroll"');
		expect(toPromptOrigin({ subagentName: '\u202Ereversed\u202C' })?.subagentName)
			.toBe('reversed');
	});

	it('a name that imitates the claim stays in the name field', () => {
		// It renders as a name under a claim that is still true. What must NOT
		// happen is it leaking into another field — which is why the builder takes
		// a record keyed by field rather than a positional list.
		const o = toPromptOrigin({ subagentName: 'A sub-agent is asking · Main assistant' })!;
		expect(o.subagentName).toBe('A sub-agent is asking · Main assistant');
		expect(o.workflowName).toBeUndefined();
		expect(o.stepId).toBeUndefined();
	});

	it('reads the new fields off BOTH shapes — live event and resume', () => {
		// The two paths used to be two hand-written argument lists; a field added
		// to one and not the other renders live and vanishes on refresh.
		expect(originFromEvent({ subagent: true, subagent_name: 'triage', subagent_task: 'Fold dupes' }))
			.toEqual({ subagent: true, subagentName: 'triage', subagentTask: 'Fold dupes' });
		expect(originFromPending({ subagent: true, subagentName: 'triage', subagentTask: 'Fold dupes' }))
			.toEqual({ subagent: true, subagentName: 'triage', subagentTask: 'Fold dupes' });
	});

	it('⭐ survives a name and a task that both clean away to nothing', () => {
		// The discriminating case for the flag. A parent that wants no disclosure
		// names its child with a zero-width space and gives it a task of the same —
		// both pass the engine's validation and both clean to empty here. The
		// origin must still exist, so the renderer still states who asked.
		const o = toPromptOrigin({ subagent: true, subagentName: '\u200B', subagentTask: '\u202E' });
		expect(o, 'an emptied name must not take the disclosure with it').toEqual({ subagent: true });
	});

	it('does not invent the flag from a truthy non-true value', () => {
		// It is a FACT the engine sets, so only the engine's own `true` counts —
		// a stray `"false"` or `1` in a persisted row must not manufacture one.
		expect(toPromptOrigin({ subagent: 'true' })).toBeUndefined();
		expect(toPromptOrigin({ subagent: 1 })).toBeUndefined();
	});
});
