<script lang="ts">
	import { t, getLocale } from '../i18n.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import {
		getItemContext,
		type InboxContext,
	} from '../api/inbox-context.js';

	interface Props {
		itemId: string | null;
		onClose?: (() => void) | undefined;
	}
	const { itemId, onClose }: Props = $props();

	let context = $state<InboxContext | null>(null);
	let loading = $state(false);
	let error = $state(false);
	// Monotonically increasing fetch token: rapid A→B→A clicks can race so
	// that an early response races a later one — id-equality alone fails
	// when user revisits the same item before the first fetch resolves.
	let nextToken = 0;
	let lastSeenItemId: string | null = null;

	$effect(() => {
		if (itemId === null) {
			context = null;
			lastSeenItemId = null;
			return;
		}
		if (itemId === lastSeenItemId) return;
		lastSeenItemId = itemId;
		loading = true;
		error = false;
		const myToken = ++nextToken;
		const id = itemId;
		void (async () => {
			const result = await getItemContext(getApiBase(), id);
			if (myToken !== nextToken) return; // a later fetch superseded us
			if (result === null) {
				context = null;
				error = true;
			} else {
				context = result;
				error = false;
			}
			loading = false;
		})();
	});

	function dateOnly(iso: string | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
	}

	function dateTime(iso: string | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<aside class="flex h-full flex-col border-l border-border bg-bg" aria-label={t('inbox.context_sidebar_title')}>
	<header class="flex items-center justify-between border-b border-border px-4 py-3">
		<h3 class="text-[12px] font-medium text-text">{t('inbox.context_sidebar_title')}</h3>
		{#if onClose}
			<button
				type="button"
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-subtle hover:text-text hover:border-border-hover"
				onclick={onClose}
				aria-label={t('inbox.context_sidebar_close')}
			>×</button>
		{/if}
	</header>

	<div class="flex-1 overflow-y-auto px-4 py-3 space-y-5">
		{#if loading && context === null}
			<div class="space-y-2" aria-busy="true">
				<div class="h-3 w-1/2 animate-pulse rounded bg-bg-subtle"></div>
				<div class="h-3 w-3/4 animate-pulse rounded bg-bg-subtle"></div>
				<div class="h-3 w-2/3 animate-pulse rounded bg-bg-subtle"></div>
			</div>
		{:else if error}
			<p class="text-[11px] text-text-subtle">{t('inbox.context_unavailable')}</p>
		{:else if context}
			{#if context.sender.address}
				<div class="text-[11px] text-text-muted truncate" title={context.sender.address}>
					{#if context.sender.name}
						<span class="text-text">{context.sender.name}</span>
						<span class="text-text-subtle">&lt;{context.sender.address}&gt;</span>
					{:else}
						{context.sender.address}
					{/if}
				</div>
			{/if}

			<section>
				<h4 class="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
					{t('inbox.context_section_recent_threads')}
				</h4>
				{#if context.recentThreads.length === 0}
					<p class="text-[11px] text-text-subtle">{t('inbox.context_empty_recent_threads')}</p>
				{:else}
					<ul class="space-y-1">
						{#each context.recentThreads as item (item.id)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]">
								<span class="truncate text-text" title={item.subject}>{item.subject}</span>
								<span class="shrink-0 text-text-subtle">{dateOnly(item.mailDate ?? item.classifiedAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			{#if context.openFollowups.length > 0}
				<section>
					<h4 class="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
						{t('inbox.context_section_followups')}
					</h4>
					<ul class="space-y-1">
						{#each context.openFollowups as fu (fu.id)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]">
								<span class="truncate text-text" title={fu.reason}>{fu.reason}</span>
								<span class="shrink-0 text-text-subtle">{dateOnly(fu.reminderAt)}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section>
				<h4 class="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
					{t('inbox.context_section_outbound')}
				</h4>
				{#if context.outboundHistory.length === 0}
					<p class="text-[11px] text-text-subtle">{t('inbox.context_empty_outbound')}</p>
				{:else}
					<ul class="space-y-1">
						{#each context.outboundHistory as out (out.id)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]">
								<span class="truncate text-text" title={out.subject}>{out.subject}</span>
								<span class="shrink-0 text-text-subtle">{dateTime(out.sentAt)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			{#if context.reminders.length > 0}
				<section>
					<h4 class="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
						{t('inbox.context_section_reminders')}
					</h4>
					<ul class="space-y-1">
						{#each context.reminders as r (r.id)}
							<li class="flex items-baseline justify-between gap-2 text-[11px]">
								<span class="truncate text-text" title={r.subject}>{r.subject}</span>
								<span class="shrink-0 text-text-subtle">{dateTime(r.snoozeUntil)}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/if}
	</div>
</aside>
