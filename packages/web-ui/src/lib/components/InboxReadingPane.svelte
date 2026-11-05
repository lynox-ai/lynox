<script lang="ts">
	import { goto } from '$app/navigation';
	import { t, getLocale } from '../i18n.svelte.js';
	import { clickOutside } from '../utils/click-outside.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import {
		closeItem,
		getSelectedFull,
		getSelectedThread,
		isSelectedLoading,
		refreshSelectedItemBody,
		setItemAction,
		setItemSnooze,
		type InboxItem,
		type InboxRuleWithheld,
		type InboxRuleWithheldReason,
		type SnoozePreset,
	} from '../stores/inbox.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { inboxHeadline } from '../utils/inbox-headline.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import InboxThreadHistory from './InboxThreadHistory.svelte';
	import Icon from '../primitives/Icon.svelte';
	import { sanitizeFramingField } from '../utils/chat-framing.js';

	interface Props {
		/** Fires on archive/snooze actions so the parent can refresh the list. */
		onActionApplied?: () => void;
		/** Mobile back-button is shown when true (hidden on three-pane desktop). */
		showBack?: boolean;
		/** Optional content rendered at the end of the body scroll container (e.g. inline context). */
		children?: import('svelte').Snippet;
	}

	const { onActionApplied, showBack = false, children }: Props = $props();

	// "Im Chat beantworten": replying is chat-with-context, not a bespoke
	// composer. Open a fresh chat seeded with a typed reference to this mail item;
	// the server resolves it into a context preamble (sender/subject/body + the
	// uid) so the agent can draft + send via mail_reply. (Mirrors the workflow
	// "💬 Bearbeiten" entry.)
	function replyInChat(item: InboxItem): void {
		newChat();
		// Sanitize the externally-authored mail subject before it seeds the chat —
		// a crafted subject (newline / U+2028 / U+0085 NEL + "[System: …]") would
		// otherwise inject a pseudo-directive on its own line into the framing the
		// agent reads. Mirrors the other chat-over-bespoke consumers, which all
		// wrap their external fields in sanitizeFramingField.
		const framing = `${t('inbox.reply_in_chat_prompt')} „${sanitizeFramingField(item.subject)}".`;
		void sendMessage(framing, undefined, undefined, { context: { kind: 'mail', id: item.id } });
		void goto('/app');
	}

	const full = $derived(getSelectedFull());
	const thread = $derived(getSelectedThread());
	const loading = $derived(isSelectedLoading());
	let snoozeOpen = $state(false);
	let refreshing = $state(false);

	async function onRefreshBody(): Promise<void> {
		if (refreshing) return;
		refreshing = true;
		try {
			const result = await refreshSelectedItemBody();
			if (result.ok) {
				addToast(t('inbox.body_refresh_ok'), 'success');
				return;
			}
			if (result.reason.kind === 'aborted') return;
			const keyMap: Record<string, string> = {
				unavailable: 'inbox.body_refresh_unavailable',
				unsupported: 'inbox.body_refresh_unsupported',
				not_registered: 'inbox.body_refresh_not_registered',
				empty_body: 'inbox.body_refresh_empty',
				not_found: 'inbox.body_refresh_not_found',
				fetch_failed: 'inbox.body_refresh_failed',
				network: 'inbox.body_refresh_failed',
			};
			addToast(t(keyMap[result.reason.kind] ?? 'inbox.body_refresh_failed'), 'info');
		} finally {
			refreshing = false;
		}
	}

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

	async function onArchive(): Promise<void> {
		if (!full) return;
		await setItemAction(full.item.id, 'archived');
		onActionApplied?.();
		closeItem();
	}

	// `notifyOnUnsnoozeOnNext` lets the same date-picker drive either a
	// silent snooze or an active reminder — set true before the user picks
	// a preset by the "📌 Erinner mich" button, false otherwise.
	let notifyOnUnsnoozeOnNext = $state(false);

	async function onSnoozePreset(preset: SnoozePreset): Promise<void> {
		if (!full) return;
		snoozeOpen = false;
		const notify = notifyOnUnsnoozeOnNext;
		notifyOnUnsnoozeOnNext = false;
		await setItemSnooze(full.item.id, null, null, true, preset, notify);
		onActionApplied?.();
		closeItem();
	}


	// A rule named this mail but was not applied: the pane says which and why, and where it
	// follows from the reason, offers the fixed rule that would apply (from the sender or subject).
	const WITHHELD_KEYS: Record<InboxRuleWithheldReason, string> = {
		rule_withheld_classifier: 'inbox.rule_withheld_classifier',
		rule_withheld_unchecked: 'inbox.rule_withheld_unchecked',
		rule_withheld_sensitive: 'inbox.rule_withheld_sensitive',
		forwarded_by_person: 'inbox.rule_withheld_forwarded',
	};

	/** The hint's sentence, split around the rule's name so the name can link to the rule. */
	function withheldParts(w: InboxRuleWithheld): { before: string; name: string | null; after: string } {
		const key = WITHHELD_KEYS[w.reason];
		if (w.name === null || w.name.length === 0) return { before: t(`${key}_unnamed`), name: null, after: '' };
		const template = t(key);
		const at = template.indexOf('{name}');
		if (at === -1) return { before: template, name: null, after: '' };
		return { before: template.slice(0, at), name: w.name, after: template.slice(at + '{name}'.length) };
	}

	/** A sensitive mail would be held back from a fixed rule too: no way to one is offered. */
	function offersFixedRule(w: InboxRuleWithheld): boolean {
		return w.reason !== 'rule_withheld_sensitive';
	}

	/** The rule view with the form prefilled for a fixed rule on this mail. */
	function fixedRuleHref(item: InboxItem, kind: 'from' | 'subject_contains', value: string): string {
		const params = new URLSearchParams({ accountId: item.accountId, kind, value });
		return `/app/inbox/rules?${params.toString()}`;
	}

	/** The rule view of the account, at the rule; none once the rule is deleted. */
	function withheldRuleHref(item: InboxItem, w: InboxRuleWithheld): string | null {
		if (w.id === null) return null;
		return `/app/inbox/rules?${new URLSearchParams({ accountId: item.accountId }).toString()}#rule-${encodeURIComponent(w.id)}`;
	}

	const snoozePresets: ReadonlyArray<{ label: string; preset: SnoozePreset }> = $derived([
		{ label: t('inbox.snooze_today'), preset: 'later_today' as const },
		{ label: t('inbox.snooze_tomorrow'), preset: 'tomorrow_morning' as const },
		{ label: t('inbox.snooze_monday_9'), preset: 'monday_9am' as const },
		{ label: t('inbox.snooze_week'), preset: 'next_week' as const },
	]);
