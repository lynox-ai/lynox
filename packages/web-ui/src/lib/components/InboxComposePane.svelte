<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import { listMailAccounts, type MailAccountView } from '../api/mail-accounts.js';
	import { getApiBase } from '../config.svelte.js';
	import {
		closeCompose,
		getComposeDraft,
		isComposeSending,
		sendCompose,
		updateComposeDraft,
	} from '../stores/inbox.svelte.js';

	const draft = $derived(getComposeDraft());
	const sending = $derived(isComposeSending());

	let accounts = $state<MailAccountView[]>([]);
	let selectedAccountId = $state<string | null>(null);
	let showCcBcc = $state(false);

	onMount(async () => {
		const list = await listMailAccounts(getApiBase());
		if (list !== null) {
			accounts = list;
			selectedAccountId = list.find((a) => a.isDefault)?.id ?? list[0]?.id ?? null;
		}
	});

	async function onSubmit(e: Event): Promise<void> {
		e.preventDefault();
		if (selectedAccountId === null) return;
		await sendCompose(selectedAccountId);
	}
</script>

<div
	class="fixed bottom-0 right-4 z-40 w-full max-w-2xl rounded-t-[var(--radius-md)] border border-border bg-bg shadow-xl"
	role="dialog"
	aria-label={t('inbox.compose_title')}
>
	<form onsubmit={onSubmit}>
		<header class="flex items-center justify-between border-b border-border px-4 py-2">
			<h2 class="text-sm font-medium text-text">{t('inbox.compose_title')}</h2>
			<button
				type="button"
				class="text-[11px] text-text-subtle hover:text-text px-2"
				onclick={() => closeCompose()}
				aria-label={t('inbox.compose_cancel')}
			>×</button>
		</header>

		<div class="space-y-2 p-4">
			{#if accounts.length > 1}
				<label class="block text-[11px] text-text-subtle">
					{t('inbox.compose_account')}
					<select
						class="mt-0.5 w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-sm text-text"
						value={selectedAccountId}
						onchange={(e) => (selectedAccountId = (e.target as HTMLSelectElement).value)}
					>
						{#each accounts as a (a.id)}
							<option value={a.id}>{a.displayName} &lt;{a.address}&gt;</option>
						{/each}
					</select>
				</label>
			{/if}

			<label class="block text-[11px] text-text-subtle">
				{t('inbox.compose_to')}
				<input
					type="text"
					value={draft.to}
					oninput={(e) => updateComposeDraft({ to: (e.target as HTMLInputElement).value })}
					class="mt-0.5 w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-sm text-text"
					required
				/>
			</label>

			{#if showCcBcc}
				<label class="block text-[11px] text-text-subtle">
					{t('inbox.compose_cc')}
					<input
						type="text"
						value={draft.cc}
						oninput={(e) => updateComposeDraft({ cc: (e.target as HTMLInputElement).value })}
						class="mt-0.5 w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-sm text-text"
					/>
				</label>
				<label class="block text-[11px] text-text-subtle">
					{t('inbox.compose_bcc')}
					<input
						type="text"
						value={draft.bcc}
						oninput={(e) => updateComposeDraft({ bcc: (e.target as HTMLInputElement).value })}
						class="mt-0.5 w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-sm text-text"
					/>
				</label>
			{:else}
				<button
					type="button"
					class="text-[11px] text-text-subtle hover:text-text"
					onclick={() => (showCcBcc = true)}
				>+ Cc/Bcc</button>
			{/if}

			<label class="block text-[11px] text-text-subtle">
				{t('inbox.compose_subject')}
				<input
					type="text"
					value={draft.subject}
					oninput={(e) => updateComposeDraft({ subject: (e.target as HTMLInputElement).value })}
					class="mt-0.5 w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-sm text-text"
					required
				/>
			</label>

			<textarea
				value={draft.body}
				oninput={(e) => updateComposeDraft({ body: (e.target as HTMLTextAreaElement).value })}
				placeholder={t('inbox.compose_body_placeholder')}
				rows={8}
				class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-sm text-text"
				required
			></textarea>
		</div>

		<footer class="flex items-center justify-end gap-2 border-t border-border px-4 py-2">
			<button
				type="button"
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text"
				onclick={() => closeCompose()}
				disabled={sending}
			>{t('inbox.compose_cancel')}</button>
			<button
				type="submit"
				class="rounded-[var(--radius-sm)] border border-accent bg-accent text-accent-text px-3 py-1.5 text-[11px] hover:opacity-90 disabled:opacity-50"
				disabled={sending || selectedAccountId === null}
			>{sending ? t('inbox.compose_sending') : t('inbox.compose_send')}</button>
		</footer>
	</form>
</div>
