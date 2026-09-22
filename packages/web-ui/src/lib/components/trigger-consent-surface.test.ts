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
	// Uniqueness, because every assertion below reads the FIRST match: a second
	// Confirm button appended beside the gated one passed this whole file once.
	expect(TEMPLATE.indexOf(marker, at + 1), `${marker} appears more than once`).toBe(-1);
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
	expect(TEMPLATE.indexOf(contains, at + 1), `${contains} appears more than once`).toBe(-1);
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
			"import { awaitsConfirmation, displaySafe, instructionOf, offersConfirmation, showsInstruction, showsWatchTarget, watchOf } from '../utils/trigger-consent.js';",
		);
		for (const name of ['awaitsConfirmation', 'displaySafe', 'instructionOf', 'offersConfirmation', 'showsInstruction', 'showsWatchTarget', 'watchOf']) {
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
		for (const marker of ['data-consent-instruction', 'data-consent-watch', "t('triggers.awaiting_hint')"]) {
			expect(body.indexOf(marker), marker).toBeGreaterThan(-1);
			expect(body.indexOf(marker), marker).toBeLessThan(button);
		}
	});

	it('the instruction is gated on showsInstruction, the watch target on showsWatchTarget', () => {
		const instruction = ifBlockAround('data-consent-instruction');
		expect(instruction.cond).toBe('showsInstruction(trigger)');
		expect(line('data-consent-instruction')).toBe('<div class="text-xs text-text-muted" data-consent-instruction>');
		expect(line('{displaySafe(instructionOf(trigger))}')).toBe(
			'<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words'
			+ ' rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">'
			+ '{displaySafe(instructionOf(trigger))}</p>',
		);
		const watch = ifBlockAround('data-consent-watch');
		expect(watch.cond).toBe('showsWatchTarget(trigger)');
		expect(line('data-consent-watch')).toBe('<div class="text-xs text-text-muted" data-consent-watch>');
		// Whole tags, like the instruction box next door: a round put `hidden` on
		// each of these three in turn and every assertion here stayed green.
		expect(line('{displaySafe(watchOf(trigger)?.host')).toBe(
			'<p class="mt-0.5 break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">'
			+ '<span class="font-medium text-text">{displaySafe(watchOf(trigger)?.host ?? \'\')}</span>'
			+ "{displaySafe(watchOf(trigger)?.rest ?? '')}</p>",
		);
		expect(line('data-consent-cadence')).toBe(
			'<p class="mt-0.5" data-consent-cadence>'
			+ "{tf('triggers.watch_every', { minutes: String(watchOf(trigger)?.intervalMinutes) })}</p>",
		);
		// The two never both render: an instruction belongs to the standard run, a
		// target to the watch, and `showsWatchTarget` requires the watch source.
		expect(instruction.body).not.toContain('data-consent-watch');
		expect(watch.body).not.toContain('data-consent-instruction');
	});

	it('ONE gate decides the button, for both kinds', () => {
		// The button may not outlive the thing it consents to, and it may not be
		// duplicated per kind — one conditional, asserted whole, plus the count.
		const button = ifBlockAround('confirmTrigger(trigger)');
		expect(button.cond).toBe('offersConfirmation(trigger)');
		expect(TEMPLATE.split('confirmTrigger(trigger)')).toHaveLength(2);
	});

	it('says nothing about WHEN the run comes', () => {
		// Two earlier versions did, and both spoke for reasons consent does not
		// settle. The scheduler's answer is not this block's to give.
		const { body } = ifBlockAround('data-trigger-consent');
		expect(body).not.toMatch(/next_run_at|fmtDate|schedule_cron/);
	});

	it('every agent-authored string in the block goes through displaySafe', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		// A bare `{trigger.x}` renders what the agent wrote with its overrides and
		// invisible spaces intact — in the text a person reads before granting the run.
		expect(body.match(/\{trigger\.[a-z_]+\}/g) ?? []).toEqual([]);
		expect(body).not.toContain('{@html');
		// No link, either: wrapping the address in an `<a href={…}>` passed every
		// assertion in this file once, and a `javascript:` address is one click away
		// on the surface whose job is to make the decision informed.
		expect(body).not.toMatch(/<a\b/);
		expect(body).not.toContain('href');
	});

	it('confirming calls the existing confirm route with POST, and reports what it did', () => {
		const start = SCRIPT.indexOf('async function confirmTrigger(');
		expect(start, 'confirmTrigger is gone').toBeGreaterThan(-1);
		const fn = SCRIPT.slice(start, SCRIPT.indexOf('\n\t}', start));
		expect(fn).toContain("fetch(`${getApiBase()}/tasks/${trigger.id}/confirm`, { method: 'POST' })");
		expect(fn).toContain('await loadTriggers()');
		// The message may not claim a schedule the scheduler does not honour.
		expect(fn).toContain("addToast(t('triggers.confirmed'), 'success')");
		expect(fn).toContain("addToast(t('triggers.confirm_failed'), 'error')");
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

	it('there is exactly ONE Confirm button in the whole view', () => {
		// Not a style rule: a second one, appended inside the block behind
		// `{#if !showsInstruction(trigger)}`, gives a watch the button that the gate
		// exists to withhold — and every "pinned whole" assertion here reads the
		// first match, so it went green.
		expect(TEMPLATE.split('confirmTrigger(trigger)')).toHaveLength(2);
	});

	it('each label is pinned INSIDE its own block, so the two cannot be swapped', () => {
		// They were pinned by searching the template for the key, which found the
		// first match and checked that the SEARCH STRING is unique — not that the
		// shape is. With a second, textually identical span in the watch block, the
		// two keys could be exchanged: the instruction box then reads "Watched page"
		// and the address reads "Instruction (written by lynox)". Measured, survived.
		const instruction = ifBlockAround('data-consent-instruction').body;
		expect(instruction).toContain(
			`<span class="font-medium" data-consent-label="instruction">{t('triggers.instruction')}:</span>`,
		);
		expect(instruction).not.toContain("triggers.watch_url");
		const watch = ifBlockAround('data-consent-watch').body;
		expect(watch).toContain(
			`<span class="font-medium" data-consent-label="watch">{t('triggers.watch_url')}:</span>`,
		);
		expect(watch).not.toContain("triggers.instruction");
	});

	it('the card stacks below `sm`, which is what makes the instruction readable there', () => {
		// The commit that added this said the tests pinned it; they did not, and all
		// three class changes reverted green. The controls are ~290px on a ~310px
		// card, so side by side left the text column a few pixels and the title —
		// `line-clamp`, so `overflow: hidden` — collapsed to nothing.
		expect(line('<div class="flex flex-col gap-2 sm:flex-row')).toBe(
			'<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">',
		);
		expect(line('<div class="flex flex-wrap items-center gap-2 sm:shrink-0')).toBe(
			'<div class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:mt-0.5">',
		);
		// …and the badges wrap instead of squeezing the title out of its own row.
		expect(line('<div class="flex flex-wrap items-center gap-x-2 gap-y-1">')).toBe(
			'<div class="flex flex-wrap items-center gap-x-2 gap-y-1">',
		);
	});

	it('the controls hide on hover-capable pointers, not at a width', () => {
		// A touch screen wider than `sm` has no hover either: keyed on the width, the
		// controls were unreachable there with no rule left to bring them back.
		for (const control of ['runNow(trigger)', 'togglePause(trigger)', 'manageInChat(trigger)', 'deleteTrigger(trigger)']) {
			const tag = line(`<button onclick={() => ${control}}`);
			expect(tag, control).toContain('[@media(hover:hover)]:opacity-0');
			expect(tag, control).toContain('group-hover:opacity-100');
			// Any width-keyed hide, not just the one that was there: `md:opacity-0`
			// beside the pointer rule passed, and reintroduces the same dead end on a
			// touch screen wider than that breakpoint.
			expect(tag, control).not.toMatch(/(sm|md|lg|xl|2xl):opacity-0/);
		}
	});
});
