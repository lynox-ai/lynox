<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t, getLocale } from '../i18n.svelte.js';
	import {
		getInboxCounts,
		getInboxItems,
		isInboxAvailable,
		isLoading,
		loadInboxCounts,
		loadInboxItems,
		setItemAction,
		setItemSnooze,
		startColdStartPolling,
		startInboxVisibilityRefresh,
		type InboxBucket,
		type InboxItem,
	} from '../stores/inbox.svelte.js';
	import ColdStartBanner from './ColdStartBanner.svelte';

	let zone = $state<InboxBucket>('requires_user');
	let openSnoozeFor = $state<string | null>(null);

	let cleanupVisibility: (() => void) | undefined;
	let cleanupColdStart: (() => void) | undefined;

	onMount(async () => {
		await loadInboxCounts();
		if (isInboxAvailable()) {
			await loadInboxItems(zone);
			cleanupColdStart = startColdStartPolling();
		}
		cleanupVisibility = startInboxVisibilityRefresh();
	});

	onDestroy(() => {
		cleanupVisibility?.();
		cleanupColdStart?.();
	});

	$effect(() => {
		// Re-fetch when zone changes (only when feature is available).
		if (zone && isInboxAvailable()) {
			void loadInboxItems(zone);
		}
	});

	function dateFormat(iso: string): string {
		const d = new Date(iso);
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		const now = new Date();
		const sameDay = d.toDateString() === now.toDateString();
		return sameDay
			? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
	}

	function channelLabel(c: InboxItem['channel']): string {
		return c === 'whatsapp' ? t('inbox.channel_whatsapp') : t('inbox.channel_email');
	}

	function accountShortLabel(accountId: string): string {
		// Account id is either a mail-account id (cuid-style) or a WA pseudo
		// id `whatsapp:<phoneNumberId>`. Both are opaque to the UI — surface
		// the trailing segment for visual disambiguation; the full address
		// renders in the item's hover-tooltip via the `title` attribute.
		const colonIdx = accountId.indexOf(':');
		return colonIdx >= 0 ? accountId.slice(colonIdx + 1) : accountId;
	}

	function snoozePresets(): ReadonlyArray<{ label: string; deltaMs: number }> {
		const HOUR = 3600_000;
		const DAY = 24 * HOUR;
		return [
			{ label: t('inbox.snooze_1h'), deltaMs: HOUR },
			{ label: t('inbox.snooze_today'), deltaMs: 6 * HOUR },
			{ label: t('inbox.snooze_tomorrow'), deltaMs: DAY },
			{ label: t('inbox.snooze_week'), deltaMs: 7 * DAY },
		];
	}

	async function onArchive(item: InboxItem): Promise<void> {
		await setItemAction(item.id, 'archived');
	}

	async function onSnoozePreset(item: InboxItem, deltaMs: number): Promise<void> {
		const until = new Date(Date.now() + deltaMs);
		await setItemSnooze(item.id, until);
		openSnoozeFor = null;
	}
</script>

<div class="p-6 max-w-3xl mx-auto" role="region" aria-label={t('inbox.title')} aria-live="polite">
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('inbox.title')}</h1>
	</div>

	{#if !isInboxAvailable()}
		<div class="rounded-[var(--radius-md)] bg-bg-subtle border border-border px-4 py-6 text-sm text-text-muted">
			{t('inbox.unavailable')}
		</div>
	{:else}
		{@const counts = getInboxCounts()}
		<ColdStartBanner />
		<div class="flex gap-1 mb-4" role="tablist" aria-label={t('inbox.title')}>
			<button
				role="tab"
				aria-selected={zone === 'requires_user'}
				onclick={() => (zone = 'requires_user')}
				class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'requires_user' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
			>
				<span>{t('inbox.zone_needs_you')}</span>
				{#if counts.requires_user > 0}
					<span class="rounded-full bg-accent/15 text-accent-text px-1.5 text-[10px] font-mono">{counts.requires_user}</span>
				{/if}
			</button>
			<button
				role="tab"
				aria-selected={zone === 'draft_ready'}
				onclick={() => (zone = 'draft_ready')}
				class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'draft_ready' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
			>
				<span>{t('inbox.zone_drafted')}</span>
				{#if counts.draft_ready > 0}
					<span class="rounded-full bg-bg-muted text-text-muted px-1.5 text-[10px] font-mono">{counts.draft_ready}</span>
				{/if}
			</button>
			<button
				role="tab"
				aria-selected={zone === 'auto_handled'}
				onclick={() => (zone = 'auto_handled')}
				class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'auto_handled' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
			>
				<span>{t('inbox.zone_handled')}</span>
				{#if counts.auto_handled > 0}
					<span class="rounded-full bg-bg-muted text-text-muted px-1.5 text-[10px] font-mono">{counts.auto_handled}</span>
				{/if}
			</button>
		</div>

		{#if isLoading(zone)}
			<p class="text-text-subtle text-sm">{t('inbox.loading')}</p>
		{:else}
			{@const items = getInboxItems(zone)}
			{#if items.length === 0}
				<p class="text-text-subtle text-sm">
					{#if zone === 'requires_user'}{t('inbox.empty_needs_you')}
					{:else if zone === 'draft_ready'}{t('inbox.empty_drafted')}
					{:else}{t('inbox.empty_handled')}
					{/if}
				</p>
			{:else}
				<ul class="space-y-2" role="list">
					{#each items as item (item.id)}
						<li
							role="listitem"
							aria-label={`${zone === 'requires_user' ? t('inbox.zone_needs_you') : ''}: ${item.reasonDe}`}
							class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3 transition-colors"
						>
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2 text-[11px] text-text-subtle mb-1">
										<span title={item.accountId}>📬 {accountShortLabel(item.accountId)}</span>
										<span aria-hidden="true">·</span>
										<span>{channelLabel(item.channel)}</span>
										<span aria-hidden="true">·</span>
										<span>{dateFormat(item.classifiedAt)}</span>
									</div>
									<p class="text-sm text-text leading-relaxed">{item.reasonDe}</p>
									{#if item.classifierVersion === 'sensitive-prefilter'}
										<p class="text-[11px] text-warning mt-1" aria-label="sensitive content">
											⚠ {t('inbox.action_reply')}
										</p>
									{/if}
								</div>
								{#if zone === 'requires_user' && !item.userAction}
									<div class="flex items-center gap-1 shrink-0">
										<button
											onclick={() => void onArchive(item)}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-text hover:border-border-hover"
											aria-label={t('inbox.action_archive')}
										>{t('inbox.action_archive')}</button>
										<button
											onclick={() => (openSnoozeFor = openSnoozeFor === item.id ? null : item.id)}
											aria-expanded={openSnoozeFor === item.id}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-text hover:border-border-hover"
										>{t('inbox.action_snooze')}</button>
									</div>
								{/if}
							</div>
							{#if openSnoozeFor === item.id}
								<div class="mt-2 flex flex-wrap gap-1 pl-1">
									{#each snoozePresets() as preset}
										<button
											onclick={() => void onSnoozePreset(item, preset.deltaMs)}
											class="rounded-[var(--radius-sm)] bg-bg-muted text-text-muted hover:text-text px-2 py-1 text-[11px]"
										>{preset.label}</button>
									{/each}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</div>
