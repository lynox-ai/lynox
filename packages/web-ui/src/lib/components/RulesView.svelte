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
	// accounts endpoint; future non-mail channels (when reintroduced) will
	// expose their own pseudo-account ids that advanced users could paste
	// by hand since /api/mail/accounts only knows mail.
	//
	// A rule the assistant proposed waits in its own section above the rules that apply; only the
	// owner confirms it, with what confirming does written next to the button. A link may open the
	// form prefilled (`?accountId=&kind=&value=`, the reading pane's "fixed rule from the sender").

	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import { t, tf } from '../i18n.svelte.js';
	import {
		confirmInboxRule,
		createInboxRule,
		deleteInboxRule,
		isRulePending,
		listInboxRules,
		type InboxRule,
		type InboxRuleAction,
		type InboxRuleBucket,
		type InboxRuleMatcherKind,
	} from '../api/inbox-rules.js';
	import { listMailAccounts, type MailAccountView } from '../api/mail-accounts.js';
	import { getApiBase } from '../config.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { isMandateSession, isOwnerSession, loadSettingsViewer } from '../stores/settings-viewer.svelte.js';
	import ViewerUnavailableNotice from './settings-readonly/ViewerUnavailableNotice.svelte';
	import OwnerOnlyNotice from './settings-readonly/OwnerOnlyNotice.svelte';
	import { isInboxAvailable, loadInboxCounts } from '../stores/inbox.svelte.js';

	type FormPreset = 'archive' | 'escalate' | 'silent';

	const PRESET_MAP: Record<FormPreset, { bucket: InboxRuleBucket; action: InboxRuleAction; labelKey: string }> = {
		archive: { bucket: 'auto_handled', action: 'archive', labelKey: 'inbox.rules_then_archive' },
		escalate: { bucket: 'requires_user', action: 'show', labelKey: 'inbox.rules_then_escalate' },
		silent: { bucket: 'auto_handled', action: 'mark_read', labelKey: 'inbox.rules_then_silent' },
	};

	/**
	 * Pure presentation: map a backend rule to its user-facing label. Falls
	 * through to "other" for combinations the form doesn't expose (e.g.
	 * `action: label`), so a rule created via the API surfaces honestly
	 * instead of being silently mislabelled as "Mark read & hide".
	 */
	function ruleDisplayLabelKey(rule: InboxRule): string {
		if (rule.bucket === 'requires_user' && rule.action === 'show') return 'inbox.rules_then_escalate';
		if (rule.bucket === 'auto_handled' && rule.action === 'archive') return 'inbox.rules_then_archive';
		if (rule.bucket === 'auto_handled' && rule.action === 'mark_read') return 'inbox.rules_then_silent';
		return 'inbox.rules_then_other';
	}

	function matchLabel(kind: InboxRuleMatcherKind): string {
		switch (kind) {
			case 'from': return t('inbox.rules_match_from');
			case 'subject_contains': return t('inbox.rules_match_subject');
			case 'list_id': return t('inbox.rules_match_list_id');
			case 'matches_description': return t('inbox.rules_match_description');
		}
	}

	/** The bucket a rule files into, by its name in the inbox. */
	function bucketLabel(bucket: InboxRuleBucket): string {
		return bucket === 'requires_user' ? t('inbox.zone_needs_you') : t('inbox.zone_handled');
	}

	/** A rule's name; unnamed, it is called by its value, as the server names it. */
	function ruleName(rule: InboxRule): string {
		return rule.name !== undefined && rule.name.length > 0 ? rule.name : rule.matcherValue;
	}

	/** What confirming does, said before the click: name, check, value and bucket. */
	function confirmText(rule: InboxRule): string {
		return tf('inbox.rules_confirm_text', {
			name: ruleName(rule),
			match: matchLabel(rule.matcherKind),
			value: rule.matcherValue,
			bucket: bucketLabel(rule.bucket),
		});
	}

	/** The inbox, filtered to the items a rule filed. */
	function ruleItemsHref(rule: InboxRule): string {
		const params = new URLSearchParams({ ruleId: rule.id, accountId: rule.accountId, zone: rule.bucket });
		return `/app/inbox?${params.toString()}`;
	}

	const MATCH_KINDS: ReadonlyArray<InboxRuleMatcherKind> = ['from', 'subject_contains', 'list_id', 'matches_description'];
	/** The kinds a link may prefill: the fixed ones, as the reading pane offers them. */
	const PREFILL_KINDS: ReadonlyArray<InboxRuleMatcherKind> = ['from', 'subject_contains', 'list_id'];
	const NAME_MAX = 80;
	const DESCRIPTION_MAX = 300;

	let accounts = $state<MailAccountView[]>([]);
	let accountsLoading = $state(true);
	let rules = $state<InboxRule[]>([]);
	let rulesLoading = $state(false);
	// A waiting proposal has its own section above the rules that apply.
	const proposals = $derived(rules.filter((r) => isRulePending(r)));
	const confirmedRules = $derived(rules.filter((r) => !isRulePending(r)));
	let confirmingId = $state<string | null>(null);

	// Two-state split for the account picker: `inputAccountId` mirrors the
	// `<input>` (every keystroke), `appliedAccountId` drives the rules load
	// after a 250 ms debounce. Without this the $effect would spam
	// /api/inbox/rules on every key.
	let inputAccountId = $state<string>('');
	let appliedAccountId = $state<string>('');
	let applyTimer: ReturnType<typeof setTimeout> | null = null;

	let countsLoaded = $state(false);
	let inboxOk = $state(true);

	// Form state
	let formOpen = $state(false);
	let formMatchKind = $state<InboxRuleMatcherKind>('from');
	let formMatchValue = $state('');
	let formName = $state('');
	let formPreset = $state<FormPreset>('archive');
	let formSubmitting = $state(false);
	// The server refused the name or description: it holds a label such as "R1".
	let formRuleLabelError = $state(false);
	let pendingDeleteId = $state<string | null>(null);
	const formIsDescription = $derived(formMatchKind === 'matches_description');
	// A description rule that files mail as handled applies only when the classifier agrees.
	const formHandledHint = $derived(
		formIsDescription && PRESET_MAP[formPreset].bucket === 'auto_handled'
			? tf('inbox.rules_description_handled_hint', { then: t(PRESET_MAP[formPreset].labelKey) })
			: null,
	);

	// A link may open the form prefilled ("fixed rule from the sender"): account, kind and value.
	const prefill = (() => {
		const params = get(page).url.searchParams;
		const kind = params.get('kind');
		const value = params.get('value')?.trim() ?? '';
		return {
			accountId: params.get('accountId')?.trim() ?? '',
			kind: PREFILL_KINDS.find((k) => k === kind) ?? null,
			value,
		};
	})();

	onMount(async () => {
		// Counts probe + mail-account list are independent — parallelise to
		// shave one RTT off the cold mount.
		const [, list] = await Promise.all([loadInboxCounts(), listMailAccounts(getApiBase())]);
		inboxOk = isInboxAvailable();
		countsLoaded = true;
		accountsLoading = false;
		if (!inboxOk) return;
		if (list === null) {
			addToast(t('inbox.rules_error_load'), 'error');
			return;
		}
		accounts = list;
		// The account a link named; else the default account, so the user lands on something
		// useful when they only have one mail account configured.
		const linked = prefill.accountId.length > 0 ? prefill.accountId : null;
		const defaultAcc = list.find((a) => a.isDefault) ?? list[0];
		const chosen = linked ?? defaultAcc?.id;
		if (chosen !== undefined) {
			inputAccountId = chosen;
			appliedAccountId = chosen;
		}
		if (prefill.kind !== null && prefill.value.length > 0) {
			openForm();
			formMatchKind = prefill.kind;
			formMatchValue = prefill.value;
		}
	});

	// Whose session asks: changing the rules is the owner's, so a mandate's session reads them only.
	$effect(() => { void loadSettingsViewer(); });

	onDestroy(() => {
		if (applyTimer !== null) clearTimeout(applyTimer);
	});

	function onAccountInput(event: Event): void {
		const value = (event.target as HTMLInputElement).value;
		inputAccountId = value;
		if (applyTimer !== null) clearTimeout(applyTimer);
		// If the value matches a known account id exactly (e.g. datalist
		// pick), apply immediately so the user does not wait for the
		// debounce — datalist selections feel like a deliberate choice.
		if (accounts.some((a) => a.id === value)) {
			appliedAccountId = value;
			return;
		}
		applyTimer = setTimeout(() => {
			appliedAccountId = inputAccountId;
		}, 250);
	}

	$effect(() => {
		// Cancel any pending delete confirmation when the active account
		// changes — the confirmation would otherwise attach to a rule from
		// the previous account's list.
		appliedAccountId;
		pendingDeleteId = null;
	});

	$effect(() => {
		if (appliedAccountId.trim().length > 0 && countsLoaded && inboxOk) {
			void reloadRules();
		} else {
			rules = [];
		}
	});

	async function reloadRules(): Promise<void> {
		const target = appliedAccountId.trim();
		if (target.length === 0) return;
		rulesLoading = true;
		const list = await listInboxRules(getApiBase(), target);
		// Drop the result if the user picked a different account while we
		// awaited — clear the loading flag first so the stale call does not
		// leave the spinner stuck across an in-flight switch.
		if (appliedAccountId.trim() !== target) {
			rulesLoading = false;
			return;
		}
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
		formName = '';
		formPreset = 'archive';
		formRuleLabelError = false;
		formOpen = true;
	}

	function closeForm(): void {
		formOpen = false;
		formSubmitting = false;
		formRuleLabelError = false;
	}

	async function submitForm(): Promise<void> {
		const accountId = appliedAccountId.trim();
		const value = formMatchValue.trim();
		if (accountId.length === 0 || value.length === 0) return;
		formSubmitting = true;
		formRuleLabelError = false;
		const preset = PRESET_MAP[formPreset];
		const name = formName.trim();
		const result = await createInboxRule(getApiBase(), {
			accountId,
			matcherKind: formMatchKind,
			matcherValue: value,
			bucket: preset.bucket,
			action: preset.action,
			source: 'on_demand',
			...(name.length > 0 ? { name } : {}),
		});
		formSubmitting = false;
		if (!result.ok) {
			// A label such as "R1" is said in the form, where it can be rephrased.
			if (result.namesRuleLabel) formRuleLabelError = true;
			else addToast(t('inbox.rules_error_create'), 'error');
			return;
		}
		closeForm();
		await reloadRules();
	}

	async function confirmProposal(id: string): Promise<void> {
		if (confirmingId !== null) return;
		confirmingId = id;
		const ok = await confirmInboxRule(getApiBase(), id);
		confirmingId = null;
		if (!ok) {
			addToast(t('inbox.rules_error_confirm'), 'error');
			return;
		}
		await Promise.all([reloadRules(), loadInboxCounts()]);
	}

	async function confirmDelete(id: string): Promise<void> {
		const ok = await deleteInboxRule(getApiBase(), id);
		if (!ok) {
			// Keep the confirmation pinned so the user can retry the same
			// button instead of having to re-target the row.
			addToast(t('inbox.rules_error_delete'), 'error');
			return;
		}
		pendingDeleteId = null;
		// Optimistic: filter locally, then reconcile from server.
		const wasPending = rules.some((r) => r.id === id && isRulePending(r));
		rules = rules.filter((r) => r.id !== id);
		await Promise.all([reloadRules(), ...(wasPending ? [loadInboxCounts()] : [])]);
	}
