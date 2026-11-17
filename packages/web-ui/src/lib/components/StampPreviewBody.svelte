<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import { stepHeading, templateText, timeoutText, visible, type StampPreview } from '../utils/workflow-stamp.js';

	// What a workflow's stamp binds, as the owner is shown it before confirming: its mode, failure
	// strategy, limits, parameters with their defaults and contract, and every step as it runs. The
	// stamp and the takeover show the same part, so what one shows the other shows too.
	// `stepNote`: a line at a step, by its position (the takeover marks a step on someone's connection).
	let { preview: p, stepNote }: { preview: StampPreview; stepNote?: ((index: number) => string | null) | undefined } = $props();
</script>

<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs mb-3">
	{#if p.mode}<dt class="text-text-subtle">{t('workflow_library.stamp.mode')}</dt><dd class="font-mono break-all">{visible(p.mode)}</dd>{/if}
	{#if p.onFailure}<dt class="text-text-subtle">{t('workflow_library.stamp.on_failure')}</dt><dd class="font-mono break-all">{visible(p.onFailure)}</dd>{/if}
	{#if p.limits !== null}<dt class="text-text-subtle">{t('workflow_library.stamp.limits')}</dt><dd class="font-mono whitespace-pre-wrap break-all">{templateText(p.limits)}</dd>{/if}
</dl>

{#if p.parameters.length > 0}
	<p class="text-[10px] uppercase tracking-widest text-text-subtle mb-1">{t('workflow_library.params_title')}</p>
	<ul class="mb-3 space-y-0.5 text-xs font-mono">
		{#each p.parameters as param, i (i)}
			<li class="break-all"><bdi>{visible(param.name)}</bdi>{param.required ? ' *' : ''}{param.default !== null ? ` = ${templateText(param.default)}` : ''}</li>
		{/each}
	</ul>
{/if}

{#if p.contract !== null && p.contract.length > 0}
	<div class="rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 p-3 mb-3 text-xs">
		<p class="font-medium mb-1 flex items-center gap-1"><Icon name="warning" size="xs" />{t('workflow_library.schedule_contract_title')}</p>
		<ul class="space-y-0.5 text-text-subtle font-mono">
			<!-- Keyed by position: a cross product can list the same tuple twice. -->
			{#each p.contract as line, i (i)}
				<li class="break-all">{visible(line)}</li>
			{/each}
		</ul>
	</div>
{/if}

<div class="space-y-2">
	{#if p.steps.length === 0}
		<p data-testid="stamp-no-steps" class="text-xs text-text-subtle">{t('workflow_library.stamp.no_steps')}</p>
	{/if}
	{#each p.steps as step, i (i)}
		{@const h = stepHeading(step)}
		<div data-testid="stamp-step" class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-3 py-2 text-xs">
			<p class="font-mono text-text-subtle break-all">{h.id}</p>
			<p class="font-medium mt-0.5 break-words">{h.head}</p>
			{#if stepNote}
				{@const note = stepNote(i)}
				{#if note !== null}
					<p data-testid="stamp-step-note" class="mt-1 inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 px-1.5 text-warning break-words"><Icon name="warning" size="xs" />{note}</p>
				{/if}
			{/if}
			<!-- Everything that decides what the step does is printed, never folded away: a
			     harmless task text can sit beside a recorded call to another host. -->
			{#if step.tool}
				<p class="text-[10px] uppercase tracking-widest text-text-subtle mt-2 mb-0.5">{t('workflow_library.stamp.call')}</p>
				<p class="font-mono break-all">{visible(step.tool)}</p>
				{#if templateText(step.inputTemplate) !== ''}
					<pre class="mt-1 overflow-hidden whitespace-pre-wrap break-all rounded border border-border bg-bg px-2 py-1 font-mono">{templateText(step.inputTemplate)}</pre>
				{/if}
			{/if}
			<p class="text-[10px] uppercase tracking-widest text-text-subtle mt-2 mb-0.5">{t('workflow.task')}</p>
			<p class="whitespace-pre-wrap break-words">{visible(step.task)}</p>
			{#if step.role}
				<!-- First: a role can change the tools and the model below at run time. -->
				{#if step.roleGrant}
					{@const g = step.roleGrant}
					<!-- What the role sets, under one heading: no line claims to be what the run takes. -->
					<p class="mt-2" data-testid="stamp-role"><span class="text-text-subtle">{t('workflow_library.stamp.role_heading')}</span> <span class="font-mono break-all">{visible(step.role)}</span>{#if g.readOnly} <span class="ml-1 rounded-[var(--radius-sm)] border border-border px-1 text-text-subtle">{t('workflow_library.stamp.role_read_only')}</span>{/if}</p>
					<div data-testid="stamp-role-grant" class="ml-3">
						<!-- The step's own value wins at run time; the role's applies only where the step sets none. -->
						{#if g.model && !step.model}<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.model')}:</span> <span class="font-mono break-all">{visible(g.model)}</span></p>{/if}
						{#if g.effort && !step.effort}<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.effort')}:</span> <span class="font-mono">{g.effort}</span></p>{/if}
						{#if g.allowTools !== null}<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.role_allows')}:</span> {#if g.allowTools.length === 0}<span>{t('workflow_library.stamp.no_tools')}</span>{:else}<span class="font-mono break-all">{visible(g.allowTools.join(', '))}</span>{/if}</p>{/if}
						{#if g.denyTools !== null}<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.role_blocks')}:</span> {#if g.denyTools.length === 0}<span>{t('workflow_library.stamp.no_tools')}</span>{:else}<span class="font-mono break-all">{visible(g.denyTools.join(', '))}</span>{/if}</p>{/if}
						{#if g.readOnly && g.allowTools !== null && g.allowTools.length > 0}<p class="mt-1 text-text-subtle" data-testid="stamp-role-read-only-allows">{t('workflow_library.stamp.role_read_only_allows')}</p>{/if}
					</div>
					<p class="mt-1 text-text-subtle" data-testid="stamp-role-hint">{t('workflow_library.stamp.role_hint')}</p>
				{:else}
					<p class="mt-2" data-testid="stamp-role"><span class="text-text-subtle">{t('workflow_library.stamp.role')}:</span> <span class="font-mono break-all">{visible(step.role)}</span></p>
					<!-- A role the engine does not know: the step stops at run time, so no hint on how its tools are worked out. -->
					<p class="mt-1 text-warning" data-testid="stamp-role-unknown">{t('workflow_library.stamp.role_unknown')}</p>
				{/if}
			{/if}
			{#if step.tools.length > 0}
				<p class="mt-2"><span class="text-text-subtle">{t('workflow_library.stamp.tools')}:</span> <span class="font-mono break-all">{visible(step.tools.join(', '))}</span></p>
			{/if}
			{#if step.model}
				<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.model')}:</span> <span class="font-mono break-all">{visible(step.model)}</span></p>
			{:else if !step.roleGrant?.model && !(step.role && !step.roleGrant)}
				<!-- Neither the step nor its role names a model: the engine runs it on fast. An unknown role stops the step, so no model is claimed. -->
				<p class="mt-1" data-testid="stamp-model-default"><span class="text-text-subtle">{t('workflow_library.stamp.model')}:</span> <span class="font-mono">{t('workflow_library.stamp.model_default')}</span></p>
			{/if}
			{#if step.effort}
				<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.effort')}:</span> <span class="font-mono">{step.effort}</span></p>
			{/if}
			{#if step.thinking}
				<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.thinking')}:</span> <span class="font-mono">{step.thinking}</span></p>
			{/if}
			<!-- No limit set means the engine's default, which is a limit all the same. -->
			<p class="mt-1"><span class="text-text-subtle">{t('workflow_library.stamp.timeout')}:</span> <span class="font-mono">{step.timeoutMs === null ? t('workflow_library.stamp.timeout_default') : step.timeoutMs === 0 ? t('workflow_library.stamp.timeout_zero') : timeoutText(step.timeoutMs)}</span></p>
			{#if step.inputFrom.length > 0}
				<p class="mt-1"><span class="text-text-subtle">{t('workflow.depends_on')}:</span> <span class="font-mono break-all">{visible(step.inputFrom.join(', '))}</span></p>
			{/if}
		</div>
	{/each}
</div>
