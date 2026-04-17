<script lang="ts">
	// WhatsApp Business Cloud API settings — BYOK Phase 0.
	// One WABA per instance. Customer pastes the four credential fields
	// (Access Token, WABA-ID, Phone-Number-ID, App-Secret) plus a webhook
	// verify token they chose when configuring the webhook in their Meta App.

	import { onMount } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface Status { featureEnabled: boolean; available: boolean; configured: boolean; }
	interface VerifiedInfo { displayPhoneNumber: string; verifiedName: string | null; }
	interface SaveResponse { saved: boolean; verified: VerifiedInfo | null; probeError: string | null; }

	let status = $state<Status | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let clearing = $state(false);
	let showForm = $state(false);

	let accessToken = $state('');
	let wabaId = $state('');
	let phoneNumberId = $state('');
	let appSecret = $state('');
	let webhookVerifyToken = $state('');

	let verified = $state<VerifiedInfo | null>(null);

	const webhookUrl = $derived(typeof window !== 'undefined'
		? `${window.location.origin}/api/webhooks/whatsapp`
		: '');

	async function loadStatus() {
		loading = true;
		try {
			const res = await fetch(`${getApiBase()}/whatsapp/status`);
			if (!res.ok) throw new Error();
			status = await res.json() as Status;
		} catch {
			status = null;
		}
		loading = false;
	}

	onMount(loadStatus);

	async function save() {
		if (!accessToken.trim() || !wabaId.trim() || !phoneNumberId.trim() || !appSecret.trim() || !webhookVerifyToken.trim()) {
			addToast('Alle Felder sind Pflicht', 'error');
			return;
		}
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/whatsapp/credentials`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					accessToken: accessToken.trim(),
					wabaId: wabaId.trim(),
					phoneNumberId: phoneNumberId.trim(),
					appSecret: appSecret.trim(),
					webhookVerifyToken: webhookVerifyToken.trim(),
				}),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({ error: 'Save failed' }))) as { error?: string };
				throw new Error(err.error ?? 'Save failed');
			}
			const data = await res.json() as SaveResponse;
			verified = data.verified;
			if (data.probeError) {
				addToast(`Gespeichert — Meta-Prüfung fehlgeschlagen: ${data.probeError}`, 'error');
			} else {
				addToast('WhatsApp verbunden', 'success');
			}
			accessToken = ''; wabaId = ''; phoneNumberId = ''; appSecret = ''; webhookVerifyToken = '';
			showForm = false;
			await loadStatus();
		} catch (e) {
			addToast(e instanceof Error ? e.message : 'Speichern fehlgeschlagen', 'error');
		}
		saving = false;
	}

	async function clearCreds() {
		if (!confirm('WhatsApp-Verbindung wirklich entfernen? Die Meta-App selbst bleibt unberührt.')) return;
		clearing = true;
		try {
			const res = await fetch(`${getApiBase()}/whatsapp/credentials`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			verified = null;
			addToast('Verbindung entfernt', 'success');
			await loadStatus();
		} catch {
			addToast('Entfernen fehlgeschlagen', 'error');
		}
		clearing = false;
	}

	async function copyText(text: string) {
		await navigator.clipboard.writeText(text);
		addToast('Kopiert', 'success', 1500);
	}
</script>

{#if loading}
	<!-- hide section entirely while loading to avoid a flash for non-pilot instances -->
{:else if status?.featureEnabled}
<section class="wa">
	<header>
		<h3>WhatsApp Business (Coexistence)</h3>
		<p class="sub">
			Verbindet deine WhatsApp-Business-Nummer via Meta Cloud API (BYOK).
			Deine Mobile App läuft parallel weiter — lynox liest und draftet, du bestätigst.
		</p>
	</header>

	{#if !status.available}
		<p class="muted">
			WhatsApp-Integration nicht verfügbar. Setze <code>LYNOX_VAULT_KEY</code> und starte die Engine neu.
		</p>
	{:else if status.configured && !showForm}
		<div class="row">
			<span class="pill ok">Verbunden</span>
			<button class="btn-link" onclick={() => { showForm = true; }}>Zugangsdaten ändern</button>
			<button class="btn-danger" onclick={clearCreds} disabled={clearing}>
				{clearing ? 'Entferne …' : 'Verbindung entfernen'}
			</button>
		</div>
		<p class="muted">Webhook-URL (in deiner Meta-App hinterlegt): <code>{webhookUrl}</code></p>
		{#if verified}
			<p class="muted">Verifiziert als: <strong>{verified.displayPhoneNumber}</strong> {verified.verifiedName ? `(${verified.verifiedName})` : ''}</p>
		{/if}
	{:else}
		{#if !showForm}
			<button class="btn-primary" onclick={() => { showForm = true; }}>WhatsApp verbinden</button>
		{/if}

		{#if showForm}
			<div class="instructions">
				<p><strong>Vorab (einmalig) in deiner Meta Business Manager:</strong></p>
				<ol>
					<li>WhatsApp Business App auf v2.24.17+ updaten, Nummer mit Facebook-Page verknüpfen.</li>
					<li>Auf <code>developers.facebook.com</code> eigene App erstellen → WhatsApp-Produkt hinzufügen.</li>
					<li>Permanent Access Token (System User) generieren.</li>
					<li>Coexistence Mode aktivieren (QR-Code in Business App scannen).</li>
					<li>
						Webhook eintragen — URL: <code>{webhookUrl}</code>
						<button class="mini" onclick={() => copyText(webhookUrl)}>kopieren</button><br>
						Events abonnieren: <code>messages</code>, <code>message_status</code>, <code>smb_message_echoes</code>
					</li>
				</ol>
				<p class="warn">
					⚠️ Nach Aktivierung verschwinden in 1:1-Chats: Disappearing Messages, View-once, Live-Location.
					Broadcast-Listen werden read-only. Gruppen-Chats werden nicht synchronisiert.
				</p>
			</div>

			<div class="form">
				<label>
					Access Token
					<input type="password" bind:value={accessToken} placeholder="EAAxxxxxxxxxx..." autocomplete="off" />
				</label>
				<label>
					WhatsApp Business Account ID (WABA-ID)
					<input type="text" bind:value={wabaId} placeholder="123456789012345" autocomplete="off" />
				</label>
				<label>
					Phone Number ID
					<input type="text" bind:value={phoneNumberId} placeholder="987654321098765" autocomplete="off" />
				</label>
				<label>
					App Secret
					<input type="password" bind:value={appSecret} placeholder="Aus Meta-App → Basic Settings" autocomplete="off" />
				</label>
				<label>
					Webhook Verify Token
					<input type="text" bind:value={webhookVerifyToken} placeholder="frei gewählt, muss mit Meta übereinstimmen" autocomplete="off" />
				</label>

				<div class="actions">
					<button class="btn-primary" onclick={save} disabled={saving}>
						{saving ? 'Speichere …' : 'Speichern + prüfen'}
					</button>
					<button class="btn-link" onclick={() => { showForm = false; }}>Abbrechen</button>
				</div>
			</div>
		{/if}
	{/if}
</section>
{/if}

<style>
	.wa {
		padding: 1rem 1.25rem;
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 0.5rem;
		margin-bottom: 1.5rem;
		background: var(--color-surface, #141414);
	}
	header h3 { margin: 0 0 0.25rem 0; font-size: 1.05rem; }
	.sub { color: var(--color-muted, #999); font-size: 0.85rem; margin: 0 0 1rem 0; }
	.muted { color: var(--color-muted, #888); font-size: 0.85rem; }
	.warn { color: #e0a030; background: rgba(224, 160, 48, 0.08); padding: 0.5rem 0.75rem; border-left: 3px solid #e0a030; border-radius: 0.25rem; font-size: 0.85rem; }
	.row { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; }
	.pill { padding: 0.15rem 0.6rem; border-radius: 1rem; font-size: 0.75rem; }
	.pill.ok { background: rgba(74, 222, 128, 0.12); color: #4ade80; }
	.instructions { background: rgba(255,255,255,0.03); padding: 0.75rem 1rem; border-radius: 0.4rem; margin-bottom: 1rem; font-size: 0.85rem; }
	.instructions ol { margin: 0.25rem 0 0.75rem 1.2rem; padding: 0; }
	.instructions li { margin-bottom: 0.4rem; }
	code { font-size: 0.8em; background: rgba(255,255,255,0.05); padding: 0.05em 0.3em; border-radius: 0.2em; }
	.form { display: flex; flex-direction: column; gap: 0.75rem; }
	.form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--color-muted, #bbb); }
	.form input { padding: 0.5rem 0.6rem; border-radius: 0.3rem; border: 1px solid var(--color-border, #333); background: var(--color-bg, #0d0d0d); color: inherit; font-family: inherit; font-size: 0.9rem; }
	.actions { display: flex; gap: 0.75rem; margin-top: 0.5rem; }
	.btn-primary { background: #3b82f6; color: white; border: none; padding: 0.5rem 1rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.9rem; }
	.btn-primary:disabled { opacity: 0.5; cursor: wait; }
	.btn-danger { background: transparent; color: #f87171; border: 1px solid #f87171; padding: 0.35rem 0.75rem; border-radius: 0.3rem; cursor: pointer; font-size: 0.8rem; }
	.btn-danger:disabled { opacity: 0.5; }
	.btn-link { background: none; border: none; color: #3b82f6; cursor: pointer; font-size: 0.85rem; text-decoration: underline; }
	.mini { background: none; border: 1px solid #444; color: #888; padding: 0.1rem 0.4rem; border-radius: 0.2rem; font-size: 0.7rem; cursor: pointer; margin-left: 0.25rem; }
</style>
