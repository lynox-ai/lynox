<script lang="ts">
	// "Confirm recipients" for a trigger from before its creator was recorded: the engine does not
	// count its instruction as the owner's, so its run sends to none of the recipients it names.
	// Shows the instruction from the preview, as text someone else may have written, and confirms
	// with the preview's `expect`: a trigger changed since answers 409 `changed`, and this shows the
	// new instruction for a second look. The engine records the owner as the creator and nothing else.
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { instructionOf, markHidden } from '../utils/trigger-consent.js';
	import { paramsOf } from '../utils/stamp-confirm.js';

	interface Props {
		id: string;
		onconfirmed: () => void;
		onclose: () => void;
	}
	let { id, onconfirmed, onclose }: Props = $props();

	interface Preview {
		title: string;
		description: string;
		params: string | null;
		expect: string;
	}

	let preview = $state<Preview | null>(null);
	let failed = $state(false);
	let changed = $state(false);
	let busy = $state(false);
	let note = $state<HTMLElement | null>(null);
	let request = 0;

	function readPreview(v: unknown): Preview | null {
		if (typeof v !== 'object' || v === null) return null;
		const o = v as Record<string, unknown>;
		if (typeof o['title'] !== 'string' || typeof o['expect'] !== 'string') return null;
		return {
			title: o['title'],
			description: typeof o['description'] === 'string' ? o['description'] : '',
			params: typeof o['params'] === 'string' ? o['params'] : null,
			expect: o['expect'],
		};
	}

	async function load(): Promise<void> {
		const mine = ++request;
		failed = false;
		try {
			const res = await fetch(`${getApiBase()}/triggers/${encodeURIComponent(id)}/confirm-recipients-preview`);
			if (!res.ok) throw new Error();
			const answer = readPreview(await res.json());
			if (mine !== request) return;
			if (!answer) throw new Error();
			preview = answer;
		} catch {
			if (mine !== request) return;
			preview = null;
			failed = true;
		}
	}

	async function confirm(): Promise<void> {
		const shown = preview;
		if (busy || shown === null) return;
		busy = true;
		try {
			const res = await fetch(`${getApiBase()}/triggers/${encodeURIComponent(id)}/confirm-recipients`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expect: shown.expect }),
			});
			if (res.ok) {
				onconfirmed();
				return;
			}
			const code = res.status === 409 ? ((await res.json().catch(() => ({}))) as { code?: unknown }).code : undefined;
			if (code === 'changed') {
				changed = true;
				await load();
				note?.focus();
				return;
			}
			addToast(t('triggers.confirm_failed'), 'error');
		} catch {
			addToast(t('triggers.confirm_failed'), 'error');
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		void id;
		changed = false;
		preview = null;
		void load();
	});
</script>

<div class="mt-2 space-y-1.5 text-xs text-text-muted" data-recipient-confirm>
	<p class="font-medium text-text">{t('recipients.confirm_title')}</p>
	{#if changed}
		<p class="text-warning" role="status" tabindex="-1" bind:this={note} data-recipient-changed>{t('recipients.changed')}</p>
	{/if}
	{#if failed}
		<p class="text-warning">{t('triggers.confirm_failed')}</p>
	{:else if preview}
		<div data-recipient-instruction>
			<span class="font-medium">{t('recipients.instruction')}:</span>
			<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">{markHidden(instructionOf({ title: preview.title, description: preview.description || undefined }))}</p>
			{#if preview.params}
				<p class="mt-0.5"><span class="font-medium">{t('stamp.params')}:</span> <span class="rounded-[var(--radius-sm)] border border-border bg-bg px-1 [box-decoration-break:clone]">{paramsOf(preview.params).join(' · ')}</span></p>
			{/if}
		</div>
		<p class="text-text">{t('recipients.confirm_body')}</p>
		<div class="flex flex-wrap gap-2">
			<button onclick={() => void confirm()} disabled={busy} class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/15 disabled:opacity-40" data-recipient-confirm-button>{t('recipients.confirm')}</button>
			<button onclick={onclose} class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1 text-xs text-text-muted hover:text-text" data-recipient-cancel>{t('recipients.cancel')}</button>
		</div>
	{/if}
</div>
