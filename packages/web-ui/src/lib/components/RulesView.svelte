<script lang="ts">
	// === Inbox rules management ===
	//
	// List + create + delete of `inbox_rules` rows for one account at a
	// time. Surfaces a small set of user-facing "then" presets that hide
	// the underlying bucket/action combo (the engine has more
	// combinations than the UI exposes today — extra ones can be added
	// here without touching the backend).
	//
	// Account picker is a native `<input list>` populated from the mail
	// accounts endpoint; advanced users can paste a `whatsapp:<id>`
	// pseudo-account by hand since /api/mail/accounts only knows mail.

	import { onMount } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import {
		createInboxRule,
		deleteInboxRule,
		listInboxRules,
		type InboxRule,
		type InboxRuleAction,
		type InboxRuleBucket,
		type InboxRuleMatcherKind,
	} from '../api/inbox-rules.js';
	import { listMailAccounts, type MailAccountSummary } from '../api/mail-accounts.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { isInboxAvailable, loadInboxCounts } from '../stores/inbox.svelte.js';

	type ThenPreset = 'archive' | 'escalate' | 'silent';

	const PRESET_MAP: Record<ThenPreset, { bucket: InboxRuleBucket; action: InboxRuleAction; labelKey: string }> = {
		archive: { bucket: 'auto_handled', action: 'archive', labelKey: 'inbox.rules_then_archive' },
		escalate: { bucket: 'requires_user', action: 'show', labelKey: 'inbox.rules_then_escalate' },
		silent: { bucket: 'auto_handled', action: 'mark_read', labelKey: 'inbox.rules_then_silent' },
	};

	function ruleToPreset(rule: InboxRule): ThenPreset {
		if (rule.bucket === 'requires_user') return 'escalate';
		if (rule.action === 'archive') return 'archive';
		return 'silent';
	}

	function matchLabel(kind: InboxRuleMatcherKind): string {
		switch (kind) {
			case 'from': return t('inbox.rules_match_from');
			case 'subject_contains': return t('inbox.rules_match_subject');
			case 'list_id': return t('inbox.rules_match_list_id');
		}
	}

	let accounts = $state<MailAccountSummary[]>([]);
	let accountsLoading = $state(true);
	let rules = $state<InboxRule[]>([]);
	let rulesLoading = $state(false);

	let selectedAccountId = $state<string>('');
	let countsLoaded = $state(false);
	let inboxOk = $state(true);

	// Form state
	let formOpen = $state(false);
	let formMatchKind = $state<InboxRuleMatcherKind>('from');
	let formMatchValue = $state('');
	let formPreset = $state<ThenPreset>('archive');
	let formSubmitting = $state(false);
	let pendingDeleteId = $state<string | null>(null);

	onMount(async () => {
		// Probe inbox availability up front so the unavailable state can
		// short-circuit the rest of the loading work.
		await loadInboxCounts();
		inboxOk = isInboxAvailable();
		countsLoaded = true;
		if (!inboxOk) {
			accountsLoading = false;
			return;
		}
		const list = await listMailAccounts();
		accountsLoading = false;
		if (list === null) {
			addToast(t('inbox.rules_error_load'), 'error');
			return;
		}
		accounts = list;
		// Pre-select the default account so the user lands on something
		// useful when they only have one mail account configured.
		const defaultAcc = list.find((a) => a.isDefault) ?? list[0];
		if (defaultAcc) {
			selectedAccountId = defaultAcc.id;
		}
	});

	$effect(() => {
		if (selectedAccountId.trim().length > 0 && countsLoaded && inboxOk) {
			void reloadRules();
		} else {
			rules = [];
		}
	});

	async function reloadRules(): Promise<void> {
		const target = selectedAccountId.trim();
		if (target.length === 0) return;
		rulesLoading = true;
		const list = await listInboxRules(target);
		// Drop the result if the user picked a different account while we
		// awaited — the latest selection wins.
		if (selectedAccountId.trim() !== target) return;
		rulesLoading = false;
		if (list === null) {
			addToast(t('inbox.rules_error_load'), 'error');
			rules = [];
			return;
		}
		rules = list;
	}

	function accountLabel(id: string): string {
		const a = accounts.find((x) => x.id === id);
		if (!a) return id;
		return a.displayName ? `${a.displayName} <${a.address}>` : a.address;
	}

	function openForm(): void {
		formMatchKind = 'from';
		formMatchValue = '';
		formPreset = 'archive';
		formOpen = true;
	}

	function closeForm(): void {
		formOpen = false;
		formSubmitting = false;
	}

	async function submitForm(): Promise<void> {
		const accountId = selectedAccountId.trim();
		const value = formMatchValue.trim();
		if (accountId.length === 0 || value.length === 0) return;
		formSubmitting = true;
		const preset = PRESET_MAP[formPreset];
		const ok = await createInboxRule({
			accountId,
			matcherKind: formMatchKind,
			matcherValue: value,
			bucket: preset.bucket,
			action: preset.action,
			source: 'on_demand',
		});
		formSubmitting = false;
		if (ok === null) {
			addToast(t('inbox.rules_error_create'), 'error');
			return;
		}
		closeForm();
		await reloadRules();
	}

	async function confirmDelete(id: string): Promise<void> {
		const ok = await deleteInboxRule(id);
		pendingDeleteId = null;
		if (!ok) {
			addToast(t('inbox.rules_error_delete'), 'error');
			return;
		}
		// Optimistic: filter locally, then reconcile from server.
		rules = rules.filter((r) => r.id !== id);
		await reloadRules();
	}
</script>

