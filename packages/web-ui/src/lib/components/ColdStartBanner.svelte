<script lang="ts">
	// === Inbox cold-start banner ===
	//
	// Surfaces the per-account backfill progress that lands the first time
	// a mail account is connected. Three states: running (progress bar +
	// X/Y count), completed (collapses to a one-line confirmation), failed
	// (red one-liner with retry hint). User can dismiss either state — the
	// store remembers the dismissal per account for the session.

	import { getLocale, t } from '../i18n.svelte.js';
	import {
		dismissColdStartForAccount,
		getVisibleColdStartActive,
		getVisibleColdStartRecent,
		type ColdStartActiveEntry,
		type ColdStartRecentEntry,
	} from '../stores/inbox.svelte.js';
	import { accountShortLabel } from '../utils/account-label.js';

	// String.prototype.replace interprets $&/$'/$`/$n in its second arg when it
	// is a string. Wrapping the substitution in a function avoids that — error
	// payloads from the classifier can contain arbitrary content.
	function fillPlaceholder(template: string, token: string, value: string): string {
		return template.replace(token, () => value);
	}

	function progressPercent(entry: ColdStartActiveEntry): number {
		const progress = entry.progress;
		if (progress === null || progress.capValue <= 0) return 0;
		// uniqueThreads can exceed capValue by one in the cap-hit snapshot, so
		// clamp so the bar visually settles at 100%, not 101%.
		const ratio = Math.min(progress.uniqueThreads / progress.capValue, 1);
		return Math.round(ratio * 100);
	}

	function formatCost(usd: number): string {
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 4,
		}).format(usd);
	}

	function progressText(entry: ColdStartActiveEntry): string {
		const progress = entry.progress;
		if (progress === null) return t('inbox.cold_start_starting');
		const withEnqueued = fillPlaceholder(
			t('inbox.cold_start_progress'),
			'{enqueued}',
			String(progress.enqueued),
		);
		return fillPlaceholder(withEnqueued, '{total}', String(progress.uniqueThreads));
	}

	function recentText(entry: ColdStartRecentEntry): string {
		if (entry.status === 'failed') {
			return entry.error
				? fillPlaceholder(t('inbox.cold_start_failed_reason'), '{error}', entry.error)
				: t('inbox.cold_start_failed');
		}
		const report = entry.report;
		if (!report) return t('inbox.cold_start_complete_simple');
		const withThreads = fillPlaceholder(
			t('inbox.cold_start_complete'),
			'{threads}',
			String(report.uniqueThreads),
		);
		return fillPlaceholder(withThreads, '{cost}', formatCost(report.estimatedCostUSD));
	}

	const active = $derived(getVisibleColdStartActive());
	const recent = $derived(getVisibleColdStartRecent());
</script>

{#if active.length > 0 || recent.length > 0}
	<div class="space-y-2 mb-4" role="status" aria-live="polite">
		{#each active as entry (entry.accountId)}
			<div
				class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 px-4 py-3"
				aria-label={t('inbox.cold_start_aria_running')}
			>
				<div class="flex items-start justify-between gap-3 mb-2">
					<div class="min-w-0 flex-1">
						<p class="text-sm text-text">
							<span class="font-medium">{t('inbox.cold_start_title')}</span>
							<span class="text-text-muted"> · {accountShortLabel(entry.accountId)}</span>
						</p>
						<p class="text-[12px] text-text-muted mt-0.5">{progressText(entry)}</p>
					</div>
					<button
						type="button"
						onclick={() => dismissColdStartForAccount(entry.accountId)}
						aria-label={t('inbox.cold_start_dismiss')}
						class="text-text-subtle hover:text-text text-sm leading-none p-2 -mr-1 -mt-1 min-h-[32px] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
					>×</button>
				</div>
				<div
					class="h-1 w-full bg-bg-muted rounded-full overflow-hidden"
					role="progressbar"
					aria-valuenow={progressPercent(entry)}
					aria-valuemin="0"
					aria-valuemax="100"
				>
					<div
						class="h-full bg-accent transition-all duration-300 ease-out"
						style="width: {progressPercent(entry)}%"
					></div>
				</div>
			</div>
		{/each}

		{#each recent as entry (entry.accountId)}
			<div
				class="rounded-[var(--radius-md)] border px-4 py-2 flex items-start justify-between gap-3
					{entry.status === 'failed'
						? 'border-danger/30 bg-danger/5'
						: 'border-success/30 bg-success/5'}"
			>
				<p class="text-[13px] text-text">
					<span class="font-medium">
						{entry.status === 'failed' ? '✕' : '✓'}
						{accountShortLabel(entry.accountId)}
					</span>
					<span class="text-text-muted"> · {recentText(entry)}</span>
				</p>
				<button
					type="button"
					onclick={() => dismissColdStartForAccount(entry.accountId)}
					aria-label={t('inbox.cold_start_dismiss')}
					class="text-text-subtle hover:text-text text-sm leading-none p-2 -mr-1 min-h-[32px] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] shrink-0"
				>×</button>
			</div>
		{/each}
	</div>
{/if}