</script>

{#if !full && !loading}
	<div class="flex h-full items-center justify-center p-8 text-center">
		<p class="text-sm text-text-subtle">{t('inbox.reading_empty_state')}</p>
	</div>
{:else}
	<div class="flex h-full flex-col bg-bg">
		<!-- Mobile-first layout: subject + metadata get full width on mobile (no longer
			competing with 5 action buttons for ~30px of horizontal space). Action row
			stacks below on mobile, sits inline on the right on sm+. -->
		<header class="border-b border-border px-4 py-3">
			<!-- Row 1: nav (back) + title (flex-1, wraps so long subjects stay legible)
				+ close on the right. The earlier single-row layout shoved 5+ action
				buttons into the same line as the subject — title clipped, refresh slid
				under back. Multi-row gives the title the full pane width. -->
			<div class="flex items-start gap-2">
				{#if showBack}
					<button
						type="button"
						class="shrink-0 flex items-center gap-1 text-text-subtle hover:text-text text-[12px] min-h-[44px] sm:min-h-[36px] -ml-1 px-2"
						onclick={() => closeItem()}
						aria-label={t('inbox.reading_back')}
					>
						<span aria-hidden="true">←</span>
						<span class="hidden sm:inline">{t('inbox.reading_back')}</span>
					</button>
				{/if}
				<div class="min-w-0 flex-1">
					{#if loading && !full}
						<div class="space-y-2" aria-busy="true">
							<div class="h-5 w-2/3 animate-pulse rounded bg-bg-subtle"></div>
							<div class="h-4 w-1/2 animate-pulse rounded bg-bg-subtle"></div>
						</div>
					{:else if full}
						<h2 class="text-base sm:text-lg font-semibold text-text break-words [overflow-wrap:anywhere]" title={full.item.subject || full.item.snippet || full.item.reasonDe}>
							{inboxHeadline(full.item)}
						</h2>
						<div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-text-subtle">
							<span class="text-text-muted break-words [overflow-wrap:anywhere] min-w-0">
								{full.item.fromName || full.item.fromAddress}
								{#if full.item.fromName}
									<span class="text-text-subtle">&lt;{full.item.fromAddress}&gt;</span>
								{/if}
							</span>
							<span class="whitespace-nowrap">{dateFormat(full.item.mailDate ?? full.item.classifiedAt)}</span>
						</div>
					{/if}
				</div>
				<button
					type="button"
					class="shrink-0 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5 text-[11px] text-text-subtle hover:text-text hover:border-border-hover min-h-[44px] sm:min-h-[36px] sm:min-w-0 min-w-[44px]"
					onclick={() => closeItem()}
					aria-label={t('inbox.reading_close')}
				>×</button>
			</div>

			<!-- Row 2 (sm+): action buttons on their own row so the title above keeps
				the full pane width. flex-wrap so a narrow viewport stacks them onto
				two lines instead of clipping. Snooze + "Erinner mich" used to be two
				buttons opening the same preset menu — consolidated into one Snooze
				button with a "+ benachrichtigen wenn fällig" checkbox at the foot
				of the menu. -->
			{#if full}
				<div class="hidden sm:flex flex-wrap items-center gap-1.5 mt-3">
					<button
						type="button"
						class="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-accent bg-accent px-3 py-1.5 text-[11px] text-accent-fg hover:opacity-90 min-h-[36px]"
						onclick={() => replyInChat(full!.item)}
						aria-label={t('inbox.reply_in_chat')}
					><Icon name="chat" size="xs" />{t('inbox.reply_in_chat')}</button>
					<button
						type="button"
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px]"
						onclick={() => void onArchive()}
						aria-label={t('inbox.action_archive')}
					>{t('inbox.action_archive')}</button>
					<div class="relative" use:clickOutside={() => (snoozeOpen = false)}>
						<button
							type="button"
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px]"
							onclick={() => (snoozeOpen = !snoozeOpen)}
							aria-expanded={snoozeOpen}
							aria-haspopup="menu"
							aria-label={t('inbox.action_snooze')}
						>{t('inbox.action_snooze')}</button>
						{#if snoozeOpen}
							<div
								role="menu"
								class="absolute right-0 z-10 mt-1 min-w-[220px] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg overflow-hidden"
							>
								{#each snoozePresets as p (p.preset)}
									<button
										type="button"
										role="menuitem"
										class="block w-full px-3 py-2 text-left text-[11px] text-text-muted hover:bg-bg-subtle hover:text-text"
										onclick={() => void onSnoozePreset(p.preset)}
									>{p.label}</button>
								{/each}
								<label class="flex items-start gap-2 border-t border-border px-3 py-2 cursor-pointer text-[11px] text-text-muted hover:bg-bg-subtle">
									<input
										type="checkbox"
										checked={notifyOnUnsnoozeOnNext}
										onchange={(e) => (notifyOnUnsnoozeOnNext = (e.currentTarget as HTMLInputElement).checked)}
										class="mt-0.5"
										onclick={(e) => e.stopPropagation()}
									/>
									<span>{t('inbox.action_notify_on_unsnooze')}</span>
								</label>
							</div>
						{/if}
					</div>
					<button
						type="button"
						onclick={() => void onRefreshBody()}
						disabled={refreshing}
						title={t('inbox.body_refresh_body_hint')}
						aria-label={t('inbox.body_refresh_body')}
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-subtle hover:text-text hover:border-border-hover min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed"
					>{refreshing ? t('inbox.body_refresh_in_flight') : t('inbox.body_refresh_full_body')}</button>
				</div>
			{/if}

			<!-- Mobile-only action row: stacks below the subject so the buttons no longer
				starve the content of horizontal space. Touch-sized (min-h-[44px]). -->
			{#if full}
				<div class="mt-3 flex items-center gap-1.5 sm:hidden">
					<button
						type="button"
						class="flex-1 flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-accent bg-accent px-3 py-2 text-[12px] text-accent-fg hover:opacity-90 min-h-[44px]"
						onclick={() => replyInChat(full!.item)}
						aria-label={t('inbox.reply_in_chat')}
					><Icon name="chat" size="xs" />{t('inbox.reply_in_chat')}</button>
					<button
						type="button"
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[12px] text-text-muted hover:text-text hover:border-border-hover min-h-[44px]"
						onclick={() => void onArchive()}
						aria-label={t('inbox.action_archive')}
					>{t('inbox.action_archive')}</button>
					<div class="relative" use:clickOutside={() => (snoozeOpen = false)}>
						<button
							type="button"
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[12px] text-text-muted hover:text-text hover:border-border-hover min-h-[44px]"
							onclick={() => (snoozeOpen = !snoozeOpen)}
							aria-expanded={snoozeOpen}
							aria-haspopup="menu"
							aria-label={t('inbox.action_snooze')}
						>{t('inbox.action_snooze')}</button>
						{#if snoozeOpen}
							<div
								role="menu"
								class="absolute right-0 z-10 mt-1 min-w-[220px] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg overflow-hidden"
							>
								{#each snoozePresets as p (p.preset)}
									<button
										type="button"
										role="menuitem"
										class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[44px]"
										onclick={() => void onSnoozePreset(p.preset)}
									>{p.label}</button>
								{/each}
								<label class="flex items-start gap-2 border-t border-border px-3 py-2 cursor-pointer text-[12px] text-text-muted hover:bg-bg-subtle">
									<input
										type="checkbox"
										checked={notifyOnUnsnoozeOnNext}
										onchange={(e) => (notifyOnUnsnoozeOnNext = (e.currentTarget as HTMLInputElement).checked)}
										class="mt-0.5"
										onclick={(e) => e.stopPropagation()}
									/>
									<span>{t('inbox.action_notify_on_unsnooze')}</span>
								</label>
							</div>
						{/if}
					</div>
					<button
						type="button"
						onclick={() => void onRefreshBody()}
						disabled={refreshing}
						title={t('inbox.body_refresh_body_hint')}
						aria-label={t('inbox.body_refresh_body')}
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[12px] text-text-subtle hover:text-text hover:border-border-hover min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed"
					>{refreshing ? t('inbox.body_refresh_in_flight') : t('inbox.body_refresh_full_body')}</button>
				</div>
			{/if}
		</header>

		<div class="flex-1 overflow-y-auto px-4 py-4">
			{#if loading && !full}
				<div class="space-y-2" aria-busy="true">
					<div class="h-3 w-full animate-pulse rounded bg-bg-subtle"></div>
					<div class="h-3 w-11/12 animate-pulse rounded bg-bg-subtle"></div>
					<div class="h-3 w-10/12 animate-pulse rounded bg-bg-subtle"></div>
				</div>
			{:else if full}
				{@const withheld = full.item.ruleWithheld ?? null}
				{#if withheld !== null}
					{@const parts = withheldParts(withheld)}
					{@const ruleHref = withheldRuleHref(full.item, withheld)}
					<div class="mb-4 rounded-[var(--radius-md)] border border-warning/20 bg-warning/10 px-3 py-2 text-[12px] text-text" role="note" data-testid="inbox-rule-withheld">
						<p data-testid="inbox-rule-withheld-text">{parts.before}{#if parts.name !== null}{#if ruleHref !== null}<a href={ruleHref} class="underline hover:text-accent-text" data-testid="inbox-rule-withheld-link">{parts.name}</a>{:else}{parts.name}{/if}{/if}{parts.after}</p>
						{#if offersFixedRule(withheld)}
							{@const sender = full.item.fromAddress.trim()}
							{@const subject = full.item.subject.trim()}
							{#if sender.length > 0 || subject.length > 0}
								<div class="mt-2 flex flex-wrap gap-1.5">
									{#if sender.length > 0}
										<a
											href={fixedRuleHref(full.item, 'from', sender)}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px] pointer-coarse:min-h-[44px] inline-flex items-center"
											data-testid="inbox-rule-withheld-from-sender"
										>{t('inbox.rule_withheld_from_sender')}</a>
									{/if}
									{#if subject.length > 0}
										<a
											href={fixedRuleHref(full.item, 'subject_contains', subject)}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px] pointer-coarse:min-h-[44px] inline-flex items-center"
											data-testid="inbox-rule-withheld-from-subject"
										>{t('inbox.rule_withheld_from_subject')}</a>
									{/if}
								</div>
							{/if}
						{/if}
					</div>
				{/if}
				{#if full.body.source === 'missing'}
					<p class="rounded-[var(--radius-md)] border border-warning bg-warning-subtle px-3 py-2 text-[12px] text-warning">
						{t('inbox.reading_body_missing')}
					</p>
				{:else}
					<article class="prose prose-sm max-w-none">
						<MarkdownRenderer content={full.body.md} streaming={false} />
					</article>
				{/if}
				{#if thread && (thread.messages.length > 0 || thread.partial)}
					<div class="mt-6">
						<InboxThreadHistory {thread} currentMessageId={full.item.messageId} />
					</div>
				{/if}
				{@render children?.()}
			{/if}
		</div>
	</div>
{/if}
