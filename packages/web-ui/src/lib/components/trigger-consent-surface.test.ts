import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A trigger that waits for a person's confirmation has to look different from
 * one that runs, the view has to offer the confirmation, and what it shows
 * beside that button has to be what the run would actually do.
 *
 * Before this, the view declared neither `confirmed_at` nor any call to
 * `POST /api/tasks/:id/confirm`: a waiting trigger rendered exactly like a
 * working one, next to a next-run date that never came. Which triggers wait is
 * decided by `awaitsConfirmation`, and `trigger-consent.test.ts` holds that
 * against the scheduler. This file holds the view to it.
 *
 * There is no component renderer in this package's tests, so, as in
 * `secret-prompt-frame.test.ts`, the assertions read SOURCE. An adversarial
 * round showed what that costs when they read it loosely: with `[^>]*` standing
 * in for a tag's attributes, the Confirm button could be given `class="hidden"`,
 * or `disabled={true}`, or lose its `aria-label`, and every assertion stayed
 * green. So the elements that carry the consent are compared WHOLE — the same
 * reason a rarely-changed artefact is pinned whole elsewhere: an attribute no
 * assertion happens to mention is exactly where a regression hides.
 */
const VIEW = readFileSync(fileURLToPath(new URL('./TriggersView.svelte', import.meta.url)), 'utf-8');
const SCRIPT_END = VIEW.indexOf('</script>');
const SCRIPT = VIEW.slice(0, SCRIPT_END);
const TEMPLATE = VIEW.slice(SCRIPT_END).replace(/<!--[\s\S]*?-->/g, '');

/** The body of `{#if <cond>}` that opens on the line holding `marker`, up to its own `{/if}` at the same indent. */
function ifBlockAround(marker: string): { cond: string; body: string } {
	const at = TEMPLATE.indexOf(marker);
	expect(at, `${marker} is gone from TriggersView`).toBeGreaterThan(-1);
	const open = TEMPLATE.lastIndexOf('{#if ', at);
	expect(open, `no {#if} before ${marker}`).toBeGreaterThan(-1);
	const lineStart = TEMPLATE.lastIndexOf('\n', open) + 1;
	const indent = TEMPLATE.slice(lineStart, open);
	expect(indent, 'the {#if} must start its own line').toMatch(/^\t*$/);
	const condEnd = TEMPLATE.indexOf('}', open);
	const close = TEMPLATE.indexOf(`\n${indent}{/if}`, open);
	expect(close, `the {#if} around ${marker} is never closed at its own indent`).toBeGreaterThan(at);
	return { cond: TEMPLATE.slice(open + '{#if '.length, condEnd), body: TEMPLATE.slice(condEnd + 1, close) };
}

/** One line of the template, trimmed — the unit the whole-tag comparisons below use. */
function line(contains: string): string {
	const at = TEMPLATE.indexOf(contains);
	expect(at, `${contains} is gone from TriggersView`).toBeGreaterThan(-1);
	const start = TEMPLATE.lastIndexOf('\n', at) + 1;
	const end = TEMPLATE.indexOf('\n', at);
	return TEMPLATE.slice(start, end === -1 ? undefined : end).trim();
}

