<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t, getLocale } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import { clickOutside } from '../utils/click-outside.js';
	import {
		closeDraftPane,
		createDraftForOpenPane,
		generateDraftForOpenPane,
		getDraftPane,
		getSelectedFull,
		getSelectedThread,
		refreshOpenPaneBody,
		regenerateDraftWithTone,
		saveDraftBody,
		sendOpenPaneDraft,
		type DraftTone,
		type InboxItem,
	} from '../stores/inbox.svelte.js';
	import type {
		GenerateDraftFailure,
		RefreshBodyFailure,
		SendReplyFailure,
	} from '../api/inbox-drafts.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { accountShortLabel } from '../utils/account-label.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import InboxThreadHistory from './InboxThreadHistory.svelte';

	interface Props {
		item: InboxItem | null;
	}
	const { item }: Props = $props();

	let buffer = $state('');
	let textareaRef = $state<HTMLTextAreaElement | null>(null);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let creating = $state(false);
	let lastMirroredDraftId = $state<string | null>(null);

	// Mirror only when the underlying draft *identity* changes (open, create,
	// regenerate, close). A naive mirror of `persistedBody` would re-fire on
	// every PATCH echo and clobber keystrokes typed during the 600 ms +
	// round-trip window — the user would watch their last word vanish.
	$effect(() => {
		const pane = getDraftPane();
		const draftId = pane?.draft?.id ?? null;
		if (draftId === lastMirroredDraftId) return;
		lastMirroredDraftId = draftId;
		buffer = pane?.persistedBody ?? '';
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
		// ⌘/Ctrl+Enter: explicit user-confirm to send the draft as a reply.
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void onSendClick();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			flushNow();
			closeDraftPane();
		}
	}

	let sending = $state(false);

	function toastForSendFailure(reason: SendReplyFailure): { silent: boolean; key: string; level: 'info' | 'error' } {
		switch (reason.kind) {
			case 'aborted':         return { silent: true, key: '', level: 'info' };
			case 'unavailable':     return { silent: false, key: 'inbox.draft_send_unavailable', level: 'info' };
			case 'unsupported':     return { silent: false, key: 'inbox.draft_send_unsupported', level: 'info' };
			case 'not_registered':  return { silent: false, key: 'inbox.draft_send_not_registered', level: 'info' };
			case 'receive_only':    return { silent: false, key: 'inbox.draft_send_receive_only', level: 'error' };
			case 'secret_in_body':  return { silent: false, key: 'inbox.draft_send_secret_in_body', level: 'error' };
			case 'empty_body':      return { silent: false, key: 'inbox.draft_send_empty_body', level: 'error' };
			case 'rate_limit':      return { silent: false, key: 'inbox.draft_send_rate_limit', level: 'info' };
			case 'not_found':       return { silent: false, key: 'inbox.draft_send_not_found', level: 'error' };
			case 'fetch_failed':    return { silent: false, key: 'inbox.draft_send_failed', level: 'error' };
			case 'network':         return { silent: false, key: 'inbox.draft_send_failed', level: 'error' };
		}
	}

	async function onSendClick(): Promise<void> {
		if (sending) return;
		const pane = getDraftPane();
		if (!pane?.draft) return;
		sending = true;
		try {
			const result = await sendOpenPaneDraft(buffer);
			if (result.ok) {
				addToast(t('inbox.draft_send_ok'), 'success');
				closeDraftPane();
				return;
			}
			const hint = toastForSendFailure(result.reason);
			if (!hint.silent) addToast(t(hint.key), hint.level);
		} finally {
			sending = false;
		}
	}

	let scheduleMenuOpen = $state(false);

	// Send Later presets — same temporal anchoring as snooze (server
	// resolves preset → ISO with timezone). Heute Abend / Morgen früh /
	// Montag 09 Uhr cover the common deferred-send scenarios.
	function presetToDate(preset: 'tonight' | 'tomorrow_morning' | 'monday_9am'): Date {
		const now = new Date();
		const d = new Date(now);
		switch (preset) {
			case 'tonight':
				d.setHours(18, 0, 0, 0);
				if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
				return d;
			case 'tomorrow_morning':
				d.setDate(d.getDate() + 1);
				d.setHours(9, 0, 0, 0);
				return d;
			case 'monday_9am': {
				const dow = d.getDay();
				const daysUntilMonday = ((1 - dow + 7) % 7) || 7;
				d.setDate(d.getDate() + daysUntilMonday);
				d.setHours(9, 0, 0, 0);
				return d;
			}
		}
	}

	async function onScheduleSend(preset: 'tonight' | 'tomorrow_morning' | 'monday_9am'): Promise<void> {
		if (sending) return;
		scheduleMenuOpen = false;
		const pane = getDraftPane();
		if (!pane?.draft) return;
		const scheduledAt = presetToDate(preset);
		sending = true;
		try {
			const result = await sendOpenPaneDraft(buffer, scheduledAt);
			if (result.ok && 'scheduled' in result) {
				addToast(t('inbox.draft_scheduled_ok').replace('{time}', scheduledAt.toLocaleString()), 'success');
				closeDraftPane();
				return;
			}
			if (!result.ok) {
				const hint = toastForSendFailure(result.reason);
				if (!hint.silent) addToast(t(hint.key), hint.level);
			}
		} finally {
			sending = false;
		}
	}

	/**
	 * Map a generator failure to user-facing copy. Recoverable failures
	 * (unavailable / unsupported / no_body) tell the user we're falling
	 * back to a manual draft. `aborted` is the "pane was closed" sentinel
	 * and surfaces no UI at all. not_found / network are terminal.
	 */
	function toastForGenerateFailure(reason: GenerateDraftFailure): { fallback: boolean; silent: boolean; key: string; level: 'info' | 'error' } {
		switch (reason.kind) {
			case 'aborted':
				return { fallback: false, silent: true, key: '', level: 'info' };
			case 'unavailable':
				return { fallback: true, silent: false, key: 'inbox.draft_generate_unavailable', level: 'info' };
			case 'unsupported':
				return { fallback: true, silent: false, key: 'inbox.draft_generate_unsupported', level: 'info' };
			case 'no_body':
				return { fallback: true, silent: false, key: 'inbox.draft_generate_no_body', level: 'info' };
			case 'not_found':
				return { fallback: false, silent: false, key: 'inbox.draft_error_load', level: 'error' };
			case 'network':
				return { fallback: false, silent: false, key: 'inbox.draft_generate_failed', level: 'error' };
		}
	}

	async function onCreateClick(): Promise<void> {
		if (creating) return;
		creating = true;
		try {
			// Try LLM generation first; fall back to a manual starter when
			// the backend tells us generation is unavailable for this item.
			const result = await generateDraftForOpenPane();
			if (result.ok) return;
			const hint = toastForGenerateFailure(result.reason);
			if (!hint.silent) addToast(t(hint.key), hint.level);
			if (hint.fallback) await createDraftForOpenPane();
		} finally {
			creating = false;
		}
	}

	onDestroy(() => {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		flushNow();
	});

	// Derive UI labels once per locale change instead of per keystroke.
	const sendLabel = $derived(t('inbox.draft_send'));

	// Tone-rewrite flow: the "Kürzer / Förmlicher / Wärmer / Regenerate"
	// buttons replace the current draft with a fresh LLM variant. If the
	// buffer is dirty (userEditsCount > 0 OR the buffer diverges from the
	// last-saved body), we show an edit-loss confirmation per PRD §Draft
	// Editor before discarding the user's edits.
	let pendingTone = $state<DraftTone | null>(null);
	let confirmDialogRef = $state<HTMLDivElement | null>(null);

	// Focus the alertdialog as soon as it mounts — without this, Esc from a
	// mouse-clicked tone button never reaches the dialog's onkeydown because
	// the button still holds focus underneath the modal.
	$effect(() => {
		if (pendingTone !== null && confirmDialogRef) confirmDialogRef.focus();
	});

	function hasUserEdits(): boolean {
		const pane = getDraftPane();
		if (!pane?.draft) return false;
		if (pane.draft.userEditsCount > 0) return true;
		return buffer !== pane.persistedBody;
	}

	async function runToneRewrite(tone: DraftTone): Promise<void> {
		// Flush any pending body save BEFORE generating so the rewrite
		// sees the user's latest edits as the previous draft.
		flushNow();
		const result = await regenerateDraftWithTone(tone, buffer);
		if (result.ok) return;
		const hint = toastForGenerateFailure(result.reason);
		if (!hint.silent) addToast(t(hint.key), hint.level);
	}

	function onToneClick(tone: DraftTone): void {
		if (hasUserEdits()) {
			pendingTone = tone;
			return;
		}
		void runToneRewrite(tone);
	}

	function confirmTone(): void {
		const tone = pendingTone;
		pendingTone = null;
		if (tone) void runToneRewrite(tone);
	}

	function cancelTone(): void {
		pendingTone = null;
	}

	let refreshing = $state(false);

	function toastForRefreshFailure(reason: RefreshBodyFailure): { silent: boolean; key: string; level: 'info' | 'error' } {
		switch (reason.kind) {
			case 'aborted':        return { silent: true, key: '', level: 'info' };
			case 'unavailable':    return { silent: false, key: 'inbox.draft_refresh_unavailable', level: 'info' };
			case 'unsupported':    return { silent: false, key: 'inbox.draft_refresh_unsupported', level: 'info' };
			case 'not_registered': return { silent: false, key: 'inbox.draft_refresh_not_registered', level: 'info' };
			case 'empty_body':     return { silent: false, key: 'inbox.draft_refresh_empty', level: 'info' };
			case 'not_found':      return { silent: false, key: 'inbox.draft_refresh_not_found', level: 'info' };
			case 'fetch_failed':   return { silent: false, key: 'inbox.draft_refresh_failed', level: 'error' };
			case 'network':        return { silent: false, key: 'inbox.draft_refresh_failed', level: 'error' };
		}
	}

	async function onRefreshClick(): Promise<void> {
		if (refreshing) return;
		refreshing = true;
		try {
			const result = await refreshOpenPaneBody();
			if (result.ok) {
				addToast(t('inbox.draft_refresh_ok'), 'success');
				return;
			}
			const hint = toastForRefreshFailure(result.reason);
			if (!hint.silent) addToast(t(hint.key), hint.level);
		} finally {
			refreshing = false;
		}
	}

	// Context block — the email-being-replied-to. Reads from the same selected-
	// item state the reading pane uses, so when the user opens the draft from
	// list or reading-pane they see what they're replying to.
	const selectedFull = $derived(getSelectedFull());
	const selectedThread = $derived(getSelectedThread());
	let contextExpanded = $state(false);

	function dateFormat(iso: string | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return d.toLocaleDateString(locale, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	}
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
			style="padding-top: env(safe-area-inset-top);"
		>
			<header class="flex items-start justify-between gap-3 px-5 pt-3 pb-3 border-b border-border">
				<div class="flex items-start gap-2 min-w-0 flex-1">
					<!-- Mobile back-button. Hidden on sm+ where the pane is a right-side modal
						and the × button on the right is the dismissal affordance. -->
					<button
						type="button"
						onclick={() => { flushNow(); closeDraftPane(); }}
						class="sm:hidden text-text-subtle hover:text-text text-base p-2 -ml-2 -mt-1 min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
						aria-label={t('inbox.draft_close')}
					>←</button>
					<div class="min-w-0 flex-1">
						<h2 id="draft-pane-title" class="text-base font-medium tracking-tight">
							{t('inbox.draft_title')}
						</h2>
						{#if item}
							<p class="text-[11px] text-text-subtle mt-0.5 flex items-center gap-1 min-w-0">
								<Icon name="envelope" size="xs" />
								<span class="truncate">{accountShortLabel(item.accountId)} · {item.reasonDe}</span>
							</p>
						{/if}
					</div>
				</div>
				<div class="flex items-center gap-1 shrink-0">
					{#if item}
						<button
							type="button"
							onclick={() => void onRefreshClick()}
							disabled={refreshing}
							title={refreshing ? t('inbox.draft_refresh_in_flight') : t('inbox.draft_refresh_body')}
							aria-label={t('inbox.draft_refresh_body')}
							class="text-text-subtle hover:text-text text-[11px] font-mono p-2 -mt-1 min-h-[32px] pointer-coarse:min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed"
						>{refreshing ? '⟳' : '↻'}</button>
					{/if}
					<button
						type="button"
						onclick={() => { flushNow(); closeDraftPane(); }}
						aria-label={t('inbox.draft_close')}
						class="text-text-subtle hover:text-text text-sm leading-none p-2 -mr-1 -mt-1 min-h-[32px] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
					>×</button>
				</div>
			</header>

			<div class="flex-1 overflow-y-auto px-5 py-4">
				<!-- Context block: the email-being-replied-to. Collapsed by default;
					tap "Mehr anzeigen" to expand the full body + thread chain so the
					user can verify the LLM-generated draft against the original message
					before sending. Mobile users used to have NO way to see context — they
					were stuck staring at a generated reply with no source. -->
				{#if selectedFull && item && selectedFull.item.id === item.id}
					<section
						class="mb-3 rounded-[var(--radius-md)] border border-border bg-bg"
						aria-label={t('inbox.draft_context_label')}
					>
						<button
							type="button"
							onclick={() => (contextExpanded = !contextExpanded)}
							aria-expanded={contextExpanded}
							class="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-bg-muted/30 rounded-[var(--radius-md)] min-h-[44px]"
						>
							<span class="text-text-subtle text-[11px] mt-0.5 shrink-0" aria-hidden="true">{contextExpanded ? '▾' : '▸'}</span>
							<div class="min-w-0 flex-1">
								<div class="flex items-baseline justify-between gap-2 mb-0.5">
									<span class="text-[12px] text-text-muted truncate">
										{selectedFull.item.fromName || selectedFull.item.fromAddress || ''}
									</span>
									<span class="text-[11px] text-text-subtle shrink-0">
										{dateFormat(selectedFull.item.mailDate ?? selectedFull.item.classifiedAt)}
									</span>
								</div>
								{#if selectedFull.item.subject}
									<p class="text-[12px] text-text leading-tight truncate" title={selectedFull.item.subject}>
										{selectedFull.item.subject}
									</p>
								{/if}
							</div>
						</button>
						{#if contextExpanded}
							<div class="border-t border-border px-3 py-3 space-y-3">
								{#if selectedFull.body.source === 'missing'}
									<p class="rounded-[var(--radius-sm)] border border-warning bg-warning-subtle px-3 py-2 text-[11px] text-warning">
										{t('inbox.reading_body_missing')}
									</p>
								{:else}
									<article class="prose prose-sm max-w-none text-[13px]">
										<MarkdownRenderer content={selectedFull.body.md} streaming={false} />
									</article>
								{/if}
								{#if selectedThread && (selectedThread.messages.length > 0 || selectedThread.partial)}
									<InboxThreadHistory thread={selectedThread} currentMessageId={selectedFull.item.messageId} />
								{/if}
							</div>
						{/if}
					</section>
				{/if}

				{#if pane.loading}
					<p class="text-text-subtle text-sm">{t('inbox.draft_loading')}</p>
				{:else if pane.generating}
					<div class="rounded-[var(--radius-md)] bg-bg border border-dashed border-border px-4 py-6 text-sm text-text-muted">
						<p class="flex items-center gap-2" aria-live="polite">
							<span class="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" aria-hidden="true"></span>
							{t('inbox.draft_generating')}
						</p>
					</div>
				{:else if pane.draft === null}
					<div class="rounded-[var(--radius-md)] bg-bg border border-dashed border-border px-4 py-6 text-sm text-text-muted flex flex-col gap-3 items-start">
						<p>{t('inbox.draft_none_yet')}</p>
						<button
							type="button"
							onclick={() => void onCreateClick()}
							disabled={creating}
							class="rounded-[var(--radius-sm)] bg-accent/15 hover:bg-accent/25 text-accent-text px-3 py-1.5 text-sm min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4 disabled:opacity-50 disabled:cursor-not-allowed"
						>{creating ? t('inbox.draft_generating') : t('inbox.draft_create')}</button>
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

			<footer class="px-5 pt-3 pb-2 border-t border-border">
				<!-- Tone buttons in a horizontally scrolling row on mobile so they stay
					on ONE line instead of wrapping to multiple rows (used to eat ~3 rows
					of vertical space on iPhone). Send button on its own line below for
					tap accuracy. On sm+ everything goes on one line like before. -->
				<div class="flex sm:flex-row flex-col gap-2 sm:items-center sm:justify-between">
					<div class="flex items-center gap-1.5 overflow-x-auto scrollbar-none -mx-1 px-1 sm:overflow-visible">
						{#each [
							{ tone: 'shorter', label: 'inbox.draft_tone_shorter' },
							{ tone: 'formal', label: 'inbox.draft_tone_formal' },
							{ tone: 'warmer', label: 'inbox.draft_tone_warmer' },
							{ tone: 'regenerate', label: 'inbox.draft_regenerate' },
						] as const as opt (opt.tone)}
							<button
								type="button"
								onclick={() => onToneClick(opt.tone)}
								disabled={pane.generating || pane.draft === null}
								class="shrink-0 rounded-[var(--radius-sm)] border border-border bg-bg hover:border-border-hover hover:text-text px-3 py-1.5 text-[12px] text-text-muted min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4 disabled:opacity-50 disabled:cursor-not-allowed"
							>{t(opt.label)}</button>
						{/each}
					</div>
					<div class="flex w-full sm:w-auto items-stretch gap-1">
						<button
							type="button"
							onclick={() => void onSendClick()}
							disabled={sending || pane.draft === null || pane.generating}
							title={sendLabel}
							aria-label={sendLabel}
							class="flex-1 sm:flex-none rounded-[var(--radius-sm)] bg-accent/15 hover:bg-accent/25 text-accent-text px-3 py-1.5 text-[12px] min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4 disabled:opacity-50 disabled:cursor-not-allowed"
						>{sending ? t('inbox.draft_send_in_flight') : t('inbox.draft_send')} ⌘↵</button>
						<div class="relative" use:clickOutside={() => (scheduleMenuOpen = false)}>
							<button
								type="button"
								onclick={() => (scheduleMenuOpen = !scheduleMenuOpen)}
								disabled={sending || pane.draft === null || pane.generating}
								aria-expanded={scheduleMenuOpen}
								aria-haspopup="menu"
								aria-label={t('inbox.draft_schedule_send')}
								title={t('inbox.draft_schedule_send')}
								class="rounded-[var(--radius-sm)] bg-accent/15 hover:bg-accent/25 text-accent-text px-2.5 py-1.5 text-[12px] min-h-[36px] pointer-coarse:min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed"
							>{t('inbox.draft_schedule_send_short')}</button>
							{#if scheduleMenuOpen}
								<ul
									role="menu"
									class="absolute right-0 bottom-full mb-1 z-10 min-w-[200px] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg overflow-hidden"
								>
									<li role="none">
										<button type="button" role="menuitem" onclick={() => void onScheduleSend('tonight')} class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[40px]"
										>{t('inbox.draft_schedule_tonight')}</button>
									</li>
									<li role="none">
										<button type="button" role="menuitem" onclick={() => void onScheduleSend('tomorrow_morning')} class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[40px]"
										>{t('inbox.draft_schedule_tomorrow')}</button>
									</li>
									<li role="none">
										<button type="button" role="menuitem" onclick={() => void onScheduleSend('monday_9am')} class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[40px]"
										>{t('inbox.draft_schedule_monday')}</button>
									</li>
								</ul>
							{/if}
						</div>
					</div>
				</div>
			</footer>
		</div>
	</div>

	{#if pendingTone !== null}
		<div
			class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4"
			role="presentation"
			onclick={cancelTone}
		>
			<div
				bind:this={confirmDialogRef}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="tone-confirm-title"
				tabindex="-1"
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => { if (e.key === 'Escape') cancelTone(); }}
				class="bg-bg-subtle border border-border shadow-xl max-w-md w-full p-6 outline-none rounded-t-[var(--radius-lg)] sm:rounded-[var(--radius-lg)] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
			>
				<h2 id="tone-confirm-title" class="text-base font-medium tracking-tight mb-2">
					{t('inbox.draft_tone_confirm_title')}
				</h2>
				<p class="text-[13px] text-text-muted mb-4">{t('inbox.draft_tone_confirm_body')}</p>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={cancelTone}
						class="rounded-[var(--radius-sm)] border border-border bg-bg hover:border-border-hover px-3 py-1.5 text-[12px] text-text-muted hover:text-text min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
					>{t('inbox.draft_tone_confirm_cancel')}</button>
					<button
						type="button"
						onclick={confirmTone}
						class="rounded-[var(--radius-sm)] bg-accent/15 hover:bg-accent/25 text-accent-text px-3 py-1.5 text-[12px] min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
					>{t('inbox.draft_tone_confirm_continue')}</button>
				</div>
			</div>
		</div>
	{/if}
{/if}