<div class="p-6 max-w-3xl mx-auto" role="region" aria-label={t('inbox.rules_title')}>
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('inbox.rules_title')}</h1>
		<a href="/app/inbox" class="text-[11px] text-text-subtle hover:text-text-muted font-mono">← {t('inbox.rules_back')}</a>
	</div>

	{#if countsLoaded && !inboxOk}
		<div class="rounded-[var(--radius-md)] bg-bg-subtle border border-border px-4 py-6 text-sm text-text-muted">
			{t('inbox.rules_unavailable')}
		</div>
	{:else}
		<p class="text-[12px] text-text-muted mb-4">{t('inbox.rules_intro')}</p>

		<label class="block mb-4">
			<span class="text-[11px] text-text-subtle uppercase tracking-widest">{t('inbox.rules_account_label')}</span>
			{#if accountsLoading}
				<p class="text-text-subtle text-sm mt-1">{t('inbox.rules_account_loading')}</p>
			{:else}
				<input
					type="text"
					list="rules-account-list"
					bind:value={selectedAccountId}
					placeholder={t('inbox.rules_account_placeholder')}
					class="mt-1 w-full bg-bg-subtle border border-border rounded-[var(--radius-sm)] px-3 py-2 text-sm text-text placeholder:text-text-subtle"
				/>
				<datalist id="rules-account-list">
					{#each accounts as account (account.id)}
						<option value={account.id}>{accountLabel(account.id)}</option>
					{/each}
				</datalist>
			{/if}
		</label>

		{#if selectedAccountId.trim().length === 0}
			<p class="text-text-subtle text-sm">{t('inbox.rules_pick_account_first')}</p>
		{:else if rulesLoading}
			<p class="text-text-subtle text-sm">{t('inbox.rules_loading')}</p>
		{:else}
			<div class="mb-3 flex items-center justify-between">
				<span class="text-[11px] text-text-subtle uppercase tracking-widest">
					{rules.length} {rules.length === 1 ? '·' : ''}
				</span>
				{#if !formOpen}
					<button
						type="button"
						onclick={openForm}
						class="rounded-[var(--radius-sm)] bg-accent/15 text-accent-text hover:bg-accent/25 px-3 py-1.5 text-[12px]"
					>{t('inbox.rules_add')}</button>
				{/if}
			</div>

			{#if formOpen}
				<form
					onsubmit={(e) => { e.preventDefault(); void submitForm(); }}
					class="mb-4 rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-4 space-y-3"
				>
					<fieldset>
						<legend class="text-[11px] text-text-subtle uppercase tracking-widest mb-2">{t('inbox.rules_match_label')}</legend>
						<div class="flex flex-wrap gap-3 mb-2">
							{#each ['from', 'subject_contains', 'list_id'] as const as kind (kind)}
								<label class="flex items-center gap-2 text-sm text-text">
									<input
										type="radio"
										name="rule-match-kind"
										value={kind}
										checked={formMatchKind === kind}
										onchange={() => (formMatchKind = kind)}
									/>
									<span>{matchLabel(kind)}</span>
								</label>
							{/each}
						</div>
						<input
							type="text"
							bind:value={formMatchValue}
							required
							placeholder={t('inbox.rules_match_value_placeholder')}
							class="w-full bg-bg-subtle border border-border rounded-[var(--radius-sm)] px-3 py-2 text-sm text-text placeholder:text-text-subtle"
						/>
					</fieldset>

					<fieldset>
						<legend class="text-[11px] text-text-subtle uppercase tracking-widest mb-2">{t('inbox.rules_then_label')}</legend>
						<div class="space-y-1">
							{#each ['archive', 'escalate', 'silent'] as const as preset (preset)}
								<label class="flex items-center gap-2 text-sm text-text">
									<input
										type="radio"
										name="rule-then-preset"
										value={preset}
										checked={formPreset === preset}
										onchange={() => (formPreset = preset)}
									/>
									<span>{t(PRESET_MAP[preset].labelKey)}</span>
								</label>
							{/each}
						</div>
					</fieldset>

					<div class="flex items-center justify-end gap-2 pt-1">
						<button
							type="button"
							onclick={closeForm}
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[12px] text-text-muted hover:text-text"
						>{t('inbox.rules_cancel')}</button>
						<button
							type="submit"
							disabled={formSubmitting || formMatchValue.trim().length === 0}
							class="rounded-[var(--radius-sm)] bg-accent text-white hover:bg-accent-hover disabled:opacity-50 px-3 py-1.5 text-[12px]"
						>{t('inbox.rules_save')}</button>
					</div>
				</form>
			{/if}

			{#if rules.length === 0}
				<p class="text-text-subtle text-sm">{t('inbox.rules_empty')}</p>
			{:else}
				<ul class="space-y-2" role="list">
					{#each rules as rule (rule.id)}
						<li class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									<p class="text-sm text-text">
										<span class="text-text-muted">{matchLabel(rule.matcherKind)}:</span>
										<span class="font-mono break-all">{rule.matcherValue}</span>
									</p>
									<p class="text-[11px] text-text-subtle mt-1">
										→ {t(PRESET_MAP[ruleToPreset(rule)].labelKey)}
									</p>
								</div>
								{#if pendingDeleteId === rule.id}
									<div class="flex items-center gap-1 shrink-0">
										<button
											type="button"
											onclick={() => void confirmDelete(rule.id)}
											class="rounded-[var(--radius-sm)] bg-danger/20 text-danger hover:bg-danger/30 px-2 py-1 text-[11px]"
										>{t('inbox.rules_delete')}</button>
										<button
											type="button"
											onclick={() => (pendingDeleteId = null)}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-text"
										>{t('inbox.rules_cancel')}</button>
									</div>
								{:else}
									<button
										type="button"
										onclick={() => (pendingDeleteId = rule.id)}
										aria-label={t('inbox.rules_delete')}
										class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-danger hover:border-danger/40"
									>×</button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</div>