</script>

{#snippet deleteControl(rule: InboxRule)}
	{#if !isOwnerSession()}
		<!-- No delete until the server said this is the owner's session: the rule is the owner's. -->
	{:else if pendingDeleteId === rule.id}
		<div class="flex items-center gap-1 shrink-0">
			<button
				type="button"
				onclick={() => void confirmDelete(rule.id)}
				class="rounded-[var(--radius-sm)] bg-danger/20 text-danger hover:bg-danger/30 px-3 py-1.5 text-[11px] min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
			>{t('inbox.rules_delete')}</button>
			<button
				type="button"
				onclick={() => (pendingDeleteId = null)}
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
			>{t('inbox.rules_cancel')}</button>
		</div>
	{:else}
		<button
			type="button"
			onclick={() => (pendingDeleteId = rule.id)}
			aria-label={t('inbox.rules_delete')}
			class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-danger hover:border-danger/40 min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
		>×</button>
	{/if}
{/snippet}

<div
	class="p-4 sm:p-6 max-w-3xl mx-auto pb-[max(1rem,env(safe-area-inset-bottom))]"
	role="region"
	aria-label={t('inbox.rules_title')}
>
	<ViewerUnavailableNotice />
	<div class="flex items-center justify-between flex-wrap gap-y-2 mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('inbox.rules_title')}</h1>
		<a href="/app/inbox" class="text-[11px] text-text-subtle hover:text-text-muted font-mono py-1">← {t('inbox.rules_back')}</a>
	</div>

	{#if countsLoaded && !inboxOk}
		<div class="rounded-[var(--radius-md)] bg-bg-subtle border border-border px-4 py-6 text-sm text-text-muted">
			{t('inbox.rules_unavailable')}
		</div>
	{:else}
		<p class="text-[12px] text-text-muted mb-4">{t('inbox.rules_intro')}</p>
		{#if isMandateSession()}
			<!-- A mandate's session: adding and deleting a rule are the owner's. -->
			<div class="mb-4"><OwnerOnlyNotice /></div>
		{/if}

		<label class="block mb-4">
			<span class="text-[11px] text-text-subtle uppercase tracking-widest">{t('inbox.rules_account_label')}</span>
			{#if accountsLoading}
				<p class="text-text-subtle text-sm mt-1">{t('inbox.rules_account_loading')}</p>
			{:else}
				<input
					type="text"
					list="rules-account-list"
					value={inputAccountId}
					oninput={onAccountInput}
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

		{#if appliedAccountId.trim().length === 0}
			<p class="text-text-subtle text-sm">{t('inbox.rules_pick_account_first')}</p>
		{:else if rulesLoading}
			<p class="text-text-subtle text-sm">{t('inbox.rules_loading')}</p>
		{:else}
			{#if proposals.length > 0}
				<!-- Proposals wait above the rules that apply: none of them applies until confirmed. -->
				<section class="mb-6" aria-labelledby="rules-proposals-title" data-testid="rules-proposals">
					<h2 id="rules-proposals-title" class="text-[11px] text-text-subtle uppercase tracking-widest mb-1">{t('inbox.rules_proposals_title')}</h2>
					<p class="text-[12px] text-text-muted mb-2">{t('inbox.rules_proposals_intro')}</p>
					{#if !isOwnerSession()}
						<p class="text-[12px] text-text-muted mb-2" data-testid="rules-proposals-mandate">{t('inbox.rules_proposals_mandate')}</p>
					{/if}
					<ul class="space-y-2" role="list">
						{#each proposals as rule (rule.id)}
							<li id="rule-{rule.id}" class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 px-4 py-3" data-testid="rules-proposal">
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0 flex-1">
										{#if rule.source === 'agent'}
											<span class="inline-block rounded-full bg-accent/15 text-accent-text px-2 py-0.5 text-[10px] mb-1" data-testid="rules-proposal-badge">{t('inbox.rules_proposal_badge')}</span>
										{/if}
										<p class="text-sm text-text font-medium break-words">{ruleName(rule)}</p>
										<p class="text-sm text-text mt-1">
											<span class="text-text-muted">{matchLabel(rule.matcherKind)}:</span>
											<span class="font-mono break-all">{rule.matcherValue}</span>
										</p>
										<p class="text-[11px] text-text-subtle mt-1">→ {bucketLabel(rule.bucket)}</p>
									</div>
									{@render deleteControl(rule)}
								</div>
								{#if isOwnerSession()}
									<!-- What confirming does stands next to the button, before the click. -->
									<div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-accent/20 pt-3">
										<p class="text-[12px] text-text min-w-0 flex-1" data-testid="rules-confirm-text">{confirmText(rule)}</p>
										<button
											type="button"
											onclick={() => void confirmProposal(rule.id)}
											disabled={confirmingId !== null}
											class="shrink-0 rounded-[var(--radius-sm)] bg-accent text-white hover:bg-accent-hover disabled:opacity-50 px-3 py-1.5 text-[12px] min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
										>{t('inbox.rules_confirm')}</button>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<div class="mb-3 flex items-center justify-between">
				<span class="text-[11px] text-text-subtle uppercase tracking-widest">
					{confirmedRules.length} {confirmedRules.length === 1 ? '·' : ''}
				</span>
				{#if !formOpen && isOwnerSession()}
					<button
						type="button"
						onclick={openForm}
						class="rounded-[var(--radius-sm)] bg-accent/15 text-accent-text hover:bg-accent/25 px-3 py-1.5 text-[12px] min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
					>{t('inbox.rules_add')}</button>
				{/if}
			</div>

			{#if formOpen && isOwnerSession()}
				<form
					onsubmit={(e) => { e.preventDefault(); void submitForm(); }}
					class="mb-4 rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-4 space-y-3"
				>
					<label class="block">
						<span class="text-[11px] text-text-subtle uppercase tracking-widest">{t('inbox.rules_name_label')}</span>
						<input
							type="text"
							bind:value={formName}
							maxlength={NAME_MAX}
							placeholder={t('inbox.rules_name_placeholder')}
							class="mt-1 w-full bg-bg-subtle border border-border rounded-[var(--radius-sm)] px-3 py-2 text-sm text-text placeholder:text-text-subtle"
						/>
					</label>

					<fieldset>
						<legend class="text-[11px] text-text-subtle uppercase tracking-widest mb-2">{t('inbox.rules_match_label')}</legend>
						<div class="flex flex-wrap gap-3 mb-2">
							{#each MATCH_KINDS as kind (kind)}
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
							maxlength={formIsDescription ? DESCRIPTION_MAX : undefined}
							placeholder={formIsDescription ? t('inbox.rules_description_placeholder') : t('inbox.rules_match_value_placeholder')}
							class="w-full bg-bg-subtle border border-border rounded-[var(--radius-sm)] px-3 py-2 text-sm text-text placeholder:text-text-subtle"
						/>
						{#if formIsDescription}
							<div class="mt-2 space-y-1 text-[11px] text-text-muted" data-testid="rules-description-hints">
								<p>{t('inbox.rules_description_hint')}</p>
								<p>{t('inbox.rules_description_overlap')}</p>
								<p>{t('inbox.rules_description_out_of_office')}</p>
							</div>
						{/if}
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
						{#if formHandledHint !== null}
							<p class="mt-2 text-[11px] text-text-muted" data-testid="rules-handled-hint">{formHandledHint}</p>
						{/if}
					</fieldset>

					{#if formRuleLabelError}
						<p class="rounded-[var(--radius-sm)] border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert" data-testid="rules-label-error">{t('inbox.rules_error_rule_label')}</p>
					{/if}

					<div class="flex items-center justify-end gap-2 pt-1 flex-wrap">
						<button
							type="button"
							onclick={closeForm}
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[12px] text-text-muted hover:text-text min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
						>{t('inbox.rules_cancel')}</button>
						<button
							type="submit"
							disabled={formSubmitting || formMatchValue.trim().length === 0}
							class="rounded-[var(--radius-sm)] bg-accent text-white hover:bg-accent-hover disabled:opacity-50 px-3 py-1.5 text-[12px] min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
						>{t('inbox.rules_save')}</button>
					</div>
				</form>
			{/if}

			{#if confirmedRules.length === 0}
				<p class="text-text-subtle text-sm">{t('inbox.rules_empty')}</p>
			{:else}
				<ul class="space-y-2" role="list">
					{#each confirmedRules as rule (rule.id)}
						<li id="rule-{rule.id}" class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									{#if rule.name !== undefined && rule.name.length > 0}
										<p class="text-sm text-text font-medium break-words mb-0.5">{rule.name}</p>
									{/if}
									<p class="text-sm text-text">
										<span class="text-text-muted">{matchLabel(rule.matcherKind)}:</span>
										<span class="font-mono break-all">{rule.matcherValue}</span>
									</p>
									<p class="text-[11px] text-text-subtle mt-1">
										→ {t(ruleDisplayLabelKey(rule))}
									</p>
									<a
										href={ruleItemsHref(rule)}
										class="inline-block mt-1 text-[11px] text-accent-text hover:underline py-1"
										data-testid="rules-items-link"
									>{t('inbox.rules_items_link')}</a>
								</div>
								{@render deleteControl(rule)}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</div>
