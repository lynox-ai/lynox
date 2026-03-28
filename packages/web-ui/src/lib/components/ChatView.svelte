<script lang="ts">
	import {
		sendMessage,
		abortRun,
		replyPermission,
		getMessages,
		getIsStreaming,
		getQueueLength,
		getPendingPermission,
		getChatError,
		clearError,
		cancelQueue,
		type FileAttachment,
		type UsageInfo
	} from '../stores/chat.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	// Mask any secret-like patterns (API keys, tokens) that might leak into display
	const SECRET_PATTERNS = [
		/sk-ant-[a-zA-Z0-9_-]{20,}/g,
		/sk-[a-zA-Z0-9_-]{20,}/g,
		/tvly-[a-zA-Z0-9_-]{10,}/g,
		/\d{5,}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
	];
	function maskText(text: string): string {
		let result = text;
		for (const pattern of SECRET_PATTERNS) {
			result = result.replace(pattern, (match) => `***${match.slice(-4)}`);
		}
		return result;
	}

	let inputText = $state('');
	let messagesEl: HTMLDivElement;
	let textareaEl: HTMLTextAreaElement;
	let fileInputEl: HTMLInputElement;
	let pendingFiles = $state<FileAttachment[]>([]);
	let recording = $state(false);
	let recordingSeconds = $state(0);
	let recordingTimer: ReturnType<typeof setInterval> | null = null;

	function handleFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files) return;
		for (const file of input.files) {
			const reader = new FileReader();
			reader.onload = () => {
				const base64 = (reader.result as string).split(',')[1] ?? '';
				pendingFiles = [...pendingFiles, { name: file.name, type: file.type, data: base64 }];
			};
			reader.readAsDataURL(file);
		}
		input.value = '';
	}

	function removeFile(idx: number) {
		pendingFiles = pendingFiles.filter((_, i) => i !== idx);
	}

	let mediaRecorder: MediaRecorder | null = null;

	async function toggleVoice() {
		if (recording && mediaRecorder) {
			mediaRecorder.stop();
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
			const chunks: Blob[] = [];

			recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
			recorder.onstop = async () => {
				stream.getTracks().forEach((track) => track.stop());
				recording = false;
				recordingSeconds = 0;
				if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
				mediaRecorder = null;

				const blob = new Blob(chunks, { type: 'audio/webm' });
				const reader = new FileReader();
				reader.onload = async () => {
					const base64 = (reader.result as string).split(',')[1] ?? '';
					const res = await fetch(`${getApiBase()}/transcribe`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ audio: base64, filename: 'voice.webm' })
					});
					if (res.ok) {
						const data = (await res.json()) as { text: string };
						inputText += (inputText ? ' ' : '') + data.text;
					}
				};
				reader.readAsDataURL(blob);
			};

			recorder.start();
			recording = true;
			recordingSeconds = 0;
			recordingTimer = setInterval(() => { recordingSeconds++; }, 1000);
			mediaRecorder = recorder;
		} catch {
			addToast(t('chat.mic_unavailable'), 'error');
		}
	}

	// Standalone onboarding: check if API key is configured
	let hasApiKey = $state<boolean | null>(null);

	async function checkApiKey() {
		try {
			const res = await fetch(`${getApiBase()}/secrets`);
			const data = (await res.json()) as { names: string[] };
			hasApiKey = data.names.includes('ANTHROPIC_API_KEY');
		} catch {
			hasApiKey = null; // Engine not reachable
		}
	}

	$effect(() => { checkApiKey(); });

	const messages = $derived(getMessages());
	const isStreaming = $derived(getIsStreaming());
	const queueLength = $derived(getQueueLength());
	const pendingPermission = $derived(getPendingPermission());
	const chatError = $derived(getChatError());
	const ready = $derived(hasApiKey !== false);

	async function handleSend() {
		const task = inputText.trim();
		if ((!task && pendingFiles.length === 0) || !ready) return;
		const files = pendingFiles.length > 0 ? [...pendingFiles] : undefined;
		inputText = '';
		pendingFiles = [];
		if (textareaEl) textareaEl.style.height = 'auto';
		await sendMessage(task || t('chat.analyze_files'), files);
	}

	$effect(() => {
		if (messages.length > 0 && messagesEl) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
		if (e.key === 'Escape' && isStreaming) {
			abortRun();
		}
	}

	let toolCallsExpanded = $state(false);

	function toggleAllToolCalls() {
		toolCallsExpanded = !toolCallsExpanded;
		const details = document.querySelectorAll('.tool-call-details');
		details.forEach((d) => { (d as HTMLDetailsElement).open = toolCallsExpanded; });
	}

	const hasToolCalls = $derived(messages.some((m) => m.toolCalls && m.toolCalls.length > 0));

	function formatUsage(u: UsageInfo): string {
		const totalIn = u.tokensIn;
		const cachePct = totalIn > 0 ? Math.round((u.cacheRead / totalIn) * 100) : 0;
		const parts = [
			`${(totalIn + u.tokensOut).toLocaleString()} tokens`,
			`$${u.costUsd.toFixed(4)}`,
		];
		if (cachePct > 0) parts.push(`${cachePct}% cache`);
		return parts.join(' · ');
	}

	function autoResize(e: Event) {
		const el = e.target as HTMLTextAreaElement;
		el.style.height = 'auto';
		const maxH = 150;
		el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
		el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
	}
</script>

<div class="flex h-full flex-col">
	<!-- Messages -->
	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6" bind:this={messagesEl}>
		{#if messages.length === 0 && !isStreaming}
			<div class="flex h-full items-center justify-center">
				{#if hasApiKey === false}
					<div class="w-full max-w-md space-y-6 px-4 text-center">
						<h2 class="text-2xl font-light tracking-tight text-text mb-2">{t('onboard.welcome')}</h2>
						<p class="text-sm text-text-muted">{t('onboard.standalone_hint')}</p>
						<a
							href="/app/settings/keys"
							class="inline-block rounded-[var(--radius-sm)] bg-accent px-5 py-2.5 text-sm font-medium text-text hover:opacity-90 transition-opacity"
						>
							{t('onboard.go_to_keys')}
						</a>
						<p class="text-xs text-text-subtle">
							{t('onboard.api_key_hint')} <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">console.anthropic.com</a>
						</p>
					</div>
				{:else}
					<div class="text-center">
						<h2 class="text-2xl font-light tracking-tight text-text-muted mb-2">lynox</h2>
						<p class="text-sm text-text-subtle">{t('chat.welcome')}</p>
					</div>
				{/if}
			</div>
		{/if}

		<div class="mx-auto max-w-3xl space-y-5">
			{#each messages as msg}
				{#if msg.role === 'user'}
					<div class="flex justify-end">
						<div class="rounded-[var(--radius-md)] px-4 py-2.5 text-sm max-w-[80%] {msg.queued ? 'bg-bg-muted border border-border text-text-muted' : 'bg-accent/10 border border-accent/20'}">
							{msg.content}
							{#if msg.queued}
								<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle ml-2">{t('chat.queued')}</span>
							{/if}
						</div>
					</div>
				{:else}
					<div class="space-y-2">
						{#if msg.thinking}
							<details class="text-xs text-text-subtle">
								<summary class="cursor-pointer hover:text-text-muted font-mono uppercase tracking-widest text-[11px]">{t('chat.thinking_label')}</summary>
								<pre class="mt-2 whitespace-pre-wrap font-mono text-xs text-text-subtle/70 border-l-2 border-accent/20 pl-3">{maskText(msg.thinking ?? '')}</pre>
							</details>
						{/if}

						{#each msg.toolCalls ?? [] as tc}
							<details class="tool-call-details rounded-[var(--radius-md)] border border-border bg-bg-subtle text-sm group">
								<summary class="cursor-pointer px-3 py-2 text-text-muted hover:text-text flex items-center gap-2">
									<span class="inline-block h-1.5 w-1.5 rounded-full {tc.status === 'running' ? 'bg-warning animate-pulse' : tc.status === 'done' ? 'bg-success' : 'bg-danger'}"></span>
									<span class="font-mono text-xs text-accent-text">{tc.name}</span>
								</summary>
								<div class="border-t border-border px-3 py-2 space-y-1">
									<pre class="whitespace-pre-wrap font-mono text-xs text-text-subtle">{JSON.stringify(tc.input, null, 2)}</pre>
									{#if tc.result}
										<pre class="whitespace-pre-wrap font-mono text-xs text-text-muted mt-2 max-h-40 overflow-y-auto">{tc.result.slice(0, 2000)}</pre>
										{#if tc.result.length > 2000}
											<p class="text-xs text-text-subtle mt-1">[... {(tc.result.length - 2000).toLocaleString()} more chars]</p>
										{/if}
									{/if}
								</div>
							</details>
						{/each}

						{#if msg.content}
							<MarkdownRenderer content={msg.content} />
						{/if}
						{#if msg.usage && !isStreaming}
							<p class="text-[11px] font-mono text-text-subtle mt-1">{formatUsage(msg.usage)}</p>
						{/if}
					</div>
				{/if}
			{/each}

			{#if isStreaming}
				<div class="flex items-center gap-2 text-xs text-text-subtle">
					<span class="inline-block h-2 w-2 animate-pulse rounded-full bg-accent"></span>
					{t('chat.thinking')}
				</div>
			{/if}

			{#if hasToolCalls && !isStreaming}
				<button
					onclick={toggleAllToolCalls}
					class="text-xs text-text-subtle hover:text-text transition-colors font-mono uppercase tracking-widest"
				>
					{toolCallsExpanded ? t('chat.collapse_all') : t('chat.expand_all')}
				</button>
			{/if}

			{#if chatError}
				<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger flex items-center justify-between">
					<span>{chatError}</span>
					<button onclick={clearError} class="text-xs opacity-60 hover:opacity-100">{t('common.ok')}</button>
				</div>
			{/if}
		</div>
	</div>

	<!-- Permission prompt -->
	{#if pendingPermission}
		<div class="border-t border-border bg-bg-subtle px-4 py-3">
			<div class="max-w-3xl mx-auto flex items-center gap-3">
				<p class="flex-1 text-sm text-text-muted">{pendingPermission.question}</p>
				<button
					onclick={() => replyPermission('y')}
					class="rounded-[var(--radius-sm)] bg-success/15 border border-success/30 px-3 py-1.5 text-sm text-success hover:bg-success/25 transition-opacity"
				>
					{t('chat.allow')}
				</button>
				<button
					onclick={() => replyPermission('n')}
					class="rounded-[var(--radius-sm)] bg-danger/15 border border-danger/30 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 transition-opacity"
				>
					{t('chat.deny')}
				</button>
			</div>
		</div>
	{/if}

	<!-- Input -->
	<div class="border-t border-border bg-bg-subtle px-4 py-3 md:px-6 md:py-4">
		<!-- Pending files -->
		{#if pendingFiles.length > 0}
			<div class="max-w-3xl mx-auto flex flex-wrap gap-2 mb-2">
				{#each pendingFiles as file, i}
					<div class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs text-text-muted">
						<span class="truncate max-w-32">{file.name}</span>
						<button onclick={() => removeFile(i)} class="text-text-subtle hover:text-danger ml-1">x</button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="max-w-3xl mx-auto flex items-end gap-2">
			<!-- File upload -->
			<input bind:this={fileInputEl} type="file" multiple class="hidden" onchange={handleFiles} accept="image/*,.pdf,.txt,.md,.json,.csv,.ts,.js,.py,.html,.css" />
			<button
				onclick={() => fileInputEl.click()}
				disabled={!ready}
				class="shrink-0 rounded-[var(--radius-sm)] p-2.5 text-text-subtle hover:text-text disabled:opacity-30 transition-opacity"
				aria-label={t('chat.attach_file')}
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
				</svg>
			</button>

			<!-- Voice -->
			<button
				onclick={toggleVoice}
				disabled={!ready}
				class="shrink-0 rounded-[var(--radius-sm)] p-2.5 transition-opacity flex items-center gap-1 {recording ? 'text-danger animate-pulse' : 'text-text-subtle hover:text-text'} disabled:opacity-30"
				aria-label={t('chat.voice_input')}
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
				</svg>
				{#if recording}
					<span class="text-xs font-mono">{recordingSeconds}s</span>
				{/if}
			</button>

			<textarea
				bind:this={textareaEl}
				bind:value={inputText}
				onkeydown={handleKeydown}
				oninput={autoResize}
				placeholder={isStreaming ? t('chat.placeholder_streaming') : t('chat.placeholder')}
				rows="1"
				disabled={!ready}
				class="flex-1 resize-none rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5 text-sm text-text placeholder:text-text-subtle focus:border-border-hover outline-none disabled:opacity-50 overflow-hidden"
			></textarea>
			{#if isStreaming}
				<button
					onclick={() => abortRun()}
					class="shrink-0 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-2.5 text-sm text-danger hover:bg-danger/25 transition-opacity"
					title={t('chat.stop')}
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1" /></svg>
				</button>
			{/if}
			<button
				onclick={handleSend}
				disabled={(!inputText.trim() && pendingFiles.length === 0) || !ready}
				class="shrink-0 rounded-[var(--radius-sm)] bg-accent px-4 py-2.5 text-sm font-medium text-text hover:opacity-90 disabled:opacity-30 transition-opacity"
			>
				{isStreaming ? t('chat.queue') : t('chat.send')}
			</button>
		</div>
		<div class="mt-1.5 max-w-3xl mx-auto flex items-center justify-between">
			<p class="text-[11px] font-mono uppercase tracking-widest text-text-subtle">
				{isStreaming ? (queueLength > 0 ? `${queueLength} ${t('chat.hint_queued')}` : t('chat.hint_streaming')) : t('chat.hint')}
			</p>
			{#if queueLength > 0}
				<button onclick={cancelQueue} class="text-[11px] font-mono uppercase tracking-widest text-danger hover:text-danger/80 transition-colors">
					{t('chat.cancel_queue')}
				</button>
			{/if}
		</div>
	</div>
</div>
