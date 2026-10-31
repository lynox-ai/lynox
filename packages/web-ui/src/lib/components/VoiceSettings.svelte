<!--
	Voice Settings — STT + TTS provider pickers + voice catalog.
	PRD-SETTINGS-REFACTOR Phase 3 extraction from ConfigView Compliance tab
	(Principle 5). Mounted at /app/settings/privacy/voice per PRD-IA-V2 P3-PR-D
	— old /app/settings/voice route is a 301 redirect.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { saveFailedText, throwIfRefused } from '../api/save-refusal.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { isMandateSession, noteSettingsViewer } from '../stores/settings-viewer.svelte.js';
	import OwnerOnlyNotice from './settings-readonly/OwnerOnlyNotice.svelte';
	import ReadOnlyRows from './settings-readonly/ReadOnlyRows.svelte';
	import { optionLabel } from './settings-readonly/values.js';

	interface VoiceInfo {
		/** The instance is connected to a Shopify store: no text or audio goes to a speech
		 *  service, so reading aloud is off and dictation runs only with whisper.cpp. */
		speech_service_off?: boolean;
		stt: {
			available: boolean;
			provider: string | null;
			providers: Array<{ id: string; name: string; available: boolean }>;
			config_value: string | null;
			env_override: string | null;
			/** Managed instance: this field is outside the tenant-writable set, so the
			 *  picker must not look live. Decided server-side by the same set the write
			 *  gate enforces — see GET /api/voice/info. */
			locked?: boolean;
		};
		tts: {
			available: boolean;
			provider: string | null;
			providers: Array<{ id: string; name: string; available: boolean }>;
			voices: Array<{ id: string; language?: string; description?: string }>;
			config_value: string | null;
			config_voice: string | null;
			env_override: string | null;
			/** Managed instance: this field is outside the tenant-writable set, so the
			 *  picker must not look live. Decided server-side by the same set the write
			 *  gate enforces — see GET /api/voice/info. */
			locked?: boolean;
		};
	}
	interface Config {
		transcription_provider?: 'mistral' | 'whisper' | 'auto';
		tts_provider?: 'mistral' | 'auto';
		tts_voice?: string;
	}

	let info = $state<VoiceInfo | null>(null);
	// A section offers a choice only where one of its options is available; on an instance
	// connected to a Shopify store none may be (ux U-074), and then neither the picker nor
	// "Save" is shown.
	const sttChoosable = $derived(info?.stt.providers.some((p) => p.available) ?? false);
	const ttsChoosable = $derived(info?.tts.providers.some((p) => p.available) ?? false);
	let config = $state<Config>({});
	let loaded = $state(false);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const [infoRes, configRes] = await Promise.all([
				fetch(`${getApiBase()}/voice/info`),
				fetch(`${getApiBase()}/config`),
			]);
			if (!infoRes.ok || !configRes.ok) throw new Error(`HTTP ${infoRes.status} / ${configRes.status}`);
			const infoBody = (await infoRes.json()) as VoiceInfo;
			const body = (await configRes.json()) as Config;
			// Whose session asks, before `info` shows a section: a mandate never sees the pickers flash.
			noteSettingsViewer(body);
			info = infoBody;
			config = {
				transcription_provider: body.transcription_provider,
				tts_provider: body.tts_provider,
				tts_voice: body.tts_voice,
			};
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('voice.load_failed'), 'error', 5000);
		}
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(config),
			});
			await throwIfRefused(res);
			addToast(t('voice.saved'), 'success', 3000);
		} catch (e) {
			addToast(saveFailedText(e, t('voice.save_failed')), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	$effect(() => { void load(); });

	// A mandate's session (ux U-104): what each picker shows, as text, with the option's visible
	// name. A section without a choice shows no picker to the owner, and no row here.
	function providerRow(label: string, side: VoiceInfo['stt'], chosen: string | undefined): { label: string; value: string } {
		const options = side.providers.map((p) => ({ value: p.id, label: p.name }));
		// Pinned by the environment or locked on a managed instance: the picker shows the provider in use.
		const value = side.env_override || side.locked ? side.provider : (chosen ?? 'auto');
		return { label, value: optionLabel(value, options) };
	}
	const mandateRows = $derived.by(() => {
		if (!info) return [];
		const rows: { label: string; value: string }[] = [];
		if (sttChoosable) rows.push(providerRow(t('voice.stt_heading'), info.stt, config.transcription_provider));
		if (ttsChoosable) rows.push(providerRow(t('voice.tts_heading'), info.tts, config.tts_provider));
		if (ttsChoosable && info.tts.voices.length > 0) {
			const voices = info.tts.voices.map((v) => ({ value: v.id, label: `${v.id}${v.language ? ' (' + v.language + ')' : ''}` }));
			rows.push({ label: t('voice.tts_voice'), value: config.tts_voice ? optionLabel(config.tts_voice, voices) : t('voice.default') });
		}
		return rows;
	});
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('voice.title')}</h1>
		<p class="text-sm text-text-muted">{t('voice.subtitle')}</p>
	</header>

	{#if !info}
		<p class="text-sm text-text-muted">{t('voice.loading')}</p>
	{:else if isMandateSession()}
		<!-- PUT /api/config is the owner's. -->
		<OwnerOnlyNotice />
		<ReadOnlyRows rows={mandateRows} />
	{:else}
		<!-- STT (speech-to-text) -->
		<section class="space-y-3">
			<h2 class="text-lg font-medium">{t('voice.stt_heading')}</h2>
			{#if info.speech_service_off && !info.stt.available}
				<p class="text-xs text-text-muted">{t('voice.stt_off_shopify')}</p>
			{:else if info.speech_service_off}
				<!-- whisper.cpp transcribes on the instance: the Mistral privacy note would be false here. -->
				<p class="text-xs text-text-muted">{t('voice.stt_local_shopify')}</p>
			{:else}
				<p class="text-xs text-text-muted">{t('voice.stt_privacy')}</p>
			{/if}
			{#if !sttChoosable}
				<!-- nothing to choose -->
			{:else if info.stt.env_override}
				<p class="text-xs text-warning">{t('voice.env_override')} <code class="font-mono">{info.stt.env_override}</code></p>
				<select disabled class="w-full px-2 py-1 border border-border rounded bg-bg opacity-60">
					<option>{info.stt.provider ?? '—'}</option>
				</select>
			{:else if info.stt.locked}
				{#if !info.speech_service_off}<p class="text-xs text-text-muted">{t('voice.managed_locked')}</p>{/if}
				<select disabled class="w-full px-2 py-1 border border-border rounded bg-bg opacity-60">
					<option>{info.stt.provider ?? '—'}</option>
				</select>
			{:else}
				<select disabled={!loaded} value={config.transcription_provider ?? 'auto'}
					onchange={(e) => { config.transcription_provider = e.currentTarget.value as Config['transcription_provider']; }}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					{#each info.stt.providers as p (p.id)}
						<option value={p.id} disabled={!p.available}>{p.name}{p.available ? '' : ' — ' + t('voice.unavailable')}</option>
					{/each}
				</select>
			{/if}
		</section>

		<!-- TTS (text-to-speech) -->
		<section class="space-y-3 border-t border-border pt-6">
			<h2 class="text-lg font-medium">{t('voice.tts_heading')}</h2>
			{#if info.speech_service_off}
				<p class="text-xs text-text-muted">{t('voice.tts_off_shopify')}</p>
			{:else}
				<p class="text-xs text-text-muted">{t('voice.tts_privacy')}</p>
			{/if}
			{#if !ttsChoosable}
				<!-- nothing to choose -->
			{:else if info.tts.env_override}
				<p class="text-xs text-warning">{t('voice.env_override')} <code class="font-mono">{info.tts.env_override}</code></p>
				<select disabled class="w-full px-2 py-1 border border-border rounded bg-bg opacity-60">
					<option>{info.tts.provider ?? '—'}</option>
				</select>
			{:else if info.tts.locked}
				{#if !info.speech_service_off}<p class="text-xs text-text-muted">{t('voice.managed_locked')}</p>{/if}
				<select disabled class="w-full px-2 py-1 border border-border rounded bg-bg opacity-60">
					<option>{info.tts.provider ?? '—'}</option>
				</select>
			{:else}
				<select disabled={!loaded} value={config.tts_provider ?? 'auto'}
					onchange={(e) => { config.tts_provider = e.currentTarget.value as Config['tts_provider']; }}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					{#each info.tts.providers as p (p.id)}
						<option value={p.id} disabled={!p.available}>{p.name}{p.available ? '' : ' — ' + t('voice.unavailable')}</option>
					{/each}
				</select>
			{/if}

			{#if ttsChoosable && info.tts.voices.length > 0}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('voice.tts_voice')}</span>
					<select disabled={!loaded} bind:value={config.tts_voice}
						class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
						<option value={undefined}>{t('voice.default')}</option>
						{#each info.tts.voices as v (v.id)}
							<option value={v.id}>{v.id}{v.language ? ' (' + v.language + ')' : ''}</option>
						{/each}
					</select>
					<span class="block text-xs text-text-muted mt-1">{t('voice.tts_voice_hint')}</span>
				</label>
			{/if}
		</section>

		{#if sttChoosable || ttsChoosable}
		<div class="flex justify-end">
			<button type="button" onclick={save} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('voice.saving') : t('voice.save')}
			</button>
		</div>
		{/if}
	{/if}
</div>
