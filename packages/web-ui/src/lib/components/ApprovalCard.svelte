<script lang="ts">
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import { visibleText } from '../visible-text.js';
	import {
		approvalActionable, approvalAddressText, approvalNeedsSecondClick, approvalSetupName,
		type ApprovalAddress, type ApprovalCardData,
	} from './approvals.js';

	let { card, busy = false, onDecide }: {
		card: ApprovalCardData;
		busy?: boolean;
		onDecide: (card: ApprovalCardData, action: 'approve' | 'reject') => void;
	} = $props();

	/** The second click's step, open only for a mail that needs one. */
	let confirming = $state(false);

	const actionable = $derived(approvalActionable(card));
	const mail = $derived(card.mail);
	const recipientCount = $derived(
		mail === null ? 0 : new Set([...mail.to, ...mail.cc, ...mail.bcc].map((a) => a.address.trim().toLowerCase())).size,
	);

	function when(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
	}

	const list = (addresses: ApprovalAddress[]): string => addresses.map((a) => visibleText(approvalAddressText(a))).join(', ');

	function send(): void {
		if (approvalNeedsSecondClick(card) && !confirming) { confirming = true; return; }
		confirming = false;
		onDecide(card, 'approve');
	}
</script>

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
		<p class="text-xs text-text-muted" data-setup={line.kind}>{tf(`approvals.setup.${line.kind}`, { name: approvalSetupName(line.name, { t }) })}</p>
	{/each}

	{#if card.massSend}
		<p class="text-xs text-text" data-note="mass-send">{tf('approvals.mass_send', { count: String(recipientCount) })}</p>
	{/if}
	{#if card.recipientDiffers}
		<p class="text-xs text-text" data-note="recipient-differs">{t('approvals.recipient_differs')}</p>
	{/if}
	{#if card.replyToElsewhere}
		<p class="text-xs text-text-muted" data-note="reply-to">{tf('approvals.reply_to_elsewhere', {
			replyTo: visibleText(card.replyToElsewhere.replyTo.join(', ')),
			from: visibleText(card.replyToElsewhere.from.join(', ')),
		})}</p>
	{/if}
	{#if card.afterUntrusted}
		<p class="text-xs text-text-muted" data-note="after-untrusted">{t('approvals.after_untrusted')}</p>
	{/if}

	{#if mail !== null}
		<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
			<dt class="text-text-subtle">{t('approvals.from')}</dt>
			<dd class="text-text break-all">{visibleText(mail.from)}{#if mail.persona} ({visibleText(mail.persona)}){/if}</dd>
			<dt class="text-text-subtle">{t('approvals.to')}</dt>
			<dd class="text-text break-all">{list(mail.to)}</dd>
			{#if mail.cc.length > 0}
				<dt class="text-text-subtle">{t('approvals.cc')}</dt>
				<dd class="text-text break-all">{list(mail.cc)}</dd>
			{/if}
			{#if mail.bcc.length > 0}
				<dt class="text-text-subtle">{t('approvals.bcc')}</dt>
				<dd class="text-text break-all">{list(mail.bcc)}</dd>
			{/if}
		</dl>
		{#if mail.original}
			<p class="text-xs text-text-subtle">{tf('approvals.reply_to_original', {
				from: visibleText(mail.original.from), subject: visibleText(mail.original.subject), date: mail.original.date === '' ? '' : when(mail.original.date),
			})}</p>
		{/if}
		<!-- The whole mail, as it will go out: line breaks kept, scrolling after about twelve lines. -->
		<div class="whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.5] max-h-[calc(12*1.5em+1.5rem)] text-sm text-text bg-bg rounded-[var(--radius-sm)] border border-border p-3 overflow-y-auto" data-body>{visibleText(mail.bodyText)}</div>
	{/if}

	{#if actionable}
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
			</div>
		{/if}
	{:else if card.status === 'pending' && card.checksum === undefined}
		<p class="text-xs text-text-subtle" data-note="read-only">{t('approvals.read_only')}</p>
	{/if}
</article>

