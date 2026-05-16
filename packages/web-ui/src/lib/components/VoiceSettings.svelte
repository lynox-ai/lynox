<!--
	Voice Settings — STT + TTS provider pickers + voice catalog.
	PRD-SETTINGS-REFACTOR Phase 3 extraction from ConfigView Compliance tab
	(Principle 5). Mounted at /app/settings/privacy/voice per PRD-IA-V2 P3-PR-D
	— old /app/settings/voice route is a 301 redirect.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface VoiceInfo {
		stt: {
			available: boolean;
			provider: string | null;
			providers: Array<{ id: string; name: string; available: boolean }>;
			config_value: string | null;
			env_override: string | null;
		};
		tts: {
			available: boolean;
			provider: string | null;
			providers: Array<{ id: string; name: string; available: boolean }>;
			voices: Array<{ id: string; language?: string; description?: string }>;
			config_value: string | null;
			config_voice: string | null;
			env_override: string | null;
		};
	}
	interface Config {
		transcription_provider?: 'mistral' | 'whisper' | 'auto';
		tts_provider?: 'mistral' | 'auto';
		tts_voice?: string;
	}

	let info = $state<VoiceInfo | null>(null);
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
			info = (await infoRes.json()) as VoiceInfo;
			const body = (await configRes.json()) as Config;
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
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('voice.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('voice.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	$effect(() => { void load(); });
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('voice.title')}</h1>
		<p class="text-sm text-text-muted">{t('voice.subtitle')}</p>
	</header>

	{#if !info}
		<p class="text-sm text-text-muted">{t('voice.loading')}</p>
	{:else}
		<!-- STT (speech-to-text) -->
		<section class="space-y-3">
			<h2 class="text-lg font-medium">{t('voice.stt_heading')}</h2>
			<p class="text-xs text-text-muted">{t('voice.stt_privacy')}</p>
			{#if info.stt.env_override}
				<p class="text-xs text-warning">{t('voice.env_override')} <code class="font-mono">{info.stt.env_override}</code></p>
				<select disabled class="w-full px-2 py-1 border border-border rounded bg-bg opacity-60">
					<option>{info.stt.provider ?? '—'}</option>
				</select>
			{:else}
				<select disabled={!loaded} bind:value={config.transcription_provider}
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
			<p class="text-xs text-text-muted">{t('voice.tts_privacy')}</p>
			{#if info.tts.env_override}
				<p class="text-xs text-warning">{t('voice.env_override')} <code class="font-mono">{info.tts.env_override}</code></p>
				<select disabled class="w-full px-2 py-1 border border-border rounded bg-bg opacity-60">
					<option>{info.tts.provider ?? '—'}</option>
				</select>
			{:else}
				<select disabled={!loaded} bind:value={config.tts_provider}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					{#each info.tts.providers as p (p.id)}
						<option value={p.id} disabled={!p.available}>{p.name}{p.available ? '' : ' — ' + t('voice.unavailable')}</option>
					{/each}
				</select>
			{/if}

			{#if info.tts.voices.length > 0}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('voice.tts_voice')}</span>
					<select disabled={!loaded} bind:value={config.tts_voice}
						class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
						<option value={undefined}>{t('voice.default')}</option>
						{#each info.tts.voices as v (v.id)}
							<option value={v.id}>{v.id}{v.language ? ' (' + v.language + ')' : ''}</option>
						{/each}
					</select>
				</label>
			{/if}
		</section>

		<div class="flex justify-end">
			<button type="button" onclick={save} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('voice.saving') : t('voice.save')}
			</button>
		</div>
	{/if}
</div>
