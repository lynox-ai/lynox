<script lang="ts">
	import { t } from '../i18n.svelte.js';

	interface Props {
		/** Current activity label resolved from streamingActivity + tool map. */
		label: string;
		/** Coarse activity state — drives the state-coupled micro-animation on
		 *  the status indicator (breathe / ripple / blink). */
		activity: 'thinking' | 'tool' | 'writing' | 'idle';
		/** Wall-clock when the currently running tool call began, or null for
		 *  non-tool activity (writing/thinking). Drives the elapsed counter. */
		currentToolStartedAt: number | null;
		/** Wall-clock of the last SSE event from the server. Drives the
		 *  "Verbindung scheint langsam" hint when the gap grows too large. */
		lastEventAt: number | null;
	}

	let { label, activity, currentToolStartedAt, lastEventAt }: Props = $props();

	// 1s tick so the elapsed counter updates visibly during long tool calls
	// (web_crawl, DataForSEO, spawn_agent batch). PromptAnchor's 30s tick is
	// too coarse here — the user needs to see "33s … 34s …" to feel progress.
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => { now = Date.now(); }, 1_000);
		return () => clearInterval(id);
	});

	const elapsedS = $derived(
		currentToolStartedAt === null
			? null
			: Math.max(0, Math.floor((now - currentToolStartedAt) / 1000)),
	);
	const elapsedLabel = $derived(
		elapsedS === null
			? null
			: elapsedS < 60
				? t('chat.activity.elapsed_seconds').replace('{n}', String(elapsedS))
				: t('chat.activity.elapsed_minutes').replace('{n}', String(Math.floor(elapsedS / 60))),
	);

	// Connection-slow hint. Server emits a heartbeat every 10s, so a 25s+ gap
	// is unusual and likely means the iPad tab was throttled or the proxy
	// killed the socket. This is a soft hint — not a hard error — because the
	// agent loop on the engine is unaffected and the run will still complete.
	const heartbeatStale = $derived(
		lastEventAt !== null && (now - lastEventAt) > 25_000,
	);
</script>

<div
	class="streaming-activity-bar border-t border-accent/30 bg-accent/5 px-4 py-2"
	role="status"
	aria-live="polite"
	aria-label={t('chat.activity.bar_aria_label')}
>
	<div class="max-w-3xl mx-auto flex items-center gap-2 min-w-0">
		<span class="activity-indicator {activity}" aria-hidden="true"></span>
		<span class="text-xs md:text-sm text-text font-medium truncate min-w-0">
			{label}
		</span>

		{#if elapsedLabel}
			<span class="text-text-subtle flex-shrink-0" aria-hidden="true">·</span>
			<span class="text-[11px] md:text-xs text-text-subtle font-mono flex-shrink-0 tabular-nums">
				{elapsedLabel}
			</span>
		{/if}

		{#if heartbeatStale}
			<span class="ml-auto flex-shrink-0 text-[11px] md:text-xs text-warning truncate" title={t('chat.activity.heartbeat_stale')}>
				{t('chat.activity.heartbeat_stale')}
			</span>
		{/if}
	</div>
</div>

<style>
	/* State-coupled micro-animation on the status indicator. Each agent
	   state gets a distinct, deliberately subtle motion so the user can
	   read "what is it doing" at a glance without parsing the label. */
	.activity-indicator {
		position: relative;
		display: inline-block;
		height: 0.5rem;
		width: 0.5rem;
		flex-shrink: 0;
		border-radius: 9999px;
		background: var(--color-accent);
		/* The tool ripple intentionally scales past the dot — let it bleed. */
		overflow: visible;
	}
	/* thinking — a slow, calm breathing pulse. */
	.activity-indicator.thinking {
		animation: lynox-breathe 1.8s ease-in-out infinite;
	}
	/* writing — a steady cursor-like blink. */
	.activity-indicator.writing {
		animation: lynox-blink 1s ease-in-out infinite;
	}
	/* tool — an outward ripple, the feeling of active work radiating. */
	.activity-indicator.tool::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 9999px;
		border: 1px solid var(--color-accent);
		animation: lynox-ripple 1.4s ease-out infinite;
	}
	@keyframes lynox-breathe {
		0%, 100% { transform: scale(0.72); opacity: 0.55; }
		50% { transform: scale(1.05); opacity: 1; }
	}
	@keyframes lynox-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.25; }
	}
	@keyframes lynox-ripple {
		0% { transform: scale(1); opacity: 0.7; }
		100% { transform: scale(2.8); opacity: 0; }
	}
	/* Accessibility: no motion when the user asked the OS to reduce it. */
	@media (prefers-reduced-motion: reduce) {
		.activity-indicator.thinking,
		.activity-indicator.writing,
		.activity-indicator.tool::after { animation: none; }
	}
</style>
