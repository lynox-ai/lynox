<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import {
		getInboxCounts,
		getSnoozedCount,
		type InboxZone,
	} from '../stores/inbox.svelte.js';

	interface Props {
		zone: InboxZone;
		onZoneChange: (z: InboxZone) => void;
		onCompose: () => void;
		onTriageToggle: () => void;
		triageActive: boolean;
		onHelp?: () => void;
		showHelp?: boolean;
	}

	const {
		zone,
		onZoneChange,
		onCompose,
		onTriageToggle,
		triageActive,
		onHelp,
		showHelp = false,
	}: Props = $props();

	const counts = $derived(getInboxCounts());
	const snoozedCount = $derived(getSnoozedCount());

	interface ZoneEntry {
		key: InboxZone;
		labelKey: string;
		count: number;
		highlight: boolean;
	}

	const zones = $derived<ReadonlyArray<ZoneEntry>>([
		{ key: 'requires_user', labelKey: 'inbox.zone_needs_you', count: counts.requires_user, highlight: true },
		{ key: 'draft_ready', labelKey: 'inbox.zone_drafted', count: counts.draft_ready, highlight: false },
		{ key: 'auto_handled', labelKey: 'inbox.zone_handled', count: counts.auto_handled, highlight: false },
		{ key: 'snoozed', labelKey: 'inbox.zone_snoozed', count: snoozedCount, highlight: false },
	]);
</script>

<aside
	class="hidden md:flex md:w-44 lg:w-48 shrink-0 flex-col border-r border-border bg-bg-subtle/40"
	aria-label={t('inbox.title')}
>
	<div class="flex flex-col gap-0.5 p-2 pt-3">
		{#each zones as entry (entry.key)}
			{@const active = zone === entry.key}
			<button
				type="button"
				role="tab"
				aria-selected={active}
				onclick={() => onZoneChange(entry.key)}
				class="group relative flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-sm transition-colors {active ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
			>
				<span class="flex items-center gap-2 min-w-0">
					{#if entry.key === 'requires_user'}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
						</svg>
					{:else if entry.key === 'draft_ready'}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
						</svg>
					{:else if entry.key === 'auto_handled'}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
					{:else}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
					{/if}
					<span class="truncate">{t(entry.labelKey)}</span>
				</span>
				{#if entry.count > 0}
					<span class="shrink-0 rounded-full px-1.5 text-[10px] font-mono leading-5 {active && entry.highlight ? 'bg-accent/15 text-accent-text' : 'bg-bg-muted text-text-muted'}">
						{entry.count}
					</span>
				{/if}
			</button>
		{/each}
	</div>

	<div class="flex flex-col gap-0.5 mt-auto border-t border-border p-2">
		<button
			type="button"
			onclick={() => onCompose()}
			class="rounded-[var(--radius-sm)] border border-accent bg-accent text-accent-text px-2.5 py-2 text-[12px] hover:opacity-90 mb-1.5"
		>
			+ {t('inbox.compose_new')}
		</button>
		<button
			type="button"
			onclick={() => onTriageToggle()}
			aria-pressed={triageActive}
			class="rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[11px] transition-colors {triageActive ? 'border-accent bg-accent/10 text-accent-text' : 'border-border bg-bg text-text-muted hover:text-text'}"
		>
			{triageActive ? t('inbox.triage_exit') : t('inbox.kopilot_start_triage')}
		</button>
		<a
			href="/app/inbox/rules"
			class="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[11px] text-text-subtle hover:text-text-muted hover:bg-bg-muted text-center"
		>
			{t('inbox.rules_link')}
		</a>
		{#if showHelp && onHelp}
			<button
				type="button"
				onclick={() => onHelp()}
				class="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[11px] text-text-subtle hover:text-text-muted hover:bg-bg-muted text-left font-mono"
				aria-label={t('inbox.shortcuts_title')}
			>
				{t('inbox.shortcuts_hint')}
			</button>
		{/if}
	</div>
</aside>