describe('the triggers view shows the waiting state and offers the confirmation', () => {
	it('uses the tested helpers, not local copies of the rules', () => {
		// Every decision this block makes — who waits, what the run is told, which
		// page a watch reads, what is safe to render — lives in a module with
		// behaviour tests. A copy in the component would be a second rule with no
		// test, and the source assertions here cannot see what a copy does.
		expect(SCRIPT).toContain(
			"import { awaitsConfirmation, confirmationOutcome, displaySafe, instructionOf, watchOf } from '../utils/trigger-consent.js';",
		);
		for (const name of ['awaitsConfirmation', 'confirmationOutcome', 'displaySafe', 'instructionOf', 'watchOf']) {
			expect(SCRIPT, name).not.toMatch(new RegExp(`function\\s+${name}|${name}\\s*=`));
		}
	});

	it('a waiting trigger carries its own badge, whole', () => {
		const { cond, body } = ifBlockAround("t('triggers.awaiting_confirmation')");
		expect(cond).toBe('awaitsConfirmation(trigger)');
		expect(body.trim()).toBe(
			'<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-warning/15 px-1.5 py-0.5 text-warning">'
			+ "{t('triggers.awaiting_confirmation')}</span>",
		);
	});

	it('the consent block is pinned whole at its root, and says the trigger will not run', () => {
		const { cond, body } = ifBlockAround('data-trigger-consent');
		expect(cond).toBe('awaitsConfirmation(trigger)');
		// The ROOT tag, compared whole. A delta round put `class="hidden"` on this
		// one element and every assertion below still passed: the block vanished,
		// the button with it, and the suite was green. Pinning the button alone was
		// not enough — the element ABOVE it decides whether any of it renders.
		expect(line('data-trigger-consent')).toBe('<div class="mt-2 space-y-1.5" data-trigger-consent>');
		expect(body.trim().startsWith('<div')).toBe(true);
		expect(body).toContain('<button onclick={() => confirmTrigger(trigger)}');
		expect(line("t('triggers.awaiting_hint')")).toBe(
			`<p class="text-xs text-warning">{t('triggers.awaiting_hint')}</p>`,
		);
	});

	it('the Confirm button is pinned whole — class, state and accessible name included', () => {
		expect(line('<button onclick={() => confirmTrigger(trigger)}')).toBe(
			'<button onclick={() => confirmTrigger(trigger)} disabled={busy[trigger.id]}'
			+ " aria-label={t('triggers.confirm_label')} title={t('triggers.confirm_label')}"
			+ ' class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1 text-xs text-accent-text'
			+ ' hover:bg-accent/15 disabled:opacity-40">{t(\'triggers.confirm\')}</button>',
		);
	});

	it('what would run comes BEFORE the button, not after it', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		const button = body.indexOf('<button onclick={() => confirmTrigger(trigger)}');
		for (const marker of ['data-consent-watch', 'data-consent-instruction', "t('triggers.awaiting_hint')"]) {
			expect(body.indexOf(marker), marker).toBeGreaterThan(-1);
			expect(body.indexOf(marker), marker).toBeLessThan(button);
		}
	});

	it('a watch is shown its page and its cadence INSTEAD of an instruction it never gets', () => {
		// `executeWatch` builds its prompt from the URL and the fetched page and
		// reads neither title nor description, so showing "Instruction" there named
		// something the run does not receive.
		const { cond, body } = ifBlockAround('data-consent-watch');
		expect(cond).toBe('watchOf(trigger)');
		expect(line('data-consent-watch')).toBe('<div class="text-xs text-text-muted" data-consent-watch>');
		// The two are the branches of ONE conditional, so they can never both show
		// and a watch can never fall through to the wrong one. Split at the `{:else}`
		// that separates them and check each side holds what it should.
		const elseAt = body.indexOf('{:else}');
		expect(elseAt, 'the watch branch has no {:else}').toBeGreaterThan(-1);
		const watchSide = body.slice(0, elseAt);
		const instructionSide = body.slice(elseAt);
		expect(watchSide).toContain("{displaySafe(watchOf(trigger)?.url ?? '')}");
		expect(watchSide).toContain("tf('triggers.watch_every', { minutes: String(watchOf(trigger)?.intervalMinutes) })");
		expect(watchSide).not.toContain('data-consent-instruction');
		expect(watchSide).not.toContain('instructionOf(trigger)');
		expect(instructionSide).toContain('data-consent-instruction');
		expect(line('data-consent-instruction')).toBe('<div class="text-xs text-text-muted" data-consent-instruction>');
		expect(line('{displaySafe(instructionOf(trigger))}')).toBe(
			'<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words'
			+ ' rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">'
			+ '{displaySafe(instructionOf(trigger))}</p>',
		);
	});

	it('every agent-authored string in the block goes through displaySafe', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		// A bare `{trigger.x}` renders what the agent wrote with its overrides and
		// invisible spaces intact — in the text a person reads before granting the run.
		expect(body.match(/\{trigger\.[a-z_]+\}/g) ?? []).toEqual([]);
		expect(body).not.toContain('{@html');
	});

	it('each outcome gets its own sentence, and the sentences are not swapped', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		// Swapping the two date sentences passed a `toContain` pair, so the branch
		// and its key are pinned together: a paused trigger promises nothing, a past
		// date says it runs now, a future date names the date, and anything the
		// scheduler will not run at all says so.
		for (const [outcome, key] of [
			['paused', "{t('triggers.awaiting_paused')}"],
			['due-now', "{tf('triggers.awaiting_due_since', { date: fmtDate(trigger.next_run_at ?? '') })}"],
			['scheduled', "{tf('triggers.awaiting_first_run', { date: fmtDate(trigger.next_run_at ?? '') })}"],
		] as const) {
			const branch = `confirmationOutcome(trigger) === '${outcome}'`;
			const at = body.indexOf(branch);
			expect(at, branch).toBeGreaterThan(-1);
			const nextBranch = body.indexOf('confirmationOutcome(trigger) ===', at + branch.length);
			const slice = body.slice(at, nextBranch === -1 ? undefined : nextBranch);
			expect(slice, branch).toContain(key);
		}
		expect(body).toContain("{:else}");
		expect(body).toContain("{t('triggers.awaiting_not_scheduled')}");
	});

	it('confirming calls the existing confirm route with POST, and reports what it did', () => {
		const start = SCRIPT.indexOf('async function confirmTrigger(');
		expect(start, 'confirmTrigger is gone').toBeGreaterThan(-1);
		const fn = SCRIPT.slice(start, SCRIPT.indexOf('\n\t}', start));
		expect(fn).toContain("fetch(`${getApiBase()}/tasks/${trigger.id}/confirm`, { method: 'POST' })");
		expect(fn).toContain('await loadTriggers()');
		// The message may not claim a schedule the scheduler does not honour.
		// The message speaks from the row the route returned, not from list state.
		expect(fn).toContain("const stored = (await res.json().catch(() => null)) as Trigger | null;");
		expect(fn).toContain("const paused = (stored ?? trigger).enabled === 0;");
		expect(fn).toContain("addToast(paused ? t('triggers.confirmed_paused') : t('triggers.confirmed'), 'success')");
		expect(fn).toContain("addToast(t('triggers.confirm_failed'), 'error')");
	});

	it('a waiting trigger shows no next-run label and no run-now', () => {
		const next = ifBlockAround("t('tasks.next_run')");
		// The whole condition, not `toContain`: an `|| true` appended to it leaves the
		// expected text in place and puts the date back on a waiting trigger.
		expect(next.cond).toBe('trigger.next_run_at && trigger.enabled !== 0 && !awaitsConfirmation(trigger)');
		const run = ifBlockAround('runNow(trigger)');
		expect(run.cond).toBe('!awaitsConfirmation(trigger)');
		expect(run.body.trim().startsWith('<button onclick={() => runNow(trigger)}')).toBe(true);
	});

	it('the controls hide on hover-capable pointers, not at a width', () => {
		// A touch screen wider than `sm` has no hover either: keyed on the width, the
		// controls were unreachable there with no rule left to bring them back.
		for (const control of ['runNow(trigger)', 'togglePause(trigger)', 'manageInChat(trigger)', 'deleteTrigger(trigger)']) {
			const tag = line(`<button onclick={() => ${control}}`);
			expect(tag, control).toContain('[@media(hover:hover)]:opacity-0');
			expect(tag, control).toContain('group-hover:opacity-100');
			expect(tag, control).not.toContain('sm:opacity-0');
		}
	});
});
