<script lang="ts">
	import { tick } from 'svelte';
	import { t, getLocale } from '../i18n.svelte.js';
	import type { InboxThreadResponse } from '../stores/inbox.svelte.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';

	interface Props {
		thread: InboxThreadResponse;
		/** Highlight the message that matches the selected item (currently rendered above). */
		currentMessageId?: string | undefined;
		/** Bring this message into view, open it and move the focus to it; `seq` repeats the jump. */
		focusRequest?: { id: string; seq: number } | undefined;
	}

	const { thread, currentMessageId, focusRequest }: Props = $props();

	// Track which thread message is expanded. Per-id state so multiple
	// can be open simultaneously when the user is comparing replies.
	let expanded = $state<Record<string, boolean>>({});

	function toggle(id: string): void {
		expanded[id] = !expanded[id];
	}

	let messageEls = $state<Record<string, HTMLElement | undefined>>({});

	// The message the last jump went to. It carries the focus mark also after a mouse click, which
	// shows no focus ring of its own, until the next click anywhere or the focus leaves it.
	let jumpedTo = $state<string | undefined>(undefined);

	// A jump from the reading pane's notice: open the message, then scroll to it and give it the
	// focus, so keyboard and screen reader land on the new mail too.
	$effect(() => {
		const req = focusRequest;
		if (req === undefined) return;
		if (thread.messages.some((m) => m.id === req.id && Boolean(m.bodyMd || m.snippet))) expanded[req.id] = true;
		void tick().then(() => {
			const el = messageEls[req.id];
			if (el === undefined) return;
			if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
			el.focus({ preventScroll: true });
			jumpedTo = req.id;
		});
	});

	// The mark goes with the next mouse or pen click. Listened to from the jump on, so the click
	// that made the jump (already handled when the listener is added) does not clear it. A touch
	// does not clear it: on a phone the first touch is often the scroll toward the message; a tap
	// elsewhere moves the focus and so clears it on blur.
	$effect(() => {
		if (jumpedTo === undefined || typeof document === 'undefined') return;
		const clear = (e: PointerEvent): void => {
			if (e.pointerType === 'touch') return;
			jumpedTo = undefined;
		};
		document.addEventListener('pointerdown', clear, { capture: true });
		return () => document.removeEventListener('pointerdown', clear, { capture: true });
	});

	function dateFormat(iso: string | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		const sameYear = d.getFullYear() === new Date().getFullYear();
		return sameYear
			? d.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	function senderLabel(direction: 'inbound' | 'outbound' | 'unknown', fromName: string | undefined, fromAddress: string): string {
		if (direction === 'outbound') return t('inbox.thread_message_outbound');
		return fromName || fromAddress;
	}
</script>

<section aria-label={t('inbox.thread_history_title')}>
	<h3 class="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
		{t('inbox.thread_history_title')}
	</h3>
	{#if thread.partial}
		<p class="mb-2 rounded-[var(--radius-sm)] border border-border-subtle bg-bg-subtle px-3 py-2 text-[11px] text-text-subtle">
			{t('inbox.thread_history_partial')}
		</p>
	{/if}
	{#if thread.messages.length === 0}
		<p class="text-[11px] text-text-subtle">{t('inbox.thread_history_empty')}</p>
	{:else}
		<ul class="space-y-2" role="list">
			{#each thread.messages as msg (msg.id)}
				{@const isExpandable = Boolean(msg.bodyMd || msg.snippet)}
				{@const isOpen = expanded[msg.id] === true}
				<li
					role="listitem"
					tabindex="-1"
					bind:this={messageEls[msg.id]}
					data-thread-message-id={msg.id}
					data-jump-target={jumpedTo === msg.id ? 'true' : undefined}
					onblur={() => { if (jumpedTo === msg.id) jumpedTo = undefined; }}
					class="rounded-[var(--radius-sm)] border bg-bg-subtle text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent {jumpedTo === msg.id ? 'ring-2 ring-accent' : ''} {currentMessageId !== undefined && msg.messageId === currentMessageId ? 'border-accent' : 'border-border'}"
				>
					<!-- Header is a button when there's body/snippet content to reveal,
						a plain div otherwise. Touch-sized; aria-expanded reflects state. -->
					<button
						type="button"
						class="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-bg-muted/30 rounded-[var(--radius-sm)] min-h-[44px] {!isExpandable ? 'cursor-default' : ''}"
						onclick={() => isExpandable && toggle(msg.id)}
						aria-expanded={isExpandable ? isOpen : undefined}
						disabled={!isExpandable}
					>
						{#if isExpandable}
							<span class="text-text-subtle text-[11px] mt-0.5 shrink-0" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="flex items-baseline justify-between gap-2">
								<span class="truncate text-[12px] text-text-muted">
									{senderLabel(msg.direction, msg.fromName, msg.fromAddress)}
								</span>
								<span class="shrink-0 text-[11px] text-text-subtle">{dateFormat(msg.mailDate)}</span>
							</div>
							{#if msg.subject}
								<p class="truncate text-[12px] text-text" title={msg.subject}>{msg.subject}</p>
							{/if}
							{#if !isOpen && msg.snippet}
								<p class="mt-1 line-clamp-2 text-[11px] text-text-subtle">{msg.snippet}</p>
							{:else if !isExpandable && msg.confidential === true}
								<p class="mt-1 text-[11px] text-text-subtle" data-testid="inbox-thread-message-withheld">{t('inbox.thread_message_confidential')}</p>
							{/if}
						</div>
					</button>
					{#if isOpen}
						<div class="border-t border-border px-3 py-3">
							{#if msg.bodyMd}
								<article class="prose prose-sm max-w-none text-[13px]">
									<MarkdownRenderer content={msg.bodyMd} streaming={false} />
								</article>
							{:else if msg.snippet}
								<p class="text-[12px] text-text-muted whitespace-pre-wrap">{msg.snippet}</p>
								<p class="mt-2 text-[11px] text-text-subtle italic">{t('inbox.thread_message_body_snippet_only')}</p>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
