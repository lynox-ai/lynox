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
			"import { awaitsConfirmation, displaySafe, instructionOf, watchUrlOf } from '../utils/trigger-consent.js';",
		);
		for (const name of ['awaitsConfirmation', 'displaySafe', 'instructionOf', 'watchUrlOf']) {
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

	it('the consent block is gated on exactly the predicate, and says the trigger will not run', () => {
		const { cond, body } = ifBlockAround('data-trigger-consent');
		expect(cond).toBe('awaitsConfirmation(trigger)');
		// Both ends of the slice: it starts at the block's own element and reaches its
		// button, so nothing below can pass on a truncated slice.
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

	it('the instruction is shown for EVERY waiting trigger, not only when a description differs', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		// No condition around it: a run_agent trigger with no description runs on its
		// title, and that title is clipped to two lines in the header above.
		expect(body).toContain("<span class=\"font-medium\">{t('triggers.instruction')}:</span>");
		expect(line('{displaySafe(instructionOf(trigger))}')).toBe(
			'<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words'
			+ ' rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">'
			+ '{displaySafe(instructionOf(trigger))}</p>',
		);
	});

	it('a watch trigger names the page it would fetch, and a routed result names where it goes', () => {
		const url = ifBlockAround("t('triggers.watch_url')");
		expect(url.cond).toBe('watchUrlOf(trigger)');
		expect(url.body).toContain("{displaySafe(watchUrlOf(trigger) ?? '')}");
		const channel = ifBlockAround("t('triggers.result_goes_to')");
		expect(channel.cond).toBe('trigger.notification_channel');
		expect(channel.body).toContain('{displaySafe(trigger.notification_channel)}');
	});

	it('every agent-authored string in the block goes through displaySafe', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		// A bare `{trigger.x}` renders what the agent wrote with its bidi overrides and
		// zero-width runs intact — in the text a person reads before granting the run.
		expect(body.match(/\{trigger\.[a-z_]+\}/g) ?? []).toEqual([]);
		expect(body).not.toContain('{@html');
	});

	it('the block says when the first run falls, and does not promise a schedule while paused', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		expect(body).toContain("{t('triggers.awaiting_paused')}");
		expect(body).toContain("tf('triggers.awaiting_due_since', { date: fmtDate(trigger.next_run_at) })");
		expect(body).toContain("tf('triggers.awaiting_first_run', { date: fmtDate(trigger.next_run_at) })");
		// Which of the two is a comparison against now, not a guess from the cron.
		expect(body).toContain('new Date(trigger.next_run_at).getTime() <= Date.now()');
		// The paused branch comes FIRST: a paused trigger gets no run-time promise at all.
		expect(body.indexOf("{t('triggers.awaiting_paused')}")).toBeLessThan(body.indexOf("tf('triggers.awaiting_due_since'"));
	});

	it('confirming calls the existing confirm route with POST, and reports what it did', () => {
		const start = SCRIPT.indexOf('async function confirmTrigger(');
		expect(start, 'confirmTrigger is gone').toBeGreaterThan(-1);
		const fn = SCRIPT.slice(start, SCRIPT.indexOf('\n\t}', start));
		expect(fn).toContain("fetch(`${getApiBase()}/tasks/${trigger.id}/confirm`, { method: 'POST' })");
		expect(fn).toContain('await loadTriggers()');
		// The message may not claim a schedule the scheduler does not honour.
		expect(fn).toContain("trigger.enabled === 0 ? t('triggers.confirmed_paused') : t('triggers.confirmed')");
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
