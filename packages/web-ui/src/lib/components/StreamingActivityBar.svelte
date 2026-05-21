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
	class="streaming-activity-bar border-t border-accent/30 bg-accent/5 px-2 py-2 md:px-4 md:py-2"
	role="status"
	aria-live="polite"
	aria-label={t('chat.activity.bar_aria_label')}
>
	<!-- Width + padding mirror the composer below exactly, so the icon
	     lines up with the composer's attach (paperclip) button. -->
	<div class="max-w-3xl lg:max-w-4xl xl:max-w-5xl mx-auto flex items-center gap-2 min-w-0">
		<img src="/icon.svg" alt="" class="activity-indicator {activity}" aria-hidden="true" />
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
	/* State-coupled motion on the lynox icon — the agent's "presence" in
	   the status bar. Each state gets a distinct, characterful motion so
	   the user reads "what is it doing" at a glance. Motion-led per the
	   product call; the glow is a faint, static brand aura. */
	.activity-indicator {
		display: inline-block;
		height: 1.125rem;
		width: 1.125rem;
		flex-shrink: 0;
		/* Faint brand-purple aura so the icon reads as an active presence. */
		filter: drop-shadow(0 0 2.5px color-mix(in srgb, var(--color-accent) 40%, transparent));
		/* Pivot the scan-tilt around the base, like a head turning. */
		transform-origin: 50% 85%;
	}
	/* thinking — a calm but pronounced vertical bob. */
	.activity-indicator.thinking {
		animation: lynox-bob 1.7s ease-in-out infinite;
	}
	/* tool — a wide side-to-side "scanning" tilt, the agent looking around. */
	.activity-indicator.tool {
		animation: lynox-scan 1.3s ease-in-out infinite;
	}
	/* writing — a quick, gentle nod. */
	.activity-indicator.writing {
		animation: lynox-nod 0.55s ease-in-out infinite;
	}
	@keyframes lynox-bob {
		0%, 100% { transform: translateY(2px); }
		50% { transform: translateY(-4px); }
	}
	@keyframes lynox-scan {
		0%, 100% { transform: rotate(-12deg); }
		50% { transform: rotate(12deg); }
	}
	@keyframes lynox-nod {
		0%, 100% { transform: translateY(-1px); }
		45% { transform: translateY(2px); }
	}
	/* Accessibility: no motion when the user asked the OS to reduce it. */
	@media (prefers-reduced-motion: reduce) {
		.activity-indicator.thinking,
		.activity-indicator.tool,
		.activity-indicator.writing { animation: none; }
	}
</style>
