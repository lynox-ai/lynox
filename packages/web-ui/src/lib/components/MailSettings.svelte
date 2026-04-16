<script lang="ts">
	// Provider-agnostic mail (IMAP/SMTP + app-password) account management.
	// Mirrors the google integration block but adds multi-account support
	// and a per-preset app-password link instead of OAuth.

	import { onMount } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface ServerConfig {
		host: string;
		port: number;
		secure: boolean;
	}
	interface PresetDescriptor {
		slug: 'gmail' | 'icloud' | 'fastmail' | 'yahoo' | 'outlook' | 'custom';
		label: string;
		imap: ServerConfig;
		smtp: ServerConfig;
		appPasswordUrl: string | null;
		requires2FA: boolean;
		custom: boolean;
	}
	type MailAccountType =
		| 'personal' | 'business'
		| 'support' | 'sales' | 'hello'
		| 'info' | 'newsletter' | 'notifications'
		| 'abuse' | 'privacy' | 'security' | 'legal';
	interface AccountTypeDescriptor {
		type: MailAccountType;
		receiveOnly: boolean;
		defaultPersona: string;
	}
	interface AccountView {
		id: string;
		displayName: string;
		address: string;
		preset: string;
		imap: ServerConfig;
		smtp: ServerConfig;
		hasCredentials: boolean;
		isDefault: boolean;
		type: MailAccountType;
		persona: string;
		receiveOnly: boolean;
	}
	interface TestResult {
		ok: boolean;
		error?: string;
		code?: string;
	}

	/** Grouping for the type-picker dropdown — semantic ordering. */
	const TYPE_GROUPS: Array<{ label: string; types: MailAccountType[] }> = [
		{ label: 'Owned', types: ['personal', 'business'] },
		{ label: 'Customer-facing', types: ['support', 'sales', 'hello'] },
		{ label: 'Bulk / receive-only', types: ['info', 'newsletter', 'notifications'] },
		{ label: 'Compliance / receive-only', types: ['abuse', 'privacy', 'security', 'legal'] },
	];

	let presets = $state<PresetDescriptor[]>([]);
	let accountTypes = $state<AccountTypeDescriptor[]>([]);
	let accounts = $state<AccountView[]>([]);
	let loading = $state(true);
	let showForm = $state(false);

	// Form state
	let formId = $state('');
	let formDisplayName = $state('');
	let formAddress = $state('');
	let formPreset = $state<'gmail' | 'icloud' | 'fastmail' | 'yahoo' | 'outlook' | 'custom'>('gmail');
	let formType = $state<MailAccountType>('personal');
	let formPersonaPrompt = $state('');
	let formPassword = $state('');

	// Custom-only fields
	let customImapHost = $state('');
	let customImapPort = $state(993);
	let customImapSecure = $state(true);
	let customSmtpHost = $state('');
	let customSmtpPort = $state(465);
	let customSmtpSecure = $state(true);

	let testing = $state(false);
	let saving = $state(false);
	let testResult = $state<TestResult | null>(null);

	const selectedPreset = $derived(presets.find((p) => p.slug === formPreset) ?? null);
	const selectedType = $derived(accountTypes.find((t) => t.type === formType) ?? null);
	const typeIsReceiveOnly = $derived(selectedType?.receiveOnly ?? false);

	async function loadAll() {
		loading = true;
		try {
			const [presetsRes, accountsRes] = await Promise.all([
				fetch(`${getApiBase()}/mail/presets`),
				fetch(`${getApiBase()}/mail/accounts`),
			]);
			if (presetsRes.ok) {
				const data = (await presetsRes.json()) as { presets: PresetDescriptor[]; accountTypes?: AccountTypeDescriptor[] };
				presets = data.presets;
				accountTypes = data.accountTypes ?? [];
			}
			if (accountsRes.ok) {
				const data = (await accountsRes.json()) as { accounts: AccountView[] };
				accounts = data.accounts;
			}
		} catch {
			addToast('Failed to load mail settings', 'error');
		}
		loading = false;
	}

	function resetForm() {
		formId = '';
		formDisplayName = '';
		formAddress = '';
		formPreset = 'gmail';
		formType = 'personal';
		formPersonaPrompt = '';
		formPassword = '';
		customImapHost = '';
		customImapPort = 993;
		customImapSecure = true;
		customSmtpHost = '';
		customSmtpPort = 465;
		customSmtpSecure = true;
		testResult = null;
	}

	function buildCustomPayload() {
		return {
			imap: { host: customImapHost, port: customImapPort, secure: customImapSecure },
			smtp: { host: customSmtpHost, port: customSmtpPort, secure: customSmtpSecure },
		};
	}

	/**
	 * Translate technical MailError codes to user-friendly messages.
	 * Keeps the raw error code visible as a small second line for debugging.
	 */
	function friendlyError(code: string | undefined, raw: string | undefined): string {
		switch (code) {
			case 'auth_failed':
				return 'Login failed — check your email address and app-password. If you enabled 2FA, make sure you generated a provider-specific app-password (not your account password).';
			case 'tls_failed':
				return "The server's certificate couldn't be verified. If this is a custom server with self-signed TLS, contact your admin.";
			case 'connection_failed':
				return "Couldn't reach the mail server. Check the hostname and that the IMAP port is open on your network.";
			case 'timeout':
				return 'The server took too long to respond. Try again, or check your network.';
			case 'not_found':
				return 'No matching mail server found for that address.';
			case 'rate_limited':
				return 'Too many test attempts — wait a minute before retrying.';
			default:
				return raw ?? 'Unknown error';
		}
	}

	let autodiscovering = $state(false);
	async function tryAutodiscover() {
		if (!formAddress) {
			addToast('Enter an email address first', 'error');
			return;
		}
		autodiscovering = true;
		try {
			const res = await fetch(`${getApiBase()}/mail/autodiscover`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ address: formAddress }),
			});
			if (!res.ok) {
				addToast('Autodiscover did not find servers for this address', 'error');
				autodiscovering = false;
				return;
			}
			const data = (await res.json()) as { imap: ServerConfig; smtp: ServerConfig };
			customImapHost = data.imap.host;
			customImapPort = data.imap.port;
			customImapSecure = data.imap.secure;
			customSmtpHost = data.smtp.host;
			customSmtpPort = data.smtp.port;
			customSmtpSecure = data.smtp.secure;
			addToast('Autodiscover success — review the values before testing', 'success');
		} catch {
			addToast('Autodiscover failed', 'error');
		}
		autodiscovering = false;
	}

	async function testConnection() {
		if (!formAddress || !formPassword) {
			addToast('Email address and password are required', 'error');
			return;
		}
		testing = true;
		testResult = null;
		try {
			const payload: Record<string, unknown> = {
				id: formId || formAddress,
				displayName: formDisplayName || formAddress,
				address: formAddress,
				preset: formPreset,
				type: formType,
				credentials: { user: formAddress, pass: formPassword },
			};
			if (formPersonaPrompt.trim()) {
				payload['personaPrompt'] = formPersonaPrompt.trim();
			}
			if (formPreset === 'custom') {
				payload['custom'] = buildCustomPayload();
			}
			const res = await fetch(`${getApiBase()}/mail/accounts/test`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (res.status === 429) {
				testResult = { ok: false, error: 'Too many test attempts — wait a minute', code: 'rate_limited' };
				addToast(friendlyError('rate_limited', undefined), 'error');
				testing = false;
				return;
			}
			const data = (await res.json()) as TestResult;
			testResult = data;
			if (data.ok) {
				addToast('Connection successful', 'success');
			} else {
				addToast(`Connection failed: ${friendlyError(data.code, data.error)}`, 'error');
			}
		} catch (err) {
			testResult = { ok: false, error: err instanceof Error ? err.message : 'Network error', code: 'unknown' };
			addToast('Connection test failed', 'error');
		}
		testing = false;
	}

	async function saveAccount() {
		if (!formId || !formDisplayName || !formAddress || !formPassword) {
			addToast('All fields are required', 'error');
			return;
		}
		saving = true;
		try {
			const payload: Record<string, unknown> = {
				id: formId,
				displayName: formDisplayName,
				address: formAddress,
				preset: formPreset,
				credentials: { user: formAddress, pass: formPassword },
			};
			if (formPreset === 'custom') {
				payload['custom'] = buildCustomPayload();
			}
			const res = await fetch(`${getApiBase()}/mail/accounts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				addToast(err.error ?? 'Save failed', 'error');
				saving = false;
				return;
			}
			addToast('Account saved', 'success');
			showForm = false;
			resetForm();
			await loadAll();
		} catch {
			addToast('Save failed', 'error');
		}
		saving = false;
	}

	async function deleteAccount(id: string) {
		if (!confirm(`Delete mail account "${id}"? Credentials and dedup state will be removed.`)) return;
		try {
			const res = await fetch(`${getApiBase()}/mail/accounts/${encodeURIComponent(id)}`, {
				method: 'DELETE',
			});
			if (!res.ok) throw new Error();
			addToast('Account removed', 'success');
			await loadAll();
		} catch {
			addToast('Delete failed', 'error');
		}
	}

	/** Standard provider domains — if the address domain doesn't match, it's a custom/Workspace domain. */
	const PROVIDER_DOMAINS: Record<string, string> = {
		gmail: 'gmail.com', icloud: 'icloud.com', fastmail: 'fastmail.com',
		yahoo: 'yahoo.com', outlook: 'outlook.com',
	};

	function suggestIdFromAddress() {
		if (!formAddress) return;
		const parts = formAddress.split('@');
		const local = parts[0] ?? '';
		const domain = parts[1] ?? '';
		const providerDomain = PROVIDER_DOMAINS[formPreset] ?? '';
		const isCustomDomain = domain.toLowerCase() !== providerDomain.toLowerCase();
		const name = local.split(/[.+_]/)[0] ?? local;

		if (!formId) {
			// "rafael-lynox-ai" for Workspace, "rafael-gmail" for standard Gmail
			const suffix = isCustomDomain && domain ? domain.replace(/\./g, '-') : formPreset === 'custom' ? 'mail' : formPreset;
			formId = `${name}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
		}
		if (!formDisplayName) {
			const displayName = local
				.split(/[.+_]/)
				.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
				.join(' ');
			// "Rafael — lynox.ai" for Workspace, "Rafael — Gmail" for standard
			const label = isCustomDomain && domain ? domain : (selectedPreset?.label ?? formPreset);
			formDisplayName = `${displayName} — ${label}`;
		}
	}

	onMount(loadAll);
</script>

<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5" data-testid="mail-settings">
	<div class="mb-4 flex items-center justify-between">
		<div>
			<h2 class="font-medium">Mail (IMAP/SMTP)</h2>
			<p class="mt-1 text-xs text-text-muted">
				Connect Gmail, iCloud, Fastmail, Yahoo, Outlook, or any custom IMAP/SMTP server using an app-password.
			</p>
		</div>
		{#if loading}
			<span class="text-xs text-text-subtle">Loading…</span>
		{:else if accounts.length > 0}
			<span class="text-xs text-success">{accounts.length} account{accounts.length === 1 ? '' : 's'}</span>
		{:else}
			<span class="text-xs text-text-subtle">Not configured</span>
		{/if}
	</div>

	{#if !loading}
		{#if accounts.length > 0}
			<div class="mb-4 space-y-2" data-testid="mail-account-list">
				{#each accounts as account (account.id)}
					<div class="flex items-center justify-between rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="truncate text-sm font-medium">{account.displayName}</span>
								{#if account.isDefault}
									<span class="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-text">DEFAULT</span>
								{/if}
								{#if !account.hasCredentials}
									<span class="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">NEEDS PASSWORD</span>
								{/if}
							</div>
							<div class="truncate text-xs text-text-muted">
								{account.address} · {account.preset} · <strong>{account.type}</strong>{#if account.receiveOnly} <span class="ml-1 rounded bg-warning/20 px-1 text-[10px] font-medium text-warning">RECEIVE-ONLY</span>{/if}
							</div>
							{#if account.persona && !account.receiveOnly}
								<div class="mt-0.5 truncate text-[10px] text-text-subtle italic">
									{account.persona}
								</div>
							{/if}
						</div>
						<button
							type="button"
							class="ml-3 rounded border border-border px-2 py-1 text-xs text-text-muted hover:border-danger hover:text-danger"
							onclick={() => deleteAccount(account.id)}
							data-testid="mail-delete-{account.id}"
						>
							Delete
						</button>
					</div>
				{/each}
			</div>
		{/if}

		{#if !showForm}
			<button
				type="button"
				class="rounded-[var(--radius-md)] border border-border bg-bg px-3 py-1.5 text-xs font-medium hover:border-border-hover hover:bg-bg-hover"
				onclick={() => { showForm = true; resetForm(); }}
				data-testid="mail-add-button"
			>
				+ Add mail account
			</button>
		{:else}
			<div class="space-y-3 rounded-[var(--radius-md)] border border-border bg-bg p-4" data-testid="mail-add-form">
				<div class="flex items-center justify-between">
					<h3 class="text-sm font-medium">Add mail account</h3>
					<button
						type="button"
						class="text-xs text-text-muted hover:text-text"
						onclick={() => { showForm = false; resetForm(); }}
					>
						Cancel
					</button>
				</div>

				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-muted">Provider</span>
					<select
						class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-sm"
						bind:value={formPreset}
						data-testid="mail-preset-select"
					>
						{#each presets as p (p.slug)}
							<option value={p.slug}>{p.label}</option>
						{/each}
					</select>
				</label>

				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-muted">
						Account role
						<span class="ml-1 text-[10px] font-normal text-text-subtle">
							(drives tone, auto-reply policy, receive-only block)
						</span>
					</span>
					<select
						class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-sm"
						bind:value={formType}
						data-testid="mail-type-select"
					>
						{#each TYPE_GROUPS as group}
							<optgroup label={group.label}>
								{#each group.types as t}
									<option value={t}>{t}</option>
								{/each}
							</optgroup>
						{/each}
					</select>
					{#if typeIsReceiveOnly}
						<p class="mt-1 text-[10px] text-warning" data-testid="mail-receive-only-warning">
							⚠ {formType} is a receive-only type. The agent will never send or auto-reply from this mailbox.
						</p>
					{/if}
				</label>

				{#if selectedPreset && !selectedPreset.custom}
					<div class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-3 text-xs text-text-muted">
						<p class="mb-1">
							<strong>IMAP:</strong> {selectedPreset.imap.host}:{selectedPreset.imap.port}
							{selectedPreset.imap.secure ? '(TLS)' : '(STARTTLS)'}
						</p>
						<p class="mb-2">
							<strong>SMTP:</strong> {selectedPreset.smtp.host}:{selectedPreset.smtp.port}
							{selectedPreset.smtp.secure ? '(TLS)' : '(STARTTLS)'}
						</p>
						{#if selectedPreset.appPasswordUrl}
							<div class="space-y-1">
								<p><strong>{selectedPreset.requires2FA ? '2FA required. ' : ''}How to create an app-password:</strong></p>
								{#if formPreset === 'gmail'}
									<ol class="ml-4 list-decimal space-y-0.5">
										<li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">myaccount.google.com/apppasswords</a></li>
										<li>Enter a name (e.g. "lynox") and click "Create"</li>
										<li>Copy the 16-character password and paste it below</li>
									</ol>
									<details class="mt-1.5 text-[10px] text-text-subtle">
										<summary class="cursor-pointer font-medium">Google Workspace: "Setting not available"?</summary>
										<p class="ml-4 mt-1 mb-1">App passwords require 2-Step Verification. Two steps needed:</p>
										<p class="ml-4 mb-0.5 font-medium">1. Admin enables 2FA for the organization:</p>
										<ol class="ml-8 list-decimal space-y-0.5">
											<li><a href="https://admin.google.com/ac/security/2sv" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">admin.google.com → Security → 2-Step Verification</a></li>
											<li>Check <strong>"Allow users to turn on 2-Step Verification"</strong></li>
											<li>Enforcement can stay <strong>"Off"</strong> — users just need the ability to opt in</li>
											<li>Click <strong>Save</strong></li>
										</ol>
										<p class="ml-4 mt-1 mb-0.5 font-medium">2. Each user activates 2FA on their own account:</p>
										<ol class="ml-8 list-decimal space-y-0.5">
											<li><a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">myaccount.google.com → Security → 2-Step Verification</a> → activate</li>
											<li>After 2FA is active, <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">App Passwords</a> become available</li>
										</ol>
									</details>
								{:else if formPreset === 'icloud'}
									<ol class="ml-4 list-decimal space-y-0.5">
										<li>Open <a href="https://account.apple.com/account/manage/section/security" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">account.apple.com → Security</a></li>
										<li>Click <strong>"App-Specific Passwords"</strong> → "Generate"</li>
										<li>Enter a label (e.g. "lynox"), copy the generated password</li>
										<li>Use your <strong>@icloud.com address</strong> as the email below (not your Apple ID if different)</li>
									</ol>
								{:else if formPreset === 'fastmail'}
									<ol class="ml-4 list-decimal space-y-0.5">
										<li>Open <a href="https://www.fastmail.com/settings/security/devicekeys" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">Fastmail → Security → App passwords</a></li>
										<li>Click "New app password", name it "lynox"</li>
										<li>Copy the password and paste it below</li>
									</ol>
								{:else if formPreset === 'yahoo'}
									<ol class="ml-4 list-decimal space-y-0.5">
										<li>Open <a href="https://login.yahoo.com/myaccount/security/app-passwords/list" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">Yahoo → Security → App passwords</a></li>
										<li>Select "Other app", name it "lynox"</li>
										<li>Copy the generated password and paste it below</li>
									</ol>
								{:else if formPreset === 'outlook'}
									<ol class="ml-4 list-decimal space-y-0.5">
										<li>Open <a href="https://account.live.com/proofs/AppPassword" target="_blank" rel="noopener noreferrer" class="text-accent-text underline">Microsoft → Security → App passwords</a></li>
										<li>Click "Create a new app password"</li>
										<li>Copy the password and paste it below</li>
									</ol>
								{:else}
									<p>
										Create an app-password:
										<a href={selectedPreset.appPasswordUrl} target="_blank" rel="noopener noreferrer" class="text-accent-text underline">{selectedPreset.appPasswordUrl}</a>
									</p>
								{/if}
							</div>
						{/if}
					</div>
				{/if}

				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-muted">Email address</span>
					<input
						type="email"
						class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-sm"
						bind:value={formAddress}
						onblur={suggestIdFromAddress}
						placeholder="you@example.com"
						data-testid="mail-address-input"
					/>
				</label>

				<div class="grid grid-cols-2 gap-3">
					<label class="block">
						<span class="mb-1 block text-xs font-medium text-text-muted">Account id</span>
						<input
							type="text"
							class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-sm"
							bind:value={formId}
							placeholder="rafael-gmail"
							data-testid="mail-id-input"
						/>
					</label>
					<label class="block">
						<span class="mb-1 block text-xs font-medium text-text-muted">Display name</span>
						<input
							type="text"
							class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-sm"
							bind:value={formDisplayName}
							placeholder="Rafael — Gmail"
							data-testid="mail-display-name-input"
						/>
					</label>
				</div>

				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-muted">App password</span>
					<input
						type="password"
						class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-sm"
						bind:value={formPassword}
						placeholder="xxxx xxxx xxxx xxxx"
						autocomplete="new-password"
						data-testid="mail-password-input"
					/>
				</label>

				{#if !typeIsReceiveOnly}
					<label class="block">
						<span class="mb-1 block text-xs font-medium text-text-muted">
							Persona override
							<span class="ml-1 text-[10px] font-normal text-text-subtle">
								(optional — leave blank to use the type default)
							</span>
						</span>
						<textarea
							class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1.5 text-sm"
							rows="2"
							bind:value={formPersonaPrompt}
							placeholder={selectedType?.defaultPersona ?? 'Short, formal, sign as Rafael…'}
							data-testid="mail-persona-input"
						></textarea>
					</label>
				{/if}

				{#if formPreset === 'custom'}
					<div class="space-y-2 rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-3">
						<div class="flex items-center justify-between">
							<p class="text-xs font-medium text-text-muted">Custom server</p>
							<button
								type="button"
								class="rounded border border-border px-2 py-0.5 text-[10px] hover:border-border-hover disabled:opacity-50"
								onclick={tryAutodiscover}
								disabled={autodiscovering || !formAddress}
								data-testid="mail-autodiscover-button"
							>
								{autodiscovering ? 'Discovering…' : 'Try autodiscover'}
							</button>
						</div>
						<div class="grid grid-cols-2 gap-2">
							<label class="block">
								<span class="mb-1 block text-[10px] text-text-muted">IMAP host</span>
								<input type="text" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs" bind:value={customImapHost} placeholder="imap.example.com" data-testid="mail-custom-imap-host" />
							</label>
							<label class="block">
								<span class="mb-1 block text-[10px] text-text-muted">IMAP port</span>
								<input type="number" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs" bind:value={customImapPort} />
							</label>
						</div>
						<label class="flex items-center gap-2 text-xs">
							<input type="checkbox" bind:checked={customImapSecure} />
							IMAP implicit TLS (993)
						</label>
						<div class="grid grid-cols-2 gap-2">
							<label class="block">
								<span class="mb-1 block text-[10px] text-text-muted">SMTP host</span>
								<input type="text" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs" bind:value={customSmtpHost} placeholder="smtp.example.com" data-testid="mail-custom-smtp-host" />
							</label>
							<label class="block">
								<span class="mb-1 block text-[10px] text-text-muted">SMTP port</span>
								<input type="number" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs" bind:value={customSmtpPort} />
							</label>
						</div>
						<label class="flex items-center gap-2 text-xs">
							<input type="checkbox" bind:checked={customSmtpSecure} />
							SMTP implicit TLS (465)
						</label>
					</div>
				{/if}

				{#if testResult}
					<div class="rounded-[var(--radius-sm)] border p-2 text-xs {testResult.ok ? 'border-success/30 bg-success/5 text-success' : 'border-danger/30 bg-danger/5 text-danger'}">
						{#if testResult.ok}
							✓ Connection successful — IMAP login + mailbox open succeeded.
						{:else}
							<div class="font-medium">✗ {friendlyError(testResult.code, testResult.error)}</div>
							<div class="mt-0.5 text-[10px] opacity-60">{testResult.code ?? 'unknown'}</div>
						{/if}
					</div>
				{/if}

				<div class="flex gap-2 pt-1">
					<button
						type="button"
						class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-1.5 text-xs font-medium hover:border-border-hover disabled:opacity-50"
						onclick={testConnection}
						disabled={testing || saving}
						data-testid="mail-test-button"
					>
						{testing ? 'Testing…' : 'Test connection'}
					</button>
					<button
						type="button"
						class="rounded-[var(--radius-md)] border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:border-accent-hover hover:bg-accent-hover disabled:opacity-50"
						onclick={saveAccount}
						disabled={testing || saving}
						data-testid="mail-save-button"
					>
						{saving ? 'Saving…' : 'Save & test on save'}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>
