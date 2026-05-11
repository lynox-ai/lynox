<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import {
		closeDraftPane,
		createDraftForOpenPane,
		getDraftPane,
		saveDraftBody,
		type InboxItem,
	} from '../stores/inbox.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { accountShortLabel } from '../utils/account-label.js';

	interface Props {
		item: InboxItem | null;
	}
	const { item }: Props = $props();

	let buffer = $state('');
	let textareaRef = $state<HTMLTextAreaElement | null>(null);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Mirror the persisted body into the local buffer whenever the store
	// commits a new draft (open / create / load completed). Keystrokes
	// then mutate the buffer freely and a debounced PATCH catches up.
	$effect(() => {
		const pane = getDraftPane();
		if (!pane) return;
		// Reading reactively — when the persistedBody snapshot changes
		// (load completes or PATCH echoes back), realign the buffer.
		buffer = pane.persistedBody;
	});

	$effect(() => {
		if (getDraftPane()?.draft && textareaRef) textareaRef.focus();
	});

	function isDirty(): boolean {
		return buffer !== (getDraftPane()?.persistedBody ?? '');
	}

	function scheduleSave(): void {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void saveDraftBody(buffer);
		}, 600);
	}

	function flushNow(): void {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (isDirty()) void saveDraftBody(buffer);
	}

	function onBufferInput(event: Event): void {
		const target = event.target as HTMLTextAreaElement;
		buffer = target.value;
		scheduleSave();
	}

	function onTextareaKeyDown(event: KeyboardEvent): void {
		// ⌘/Ctrl+Enter: flush the latest buffer, then notify that send
		// wiring is the next slice's job. Without flushing first the user
		// would think their last keystroke "vanished" when the next slice
		// reads the persisted body.
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			flushNow();
			addToast(t('inbox.draft_send_pending'), 'info');
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			flushNow();
			closeDraftPane();
		}
	}

	function onCreateClick(): void {
		void createDraftForOpenPane();
	}

	onDestroy(() => {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		flushNow();
	});

	// Derive UI labels once per locale change instead of per keystroke.
	const sendPendingLabel = $derived(t('inbox.draft_send_pending'));
	const regenPendingLabel = $derived(t('inbox.draft_regenerate_pending'));
</script>

{#if getDraftPane() !== null}
	{@const pane = getDraftPane()!}
	<div
		class="fixed inset-0 z-40 flex sm:items-stretch sm:justify-end bg-black/40 backdrop-blur-sm"
		role="presentation"
		onclick={() => { flushNow(); closeDraftPane(); }}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="draft-pane-title"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			class="bg-bg-subtle border-l border-border shadow-xl w-full sm:max-w-[520px] flex flex-col h-full overflow-hidden pb-[max(1rem,env(safe-area-inset-bottom))]"
		>
			<header class="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-border">
				<div class="min-w-0 flex-1">
					<h2 id="draft-pane-title" class="text-base font-medium tracking-tight">
						{t('inbox.draft_title')}
					</h2>
					{#if item}
						<p class="text-[11px] text-text-subtle mt-0.5 truncate">
							📬 {accountShortLabel(item.accountId)} · {item.reasonDe}
						</p>
					{/if}
				</div>
				<button
					type="button"
					onclick={() => { flushNow(); closeDraftPane(); }}
					aria-label={t('inbox.draft_close')}
					class="text-text-subtle hover:text-text text-sm leading-none p-2 -mr-1 -mt-1 min-h-[32px] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
				>×</button>
			</header>

			<div class="flex-1 overflow-y-auto px-5 py-4">
				{#if pane.loading}
					<p class="text-text-subtle text-sm">{t('inbox.draft_loading')}</p>
				{:else if pane.draft === null}
					<div class="rounded-[var(--radius-md)] bg-bg border border-dashed border-border px-4 py-6 text-sm text-text-muted flex flex-col gap-3 items-start">
						<p>{t('inbox.draft_none_yet')}</p>
						<button
							type="button"
							onclick={onCreateClick}
							class="rounded-[var(--radius-sm)] bg-accent/15 hover:bg-accent/25 text-accent-text px-3 py-1.5 text-sm min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
						>{t('inbox.draft_create')}</button>
					</div>
				{:else}
					<label class="sr-only" for="draft-body">{t('inbox.draft_body_label')}</label>
					<textarea
						bind:this={textareaRef}
						id="draft-body"
						value={buffer}
						oninput={onBufferInput}
						onkeydown={onTextareaKeyDown}
						placeholder={t('inbox.draft_body_placeholder')}
						class="w-full h-full min-h-[280px] resize-none bg-bg border border-border rounded-[var(--radius-md)] p-3 text-sm leading-relaxed text-text font-sans focus:border-accent focus:outline-none"
					></textarea>
					<div class="flex items-center justify-between text-[11px] text-text-subtle mt-2 gap-3 flex-wrap">
						<span>{t('inbox.draft_edits_count').replace('{count}', String(pane.draft.userEditsCount))}</span>
						<span aria-live="polite">
							{#if pane.saving}{t('inbox.draft_saving')}
							{:else if isDirty()}{t('inbox.draft_unsaved')}
							{:else}{t('inbox.draft_saved')}
							{/if}
						</span>
					</div>
				{/if}
			</div>

			<footer class="px-5 pt-3 pb-2 border-t border-border flex items-center justify-between gap-2">
				<button
					type="button"
					disabled
					title={regenPendingLabel}
					aria-label={regenPendingLabel}
					class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[12px] text-text-subtle cursor-not-allowed min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
				>{t('inbox.draft_regenerate')}</button>
				<button
					type="button"
					disabled
					title={sendPendingLabel}
					aria-label={sendPendingLabel}
					class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[12px] text-text-subtle cursor-not-allowed min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
				>{t('inbox.draft_send')} ⌘↵</button>
			</footer>
		</div>
	</div>
{/if}
