<script lang="ts">
	import { t, getLocale } from '../i18n.svelte.js';
	import type { InboxThreadResponse } from '../stores/inbox.svelte.js';

	interface Props {
		thread: InboxThreadResponse;
		/** Highlight the message that matches the selected item (currently rendered above). */
		currentMessageId?: string | undefined;
	}

	const { thread, currentMessageId }: Props = $props();

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
				<li
					role="listitem"
					class="rounded-[var(--radius-sm)] border bg-bg-subtle px-3 py-2 text-sm {currentMessageId !== undefined && msg.messageId === currentMessageId ? 'border-accent' : 'border-border'}"
				>
					<div class="flex items-baseline justify-between gap-2">
						<span class="truncate text-[12px] text-text-muted">
							{senderLabel(msg.direction, msg.fromName, msg.fromAddress)}
						</span>
						<span class="shrink-0 text-[11px] text-text-subtle">{dateFormat(msg.mailDate)}</span>
					</div>
					{#if msg.subject}
						<p class="truncate text-[12px] text-text" title={msg.subject}>{msg.subject}</p>
					{/if}
					{#if msg.snippet}
						<p class="mt-1 line-clamp-2 text-[11px] text-text-subtle">{msg.snippet}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
