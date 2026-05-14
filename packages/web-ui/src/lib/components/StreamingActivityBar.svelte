<script lang="ts">
	import { t } from '../i18n.svelte.js';

	interface Props {
		/** Current activity label resolved from streamingActivity + tool map. */
		label: string;
		/** Wall-clock when the currently running tool call began, or null for
		 *  non-tool activity (writing/thinking). Drives the elapsed counter. */
		currentToolStartedAt: number | null;
		/** Wall-clock of the last SSE event from the server. Drives the
		 *  "Verbindung scheint langsam" hint when the gap grows too large. */
		lastEventAt: number | null;
	}

	let { label, currentToolStartedAt, lastEventAt }: Props = $props();

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
		<span
			class="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent"
			aria-hidden="true"
		></span>
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
