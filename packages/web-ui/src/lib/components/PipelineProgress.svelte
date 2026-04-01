<script lang="ts">
	import type { PipelineInfo, PipelineStepInfo } from '../stores/chat.svelte.js';

	interface Props {
		pipeline: PipelineInfo;
	}

	let { pipeline }: Props = $props();

	// Compute phases from dependency graph (same Kahn's logic as the engine)
	function computePhases(steps: PipelineStepInfo[]): PipelineStepInfo[][] {
		const ids = new Set(steps.map(s => s.id));
		const inDegree = new Map<string, number>();
		for (const step of steps) {
			let deg = 0;
			for (const dep of step.inputFrom ?? []) {
				if (ids.has(dep)) deg++;
			}
			inDegree.set(step.id, deg);
		}

		const phases: PipelineStepInfo[][] = [];
		const remaining = new Set(ids);
		const stepMap = new Map(steps.map(s => [s.id, s]));

		while (remaining.size > 0) {
			const ready: PipelineStepInfo[] = [];
			for (const id of remaining) {
				if ((inDegree.get(id) ?? 0) === 0) {
					ready.push(stepMap.get(id)!);
				}
			}
			if (ready.length === 0) break; // cycle guard
			phases.push(ready);
			for (const s of ready) remaining.delete(s.id);
			for (const id of remaining) {
				const step = stepMap.get(id)!;
				for (const dep of step.inputFrom ?? []) {
					if (ready.some(r => r.id === dep)) {
						inDegree.set(id, (inDegree.get(id) ?? 1) - 1);
					}
				}
			}
		}
		return phases;
	}

	function formatElapsed(step: PipelineStepInfo): string {
		if (step.durationMs != null) return `${(step.durationMs / 1000).toFixed(1)}s`;
		if (step.elapsed != null) return `${step.elapsed}s`;
		return '';
	}

	function statusIcon(status: string): string {
		switch (status) {
			case 'completed': return '\u2713';
			case 'failed': return '\u2717';
			case 'skipped': return '\u2014';
			case 'running': return '';
			default: return '';
		}
	}

	const phases = $derived(computePhases(pipeline.steps));
	const allDone = $derived(pipeline.steps.every(s => s.status === 'completed' || s.status === 'skipped'));
	const hasFailed = $derived(pipeline.steps.some(s => s.status === 'failed'));
</script>

<div class="pipeline-progress rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden">
	<!-- Header -->
	<div class="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-subtle/50">
		<span class="text-xs md:text-[10px] font-mono uppercase tracking-widest text-text-subtle">Pipeline</span>
		{#if allDone}
			<span class="h-1.5 w-1.5 rounded-full bg-success"></span>
		{:else if hasFailed}
			<span class="h-1.5 w-1.5 rounded-full bg-danger"></span>
		{:else}
			<span class="h-1.5 w-1.5 rounded-full bg-warning animate-pulse"></span>
		{/if}
	</div>

	<!-- Phases -->
	<div class="px-3 py-1.5 space-y-1">
		{#each phases as phase, phaseIdx (phaseIdx)}
			<!-- Phase connector -->
			{#if phaseIdx > 0}
				<div class="flex justify-center">
					<div class="w-px h-2 bg-border"></div>
				</div>
			{/if}

			<!-- Phase steps (parallel = side by side) -->
			<div class="flex gap-1.5 {phase.length === 1 ? 'justify-center' : ''}">
				{#each phase as step (step.id)}
					<div
						class="flex-1 min-w-0 rounded-[var(--radius-sm)] border px-2.5 md:px-2 py-1.5 md:py-1 text-sm md:text-xs transition-colors
							{step.status === 'completed' ? 'border-success/30 bg-success/5' :
							 step.status === 'failed' ? 'border-danger/30 bg-danger/5' :
							 step.status === 'running' ? 'border-warning/30 bg-warning/5' :
							 step.status === 'skipped' ? 'border-border bg-bg-muted' :
							 'border-border bg-bg'}"
					>
						<div class="flex items-center gap-1.5">
							<!-- Status indicator -->
							{#if step.status === 'running'}
								<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning animate-pulse flex-shrink-0"></span>
							{:else if step.status === 'completed'}
								<span class="text-success flex-shrink-0 text-xs md:text-[10px] font-bold">{statusIcon('completed')}</span>
							{:else if step.status === 'failed'}
								<span class="text-danger flex-shrink-0 text-xs md:text-[10px] font-bold">{statusIcon('failed')}</span>
							{:else if step.status === 'skipped'}
								<span class="text-text-subtle flex-shrink-0 text-xs md:text-[10px]">{statusIcon('skipped')}</span>
							{:else}
								<span class="inline-block h-1.5 w-1.5 rounded-full bg-text-subtle/30 flex-shrink-0"></span>
							{/if}

							<!-- Step name -->
							<span class="truncate text-text-muted">{step.id.replace(/-/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase())}</span>

							<!-- Time -->
							{#if formatElapsed(step)}
								<span class="ml-auto text-xs md:text-[10px] text-text-subtle tabular-nums flex-shrink-0">{formatElapsed(step)}</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/each}
	</div>
</div>
