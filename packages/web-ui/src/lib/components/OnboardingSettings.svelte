<script lang="ts">
	// === Onboarding reactivation (Onboarding Wave 1, AC-1.5) ===
	//
	// Per-layer reactivation from Settings — NOT all-or-nothing (AC-1.5). Wave 1
	// ships exactly one layer (Knowledge / §6.1 basics + website analysis); the
	// component is deliberately layer-structured so Wave 2 ("What's connected"
	// panel) and Wave 3 (literacy off-switch) slot in as sibling rows without a
	// rewrite (PRD impact table, §ships-across-waves).
	//
	// Reset path: the flag endpoint is owner-authenticated and SET-ONLY for the
	// model (S6) — clearing a completion flag happens EXCLUSIVELY here. Deleting
	// `knowledge_done` + `skipped` makes ChatView.loadOnboardingState() re-trigger
	// the flow on the next chat visit (it dismisses on `knowledgeDone || skipped`,
	// so BOTH must clear). The localStorage 'done' write-back (AC-1.11) is
	// write-only and never read by the new flow, so it does not block re-trigger.

	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface OnboardingStatus {
		knowledgeDone: boolean;
		knowledgeThreadId: string | null;
		skipped: boolean;
		pushNudge: string | null;
		firstSessionAt: string | null;
		degraded: boolean;
	}

	let status = $state<OnboardingStatus | null>(null);
	let restarting = $state(false);
	let restarted = $state(false);

	$effect(() => { void load(); });

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/onboarding/status`);
			if (!res.ok) return;
			status = (await res.json()) as OnboardingStatus;
		} catch { /* leave null → the row shows a neutral loading state */ }
	}

	async function restartKnowledge(): Promise<void> {
		if (restarting) return;
		restarting = true;
		try {
			// Two idempotent DELETEs. `knowledge_done` first, then `skipped`; the
			// second response carries the fresh status we render from.
			await fetch(`${getApiBase()}/onboarding/flags/knowledge_done`, { method: 'DELETE' });
			const res = await fetch(`${getApiBase()}/onboarding/flags/skipped`, { method: 'DELETE' });
			if (!res.ok) throw new Error('reset failed');
			status = (await res.json()) as OnboardingStatus;
			restarted = true;
			addToast(t('onboard.relayer_restarted'), 'success', 5000);
		} catch {
			addToast(t('onboard.relayer_error'), 'error');
		} finally {
			restarting = false;
		}
	}

	// null → still loading; degraded → engine.db down (reset would 503, so we
	// disable it and say so). Otherwise the real completion state.
	const knowledgeState = $derived(
		status === null ? 'loading'
			: status.degraded ? 'degraded'
				: status.knowledgeDone ? 'done'
					: status.skipped ? 'skipped'
						: 'pending'
	);
	const canRestart = $derived(status !== null && !status.degraded);
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-1 mt-2">{t('onboard.relayer_title')}</h1>
	<p class="text-sm text-text-muted mb-4">{t('onboard.relayer_desc')}</p>

	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<h2 class="font-medium">{t('onboard.relayer_knowledge')}</h2>
				<p class="text-sm text-text-muted mt-1">{t('onboard.relayer_knowledge_desc')}</p>
			</div>
			{#if knowledgeState === 'done'}
				<span class="shrink-0 text-xs font-mono uppercase tracking-widest text-text-subtle mt-1">{t('onboard.relayer_status_done')}</span>
			{:else if knowledgeState === 'skipped'}
				<span class="shrink-0 text-xs font-mono uppercase tracking-widest text-text-subtle mt-1">{t('onboard.relayer_status_skipped')}</span>
			{:else if knowledgeState === 'pending'}
				<span class="shrink-0 text-xs font-mono uppercase tracking-widest text-text-subtle mt-1">{t('onboard.relayer_status_pending')}</span>
			{/if}
		</div>

		{#if knowledgeState === 'degraded'}
			<p class="text-sm text-text-subtle mt-4">{t('onboard.relayer_degraded')}</p>
		{:else if restarted}
			<div class="mt-4 flex flex-wrap items-center gap-3">
				<p class="text-sm text-text-muted">{t('onboard.relayer_restarted')}</p>
				<a
					href="/app"
					class="shrink-0 rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90 transition-opacity"
				>{t('onboard.relayer_open_chat')}</a>
			</div>
		{:else}
			<button
				type="button"
				onclick={restartKnowledge}
				disabled={!canRestart || restarting}
				class="mt-4 rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-sm font-medium hover:border-border-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>{t('onboard.relayer_restart')}</button>
		{/if}
	</div>
</div>
