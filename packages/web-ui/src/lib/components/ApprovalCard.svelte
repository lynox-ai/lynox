<script lang="ts">
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import { visibleText } from '../visible-text.js';
	import {
		approvalActionable, approvalMovableToChat, approvalNeedsSecondClick, approvalSendable, approvalSetupName,
		type ApprovalAddress, type ApprovalCardData,
	} from './approvals.js';

	let { card, busy = false, onDecide, onMoveToChat }: {
		card: ApprovalCardData;
		busy?: boolean;
		onDecide: (card: ApprovalCardData, action: 'approve' | 'reject') => void;
		/** Moves the mail to chat to change it; without it, the card offers no such action. */
		onMoveToChat?: ((card: ApprovalCardData) => void) | undefined;
	} = $props();

	/** The second click's step, open only for a mail that needs one. */
	let confirming = $state(false);

	const actionable = $derived(approvalActionable(card));
	const sendable = $derived(approvalSendable(card));
	const movable = $derived(onMoveToChat !== undefined && approvalMovableToChat(card));
	const mail = $derived(card.mail);
	const recipientCount = $derived(
		mail === null ? 0 : new Set([...mail.to, ...mail.cc, ...mail.bcc].map((a) => a.address.trim().toLowerCase())).size,
	);

	function when(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
	}

	/** An address is not running text: every hidden character in it is shown, none taken as part of a word. */
	const ADDRESS = { inPlace: false } as const;
	const separator = (i: number): string => (i > 0 ? ', ' : '');

	function send(): void {
		if (!sendable) return;
		if (approvalNeedsSecondClick(card) && !confirming) { confirming = true; return; }
		confirming = false;
		onDecide(card, 'approve');
	}
</script>

