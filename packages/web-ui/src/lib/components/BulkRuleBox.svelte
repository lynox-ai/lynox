<script lang="ts">
	// The rule of a judged run, where the owner starts the judging, approves its values, or judges
	// again. The agent writes the rule, up to the engine's length bound and possibly from data it
	// read, so its height is bounded here: a long rule scrolls inside the box and no longer pushes
	// the preview and the sentence under it out of sight. The whole rule stays readable, and a long
	// word breaks inside the box instead of running past its edge.
	import { t } from '../i18n.svelte.js';
	import { bulkVisibleText } from './bulk-runs.js';

	let { rule }: { rule: string } = $props();
</script>

<!-- A scrolling region takes the keyboard focus, so it can be scrolled without a pointer. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="text-sm whitespace-pre-wrap [overflow-wrap:anywhere] max-h-48 overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2"
	role="region"
	aria-label={t('bulk.start.rule')}
	tabindex="0"
	data-testid="bulk-rule-box"
>{bulkVisibleText(rule)}</div>
