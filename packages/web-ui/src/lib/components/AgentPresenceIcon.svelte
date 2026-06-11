<script lang="ts">
	/** Shared animated lynox-icon "agent presence". Used by the streaming
	 *  activity bar and the voice-transcription state so the agent reads as
	 *  one consistent, living presence wherever it is working — never a
	 *  generic spinner. */
	interface Props {
		/** Drives the state-coupled animation. `thinking` and `idle` share
		 *  the base breathing motion; `transcribing` gets a bolder pulse. */
		state: 'thinking' | 'tool' | 'writing' | 'transcribing' | 'idle';
	}

	let { state }: Props = $props();
</script>

<img src="/icon.svg" alt="" class="agent-presence {state}" aria-hidden="true" />

<style>
	/* State-coupled motion on the lynox icon. Squash-and-stretch + a
	   baked-in spring (overshoot, then settle) gives each state weight, so
	   it reads as alive rather than mechanical. transform-origin sits near
	   the base so the icon squashes onto its "feet". The base breathing
	   covers thinking and idle — whenever the icon is shown the agent is
	   working, so it never sits fully still. */
	.agent-presence {
		display: inline-block;
		height: 1.125rem;
		width: 1.125rem;
		flex-shrink: 0;
		/* Faint brand-purple aura so the icon reads as an active presence. */
		filter: drop-shadow(0 0 2.5px color-mix(in srgb, var(--color-accent) 40%, transparent));
		transform-origin: 50% 95%;
		animation: lynox-breathe 2s ease-in-out infinite;
	}
	/* thinking — a fuller, springier, slightly faster breath than the calm
	   idle base + a touch more aura, so an ACTIVELY-reasoning agent reads as
	   clearly more alive than one merely idling (the idle base felt too faint
	   while thinking). */
	.agent-presence.thinking {
		filter: drop-shadow(0 0 3.5px color-mix(in srgb, var(--color-accent) 55%, transparent));
		animation: lynox-think 1.5s ease-in-out infinite;
	}
	/* tool — tilt to a side, overshoot, settle, hold; then the other side. */
	.agent-presence.tool {
		animation: lynox-scan 2.1s ease-in-out infinite;
	}
	/* writing — a quick squash-nod that rebounds and settles. */
	.agent-presence.writing {
		animation: lynox-nod 0.62s ease-in-out infinite;
	}
	/* transcribing — a bold, lively squash-pulse. Voice processing is a
	   brief, active moment, so it gets a deliberately larger + faster
	   motion than the calm thinking breath — it must read as unmistakably
	   animated in the second or two it is on screen. */
	.agent-presence.transcribing {
		animation: lynox-listen 0.9s ease-in-out infinite;
	}
	@keyframes lynox-breathe {
		0%, 100% { transform: scaleX(1.03) scaleY(0.97); }
		50% { transform: scaleX(0.98) scaleY(1.05) translateY(-1.5px); }
	}
	@keyframes lynox-think {
		0%, 100% { transform: scaleX(1.06) scaleY(0.94); }
		50% { transform: scaleX(0.93) scaleY(1.09) translateY(-2.5px); }
	}
	@keyframes lynox-scan {
		0%, 100% { transform: rotate(-10deg); }
		13% { transform: rotate(12deg); }
		23% { transform: rotate(8deg); }
		45% { transform: rotate(8deg); }
		58% { transform: rotate(-12deg); }
		68% { transform: rotate(-10deg); }
	}
	@keyframes lynox-nod {
		0%, 100% { transform: scaleX(1) scaleY(1) translateY(0); }
		35% { transform: scaleX(1.07) scaleY(0.89) translateY(2px); }
		62% { transform: scaleX(0.98) scaleY(1.04) translateY(-1.5px); }
	}
	@keyframes lynox-listen {
		0%, 100% { transform: scaleX(1.1) scaleY(0.9); }
		50% { transform: scaleX(0.9) scaleY(1.12) translateY(-2px); }
	}
	/* Accessibility: no motion when the user asked the OS to reduce it. */
	@media (prefers-reduced-motion: reduce) {
		.agent-presence { animation: none; }
	}
</style>