<!-- Each recipient: the display name, if any, then the address in an element of its own. The
     address is what the mail goes to; the name is only a label and can look like an address. -->
{#snippet addresses(list: ApprovalAddress[])}
	{#each list as a, i (i)}{separator(i)}<span class="inline-block max-w-full" data-recipient>{#if a.name !== undefined && a.name !== ''}<span class="text-text-muted" data-address-name>{visibleText(a.name)}</span> &lt;{/if}<span class="font-medium text-text" data-address>{visibleText(a.address, ADDRESS)}</span>{#if a.name !== undefined && a.name !== ''}&gt;{/if}</span>{/each}
{/snippet}

{#snippet moveToChat()}
	{#if movable}
		<button type="button" class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs text-text-muted disabled:opacity-50" disabled={busy} onclick={() => onMoveToChat?.(card)} data-action="move-to-chat">{t('approvals.move_to_chat')}</button>
	{/if}
{/snippet}

<article class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3" data-approval-id={card.id}>
	<header class="flex flex-wrap items-baseline gap-2">
		<h2 class="text-sm font-medium text-text min-w-0 break-words flex-1">
			{mail !== null ? visibleText(mail.subject) : t('approvals.mail_gone')}
		</h2>
		<span class="text-[10px] rounded px-1.5 py-0.5 bg-bg-muted text-text-muted" data-status={card.status}>{t(`approvals.status.${card.status}`)}</span>
		{#if card.held !== null}
			<span class="text-[10px] rounded px-1.5 py-0.5 bg-bg-muted text-text-muted">{t(`approvals.held.${card.held}`)}</span>
		{/if}
	</header>

	<p class="text-xs text-text-subtle">
		{tf('approvals.created', { date: when(card.createdAt) })}
		{#if card.status === 'pending'} · {tf('approvals.expires', { date: when(card.expiresAt) })}{/if}
		{#if card.origin !== null}
			· {t(card.origin.source === 'task' ? 'approvals.origin_task' : 'approvals.origin_workflow')}
			{#if card.origin.source === 'task' && card.origin.threadId}
				· <a class="text-accent-text hover:underline" href={`/app?thread=${encodeURIComponent(card.origin.threadId)}`}>{t('approvals.open_thread')}</a>
			{/if}
		{/if}
	</p>

	{#each card.setup as line}
		<p class="text-xs text-text-muted" data-setup={line.kind}>{tf(`approvals.setup.${line.kind}`, { name: visibleText(approvalSetupName(line.name, { t })) })}</p>
	{/each}

	{#if card.massSend}
		<p class="text-xs text-text" data-note="mass-send">{tf('approvals.mass_send', { count: String(recipientCount) })}</p>
	{/if}
	{#if card.recipientDiffers}
		<p class="text-xs text-text" data-note="recipient-differs">{t('approvals.recipient_differs')}</p>
	{/if}
	{#if card.replyToElsewhere}
		<p class="text-xs text-text-muted" data-note="reply-to">{tf('approvals.reply_to_elsewhere', {
			replyTo: card.replyToElsewhere.replyTo.map((a) => visibleText(a, ADDRESS)).join(', '),
			from: card.replyToElsewhere.from.map((a) => visibleText(a, ADDRESS)).join(', '),
		})}</p>
	{/if}
	{#if card.afterUntrusted}
		<p class="text-xs text-text-muted" data-note="after-untrusted">{t('approvals.after_untrusted')}</p>
	{/if}

	{#if mail !== null}
		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
			<dt class="text-text-subtle">{t('approvals.from')}</dt>
			<dd class="text-text break-all">{visibleText(mail.from, ADDRESS)}{#if mail.persona} ({visibleText(mail.persona)}){/if}</dd>
			<dt class="text-text-subtle">{t('approvals.to')}</dt>
			<dd class="text-text break-all" data-addresses="to">{@render addresses(mail.to)}</dd>
			{#if mail.cc.length > 0}
				<dt class="text-text-subtle">{t('approvals.cc')}</dt>
				<dd class="text-text break-all" data-addresses="cc">{@render addresses(mail.cc)}</dd>
			{/if}
			{#if mail.bcc.length > 0}
				<dt class="text-text-subtle">{t('approvals.bcc')}</dt>
				<dd class="text-text break-all" data-addresses="bcc">{@render addresses(mail.bcc)}</dd>
			{/if}
		</dl>
		{#if mail.original}
			<p class="text-xs text-text-subtle">{tf('approvals.reply_to_original', {
				from: visibleText(mail.original.from, ADDRESS), subject: visibleText(mail.original.subject), date: mail.original.date === '' ? '' : when(mail.original.date),
			})}</p>
		{/if}
		<!-- The whole mail, as it will go out: line breaks kept, scrolling after about twelve lines. -->
		<div class="whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.5] max-h-[calc(12*1.5em+1.5rem)] text-sm text-text bg-bg rounded-[var(--radius-sm)] border border-border p-3 overflow-y-auto" data-body>{visibleText(mail.bodyText)}</div>
	{/if}

	{#if actionable && !sendable}
		<div class="flex flex-wrap items-center gap-2">
			<p class="text-xs text-text-subtle flex-1 min-w-[12rem]" data-note="not-executable">{t('approvals.not_executable_note')}</p>
			<button type="button" class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs text-text-muted disabled:opacity-50" disabled={busy} onclick={() => onDecide(card, 'reject')} data-action="discard">{t('approvals.discard')}</button>
			{@render moveToChat()}
		</div>
	{:else if actionable}
		{#if confirming}
			<div class="flex flex-wrap items-center gap-2" data-confirm>
				<p class="text-xs text-text flex-1 min-w-[12rem]">{t('approvals.confirm_question')}</p>
				<button type="button" class="rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50" disabled={busy} onclick={send} data-action="confirm-send">{t('approvals.send_confirm')}</button>
				<button type="button" class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs text-text-muted" onclick={() => { confirming = false; }} data-action="cancel">{t('approvals.cancel')}</button>
			</div>
		{:else}
			<div class="flex flex-wrap gap-2">
				<button type="button" class="rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50" disabled={busy} onclick={send} data-action="send">{t('approvals.send')}</button>
				<button type="button" class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs text-text-muted disabled:opacity-50" disabled={busy} onclick={() => onDecide(card, 'reject')} data-action="discard">{t('approvals.discard')}</button>
				{@render moveToChat()}
			</div>
		{/if}
	{:else if card.status === 'pending' && card.checksum === undefined}
		<p class="text-xs text-text-subtle" data-note="read-only">{t('approvals.read_only')}</p>
	{/if}
</article>

