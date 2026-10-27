<script lang="ts">
	import { t, tf } from '../i18n.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import { getApprovalsViewer, setApprovalsOff, setApprovalsPending } from '../stores/approvals.svelte.js';
	import ApprovalCard from './ApprovalCard.svelte';
	import {
		approvalCutNotice, approvalDecideErrorKey, approvalRefusalReloads, approvalRetentionKey,
		type ApprovalCardData, type ApprovalList,
	} from './approvals.js';

	let view = $state<'open' | 'all'>('open');
	let list = $state<ApprovalList | null>(null);
	let loading = $state(false);
	let loadFailed = $state(false);
	/** The queue is off on this instance: the list route answers 404. */
	let off = $state(false);
	/** The id of the entry whose decision is on its way. */
	let deciding = $state<string | null>(null);
	/** What the last decision came to, as a sentence of this page's own. */
	let notice = $state<{ text: string; kind: 'ok' | 'error' } | null>(null);

	const cut = $derived(list === null ? null : approvalCutNotice(view, list, { t, tf }));

	async function load(asked: 'open' | 'all' = view): Promise<void> {
		loading = true;
		try {
			const res = await fetch(`${getApiBase()}/approvals?view=${asked}`);
			if (res.status === 404) {
				if (asked !== view) return;
				off = true;
				list = null;
				loadFailed = false;
				setApprovalsOff();
				return;
			}
			if (!res.ok) throw new Error(`list answered ${res.status}`);
			const body = (await res.json()) as ApprovalList;
			if (asked !== view) return;
			off = false;
			const viewer = body.viewer === 'owner' || body.viewer === 'mandate' ? body.viewer : 'none';
			const retentionDays = typeof body.retentionDays === 'number' && Number.isInteger(body.retentionDays) && body.retentionDays > 0 ? body.retentionDays : undefined;
			const unclearStays = typeof body.unclearStays === 'boolean' ? body.unclearStays : undefined;
			list = { entries: Array.isArray(body.entries) ? body.entries : [], pending: typeof body.pending === 'number' ? body.pending : 0, viewer, retentionDays, unclearStays };
			// The badge counts for the session the count poll last named; a list read under another
			// login in this tab leaves it for the next poll.
			if (list.viewer === getApprovalsViewer()) setApprovalsPending(list.pending);
			loadFailed = false;
		} catch {
			if (asked === view) loadFailed = true;
		} finally {
			if (asked === view) loading = false;
		}
	}

	function show(next: 'open' | 'all'): void {
		if (view === next) return;
		view = next;
		list = null;
		notice = null;
	}

	const DONE: Record<'approve' | 'reject' | 'clear_unknown', string> = {
		approve: 'approvals.sent', reject: 'approvals.discarded', clear_unknown: 'approvals.closed',
	};

	async function decide(card: ApprovalCardData, action: 'approve' | 'reject' | 'clear_unknown'): Promise<void> {
		if (deciding !== null) return;
		deciding = card.id;
		notice = null;
		try {
			const body = action === 'approve' ? { action, checksum: card.checksum } : { action };
			const res = await fetch(`${getApiBase()}/approvals/${encodeURIComponent(card.id)}/decide`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (res.ok) {
				notice = { text: t(DONE[action]), kind: 'ok' };
				await load();
				return;
			}
			let code: unknown;
			try { code = ((await res.json()) as { code?: unknown }).code; } catch { code = undefined; }
			if (res.status === 404 && code === undefined) {
				// The queue was turned off (a 404 with no code): the list read says so instead of an
				// error. A mail that is gone answers 404 too, with its own code, and keeps its sentence.
				await load();
				return;
			}
			notice = { text: t(approvalDecideErrorKey(code)), kind: 'error' };
			if (approvalRefusalReloads(code)) await load();
		} catch {
			notice = { text: t('approvals.error.other'), kind: 'error' };
		} finally {
			deciding = null;
		}
	}

	// Reads the list for the tab on screen, again whenever the tab changes.
	$effect(() => { void load(view); });
</script>

<div class="mx-auto w-full max-w-3xl px-4 py-6 space-y-4">
	<header class="space-y-1">
		<h1 class="text-lg font-semibold text-text">{t('approvals.title')}</h1>
		<p class="text-sm text-text-muted">{t('approvals.intro')}</p>
	</header>

	{#if off}
		<p class="text-sm text-text-muted" data-off>{t('approvals.off')}</p>
	{:else}
		<div class="flex gap-1 border-b border-border" role="tablist">
			<button type="button" role="tab" aria-selected={view === 'open'} data-tab="open"
				class="px-3 py-2 text-sm border-b-2 -mb-px {view === 'open' ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'}"
				onclick={() => show('open')}>{t('approvals.tab_open')}</button>
			<button type="button" role="tab" aria-selected={view === 'all'} data-tab="all"
				class="px-3 py-2 text-sm border-b-2 -mb-px {view === 'all' ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'}"
				onclick={() => show('all')}>{t('approvals.tab_all')}</button>
		</div>

		{#if notice !== null}
			<p class="text-sm {notice.kind === 'error' ? 'text-danger' : 'text-text-muted'}" role={notice.kind === 'error' ? 'alert' : 'status'} data-notice={notice.kind}>{notice.text}</p>
		{/if}

		{#if view === 'all' && list !== null && list.retentionDays !== undefined}
			<p class="text-xs text-text-subtle" data-retention>{tf(approvalRetentionKey(list.viewer ?? 'none', list.unclearStays), { days: String(list.retentionDays) })}</p>
		{/if}

		{#if list === null}
			{#if loadFailed}
				<p class="text-sm text-danger" role="alert">{t('approvals.load_failed')}</p>
			{:else if loading}
				<p class="text-sm text-text-muted">{t('approvals.loading')}</p>
			{/if}
		{:else}
			{#if list.entries.length === 0}
				<p class="text-sm text-text-muted" data-empty>{t(view === 'open' ? 'approvals.empty_open' : 'approvals.empty_all')}</p>
			{:else}
				{#if cut !== null}
					<p class="text-xs text-text-subtle" data-cut>{cut}</p>
				{/if}
				<div class="space-y-3">
					{#each list.entries as card (card.id)}
						<ApprovalCard {card} viewer={list.viewer ?? 'none'} busy={deciding !== null} onDecide={(c, a) => { void decide(c, a); }} />
					{/each}
				</div>
			{/if}
			{#if loadFailed}
				<p class="text-xs text-danger" role="alert">{t('approvals.load_failed')}</p>
			{/if}
		{/if}
	{/if}
</div>
