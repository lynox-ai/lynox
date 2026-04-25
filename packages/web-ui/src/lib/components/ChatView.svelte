<script lang="ts">
	import {
		sendMessage,
		abortRun,
		replyPermission,
		replyPermissionTabs,
		postTabProgress,
		getPendingTabsPrompt,
		getMessages,
		pushPlaceholder,
		updatePlaceholder,
		removePlaceholder,
		getIsStreaming,
		getStreamingActivity,
		getStreamingToolName,
		getCompletedTextBlockGen,
		getCompletedTextBlock,
		getQueueLength,
		getPendingPermission,
		getPendingSecretPrompt,
		getSecretPromptGeneration,
		submitSecret,
		cancelSecret,
		getChatError,
		getChatErrorDetail,
		getRetryStatus,
		getIsOffline,
		clearError,
		cancelQueue,
		downloadExport,
		getSessionModel,
		getContextBudget,
		getContextWindow,
		getPendingChangeset,
		getChangesetLoading,
		submitChangesetReview,
		getSessionId,
		type FileAttachment,
		type UsageInfo,
		type ContextBudget,
		type ToolCallInfo,
	} from '../stores/chat.svelte.js';
	import { getSessionArtifacts, loadArtifacts } from '../stores/artifacts.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import { formatCost as fmtCost } from '../format.js';
	import { hasVoicePrefix, stripVoicePrefix, MIC_SVG_PATH } from '../utils/voice-prefix.js';
	import { getToolIcon } from '../utils/tool-icons.js';
	import { formatCountdown } from '../utils/time.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import ChangesetReview from './ChangesetReview.svelte';
	import PipelineProgress from './PipelineProgress.svelte';
	import { t, getLocale } from '../i18n.svelte.js';
	import { getTodaysQuote, getGreeting } from '../data/quotes.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { playSpeech, playSpeechQueued, stopSpeech, getSpeakState, isSpeakActive, maybeShowPrivacyHint, type SpeakError } from '../stores/speak.svelte.js';
	import { ensureVoiceInfoProbed, isTtsAvailable, getSttProvider } from '../stores/voice-info.svelte.js';
	import { isAutoSpeakEnabled } from '../stores/autospeak.svelte.js';
	import { goto, afterNavigate } from '$app/navigation';
	import { onMount, tick } from 'svelte';

	// Welcome screen state
	let displayName = $state('');

	// Onboarding chips (sequential steps — all 3 in one thread)
	const ONBOARDING_CHIPS = [
		{ key: 'chip_1', descKey: 'chip_1_desc' },
		{ key: 'chip_2', descKey: 'chip_2_desc' },
		{ key: 'chip_3', descKey: 'chip_3_desc' },
	] as const;

	// Agent context prefixes — tell the agent exactly what to do per step
	// Step 1: URL is collected in the UI, injected as {url} — no ask_user round-trip needed
	const ONBOARDING_CONTEXT = [
		`[ONBOARDING 1/3] The user's website is: {url} — scan it now. Use web_research and http_request to analyze it. Extract: company name, industry, positioning, target audience, tone of voice, key services/products, USPs. Save ALL findings with memory_store. Present a structured summary. Be fast and direct — no clarifying questions. Respond in {locale}.`,
		`[ONBOARDING 2/3] You already analyzed the user's website earlier in this conversation. Now use ask_user to ask 3-5 targeted questions about what the website doesn't reveal. Use the ask_user tool with the "questions" parameter to present all questions at once (each as a separate question with free-text input). Topics: revenue model & pricing, team size & capacity, biggest current challenge, 12-month growth goal, key metrics tracked. Save their answers to memory_store when they respond. IMPORTANT: If the user skips or dismisses questions (answers contain "__dismissed__"), accept that gracefully — save whatever answers you received and move on. Do NOT re-ask dismissed questions. Respond in {locale}.`,
		`[ONBOARDING 3/3] You analyzed the website and learned about the business earlier in this conversation. Now use web_research to find 3-5 competitors based on what you learned. Create an artifact (markdown comparison table) with: name, positioning, target audience, key differentiators, pricing (if public). Save competitive insights with memory_store. End with 2-3 concrete next steps the user could take. Respond in {locale}.`,
	];

	let onboardingStep = $state(0); // 0-based: which step is current
	let onboardingDismissed = $state(false);
	let pendingOnboardingAdvance = $state(false);
	let onboardingJustCompleted = $state(false);
	let showUrlInput = $state(false); // Step 1: collect URL in UI before LLM call
	let onboardingUrl = $state('');

	function loadOnboardingState() {
		if (typeof localStorage === 'undefined') return;
		const saved = localStorage.getItem('lynox-onboarding-step');
		if (saved === 'done') { onboardingDismissed = true; return; }
		if (saved) onboardingStep = Math.min(parseInt(saved, 10), ONBOARDING_CHIPS.length);
	}

	function advanceOnboarding() {
		const next = onboardingStep + 1;
		if (next >= ONBOARDING_CHIPS.length) {
			onboardingDismissed = true;
			onboardingJustCompleted = true;
			localStorage.setItem('lynox-onboarding-step', 'done');
		} else {
			onboardingStep = next;
			localStorage.setItem('lynox-onboarding-step', String(next));
		}
	}

	function skipOnboarding() {
		onboardingDismissed = true;
		localStorage.setItem('lynox-onboarding-step', 'done');
	}

	function handleChipClick(idx: number) {
		if (idx !== onboardingStep) return;
		// Step 1: show URL input instead of sending immediately
		if (idx === 0) { showUrlInput = true; return; }
		sendOnboardingStep(idx);
	}

	function sendOnboardingStep(idx: number, url?: string) {
		const chip = ONBOARDING_CHIPS[idx];
		if (!chip) return;
		const locale = getLocale() === 'de' ? 'German' : 'English';
		let context = ONBOARDING_CONTEXT[idx]?.replace('{locale}', locale) ?? '';
		if (url) context = context.replace('{url}', url);
		const prompt = t(`onboard.${chip.key}` as 'onboard.chip_1');
		pendingOnboardingAdvance = true;
		// Onboarding instructions are explicit — use low effort, no thinking
		sendMessage(context ? `${context}\n\n${prompt}` : prompt, prompt, undefined, { effort: 'low', thinking: 'disabled' });
	}

	function submitOnboardingUrl() {
		const url = onboardingUrl.trim();
		if (!url) return;
		showUrlInput = false;
		onboardingUrl = '';
		sendOnboardingStep(0, url);
	}

	const showOnboarding = $derived(
		!onboardingDismissed && onboardingStep < ONBOARDING_CHIPS.length
	);

	// showInlineChip is computed in the template (depends on messages/isStreaming declared later)

	// Vault key checkpoint — blocking modal after onboarding or first chat
	let securityLoadTriggered = false;
	let showVaultCheckpoint = $state(false);
	let vaultCheckpointKey = $state<string | null>(null);
	let vaultCheckpointRevealed = $state(false);
	let vaultCheckpointCopied = $state(false);

	async function loadSecurityState() {
		if (typeof localStorage === 'undefined') return;
		if (localStorage.getItem('lynox-vault-checkpoint')) return;

		// Skip blocking modal for managed instances — vault is server-managed
		try {
			const cfgRes = await fetch(`${getApiBase()}/config`);
			if (cfgRes.ok) {
				const cfg = (await cfgRes.json()) as Record<string, unknown>;
				if (cfg['managed']) {
					localStorage.setItem('lynox-vault-checkpoint', '1');
					return;
				}
			}
		} catch { /* non-critical */ }

		try {
			const res = await fetch(`${getApiBase()}/vault/key?reveal=true`);
			if (!res.ok) return;
			const data = (await res.json()) as { configured: boolean; key?: string };
			if (data.configured && data.key) {
				vaultCheckpointKey = data.key;
				showVaultCheckpoint = true;
			}
		} catch { /* ignore — older engine */ }
	}

	function maskCheckpointKey(key: string): string {
		if (key.length <= 8) return '••••••••';
		return key.slice(0, 4) + '••••••••' + key.slice(-4);
	}

	async function copyCheckpointKey() {
		if (!vaultCheckpointKey) return;
		await navigator.clipboard.writeText(vaultCheckpointKey);
		vaultCheckpointCopied = true;
		setTimeout(() => (vaultCheckpointCopied = false), 2000);
	}

	function confirmVaultCheckpoint() {
		showVaultCheckpoint = false;
		vaultCheckpointKey = null;
		localStorage.setItem('lynox-vault-checkpoint', '1');
		addToast(t('onboard.vault_confirmed'), 'success');
	}

	// Defer vault checkpoint until onboarding is complete or skipped
	$effect(() => {
		if (messages.length > 0 && !securityLoadTriggered && (onboardingDismissed || !showOnboarding)) {
			securityLoadTriggered = true;
			void loadSecurityState();
		}
	});

	// Advance onboarding step when streaming ends successfully (not on click, not on error)
	$effect(() => {
		if (pendingOnboardingAdvance && !isStreaming && messages.length > 0) {
			const hasError = !!getChatError();
			const lastMsg = messages[messages.length - 1];
			const lastFailed = lastMsg?.role === 'user' && lastMsg.failed;
			if (hasError || lastFailed) {
				// Error occurred — don't advance, let user retry
				pendingOnboardingAdvance = false;
			} else {
				pendingOnboardingAdvance = false;
				advanceOnboarding();
			}
		}
	});

	async function loadDisplayName() {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (res.ok) {
				const data = (await res.json()) as Record<string, unknown>;
				if (typeof data['display_name'] === 'string' && data['display_name']) {
					displayName = data['display_name'];
				}
			}
		} catch { /* non-critical */ }
	}

	onMount(() => { void loadDisplayName(); loadOnboardingState(); });

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

	/** Tool calls hidden from inline display (truly redundant or noisy) */
	const HIDDEN_TOOLS = new Set(['artifact_list', 'data_store_list']);
	/** Tool calls that get special rendering (not grouped with regular tools) */
	const SPECIAL_TOOLS = new Set(['plan_task', 'step_complete']);

	/** Tool call label: returns { action, subject } or null if hidden */
	function toolCallLabel(tc: ToolCallInfo): { action: string; subject: string } | null {
		if (HIDDEN_TOOLS.has(tc.name)) return null;
		const inp = tc.input as Record<string, unknown> | undefined;
		switch (tc.name) {
			case 'data_store_query': return { action: t('tool.data_queried'), subject: String(inp?.['collection'] ?? '') };
			case 'data_store_insert': return { action: t('tool.data_stored'), subject: String(inp?.['collection'] ?? '') };
			case 'data_store_create': return { action: t('tool.table_created'), subject: String(inp?.['collection'] ?? '') };
			case 'memory_store': return { action: t('tool.remembered'), subject: String(inp?.['content'] ?? '').slice(0, 50) };
			case 'memory_recall': return { action: t('tool.knowledge_recalled'), subject: String(inp?.['query'] ?? '') };
			case 'memory_update': return { action: t('tool.knowledge_updated'), subject: '' };
			case 'write_file': return { action: t('tool.file_written'), subject: String(inp?.['path'] ?? '').split('/').pop() ?? '' };
			case 'read_file': return { action: t('tool.file_read'), subject: String(inp?.['path'] ?? '').split('/').pop() ?? '' };
			case 'bash': return { action: t('tool.command'), subject: String(inp?.['command'] ?? '').slice(0, 60) };
			case 'http_request': return { action: t('tool.api_request'), subject: `${String(inp?.['method'] ?? 'GET')} ${String(inp?.['url'] ?? '')}` };
			case 'web_research': return { action: t('tool.web_search'), subject: String(inp?.['query'] ?? '') };
			case 'run_pipeline': return { action: t('tool.pipeline'), subject: String(inp?.['name'] ?? '') };
			case 'spawn_agent': return { action: t('tool.delegated'), subject: String(inp?.['task'] ?? '').slice(0, 50) };
			case 'artifact_save': return { action: t('tool.artifact_saved'), subject: String(inp?.['title'] ?? '') };
			case 'task_create': return { action: t('tool.task_created'), subject: String(inp?.['title'] ?? '') };
			default: return { action: tc.name, subject: '' };
		}
	}

	type GroupedBlock =
		| { type: 'text'; text: string }
		| { type: 'tools'; action: string; subjects: string[]; toolName: string }
		| { type: 'plan'; summary: string; phases: Array<{ name: string; steps: string[] }> }
		| { type: 'step_done'; stepId: string; summary: string };

	/** Group consecutive tool calls with same action, extract plan + step blocks */
	function groupedToolCalls(blocks: import('../stores/chat.svelte.js').ContentBlock[], toolCalls: ToolCallInfo[]): GroupedBlock[] {
		const result: GroupedBlock[] = [];

		// Check if agent already included an artifact inline in text
		const hasInlineArtifact = blocks.some(b =>
			b.type === 'text' && b.text &&
			(b.text.includes('```artifact') ||
			 (b.text.includes('```html') && (b.text.includes('<!DOCTYPE') || b.text.includes('<html'))))
		);

		for (const block of blocks) {
			if (block.type === 'text' && block.text) {
				result.push({ type: 'text', text: block.text });
			} else if (block.type === 'tool_call') {
				const tc = toolCalls[block.index];
				if (!tc) continue;
				if (HIDDEN_TOOLS.has(tc.name)) continue;

				// Special: artifact_save → render inline if not already in text.
				// All artifact types route through the ```artifact fence so they
				// share container chrome (toolbar + label). MarkdownRenderer
				// dispatches by detecting a `<!-- type: markdown -->` marker in
				// the fence body: markdown-typed content renders as inline prose
				// inside the container (no iframe — content is trusted prose);
				// HTML/SVG/Mermaid wrap into a sandboxed iframe via buildArtifact.
				if (tc.name === 'artifact_save') {
					if (!hasInlineArtifact) {
						const inp = tc.input as Record<string, unknown> | undefined;
						const content = String(inp?.['content'] ?? '');
						if (content) {
							const title = String(inp?.['title'] ?? 'Artifact');
							const artifactType = typeof inp?.['type'] === 'string' ? inp['type'] as string : 'html';
							if (artifactType === 'markdown') {
								result.push({
									type: 'text',
									text: `\`\`\`artifact\n<!-- title: ${title} -->\n<!-- type: markdown -->\n${content}\n\`\`\``,
								});
							} else {
								result.push({ type: 'text', text: `\`\`\`artifact\n<!-- title: ${title} -->\n${content}\n\`\`\`` });
							}
						}
					}
					continue;
				}

				// Special: plan_task → collapsible plan
				if (tc.name === 'plan_task') {
					const inp = tc.input as Record<string, unknown> | undefined;
					const summary = String(inp?.['summary'] ?? '');
					const rawPhases = (inp?.['phases'] ?? []) as Array<{ name: string; steps?: string[] }>;
					const phases = rawPhases.map(p => ({ name: p.name, steps: p.steps ?? [] }));
					result.push({ type: 'plan', summary, phases });
					continue;
				}

				// Special: step_complete → step done marker
				if (tc.name === 'step_complete') {
					const inp = tc.input as Record<string, unknown> | undefined;
					result.push({
						type: 'step_done',
						stepId: String(inp?.['step_id'] ?? ''),
						summary: String(inp?.['summary'] ?? ''),
					});
					continue;
				}

				// Regular tool call — group by action, dedup subjects
				const label = toolCallLabel(tc);
				if (!label) continue;
				const last = result[result.length - 1];
				if (last && last.type === 'tools' && last.action === label.action) {
					if (label.subject && !last.subjects.includes(label.subject)) last.subjects.push(label.subject);
				} else {
					result.push({ type: 'tools', action: label.action, subjects: label.subject ? [label.subject] : [], toolName: tc.name });
				}
			}
		}
		return result;
	}

	let inputText = $state('');
	let messagesEl: HTMLDivElement;
	let textareaEl = $state<HTMLTextAreaElement>();
	let fileInputEl: HTMLInputElement;
	let pendingFiles = $state<FileAttachment[]>([]);
	let recording = $state(false);
	let promptAnswer = $state('');
	let selectedOptions = $state<string[]>([]);
	let answeredPrompts = $state<{ question: string; answer: string }[]>([]);

	// Prompt timeout countdown
	let promptSecondsLeft = $state<number | null>(null);
	$effect(() => {
		const p = pendingPermission;
		if (!p?.timeoutMs || !p.receivedAt) { promptSecondsLeft = null; return; }
		const update = () => {
			const elapsed = Date.now() - p.receivedAt!;
			const left = Math.max(0, Math.ceil((p.timeoutMs! - elapsed) / 1000));
			promptSecondsLeft = left;
		};
		update();
		const timer = setInterval(update, 1000);
		return () => clearInterval(timer);
	});

	// Secret prompt state
	let secretValue = $state('');
	let secretConsented = $state(false);
	let secretInputEl = $state<HTMLInputElement>();

	const secretGeneration = $derived(getSecretPromptGeneration());

	// Reset secret UI state when a new prompt arrives (e.g. retry after cancel)
	$effect(() => {
		void secretGeneration; // track
		secretValue = '';
		secretConsented = false;
	});

	// Auto-focus password input when consent is given
	$effect(() => {
		if (secretConsented && secretInputEl) {
			requestAnimationFrame(() => secretInputEl?.focus());
		}
	});

	// Common secret patterns for chat input guard
	const SECRET_INPUT_PATTERNS = [
		/\bsk-ant-[A-Za-z0-9_-]{20,}/,
		/\bsk-[A-Za-z0-9]{20,}/,
		/\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/,
		/\b(ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/,
		/\bAKIA[A-Z0-9]{16}/,
		/\bAIza[A-Za-z0-9_-]{35}/,
		/\bxox[bpras]-[A-Za-z0-9-]{10,}/,
	];

	function looksLikeSecret(text: string): boolean {
		return SECRET_INPUT_PATTERNS.some(p => p.test(text));
	}

	async function handleSecretSave() {
		if (!pendingSecret || !secretValue.trim()) return;
		const ok = await submitSecret(pendingSecret.name, secretValue.trim());
		if (ok) {
			addToast(t('chat.secret_saved'), 'success', 3000);
		} else {
			addToast('Failed to store secret. Check vault configuration.', 'error', 5000);
		}
		secretValue = '';
		secretConsented = false;
	}

	function handleSecretCancel() {
		cancelSecret();
		secretValue = '';
		secretConsented = false;
	}

	// Multi-question batch mode: collect all answers before sending.
	// Two sources feed this UI:
	//   v2 (protocol=2): server sends a single `prompt_tabs` SSE event →
	//        pendingTabsPrompt is populated, `submitBatch` resolves the whole
	//        batch in ONE reply via /reply-tabs.
	//   v1 (legacy): server sends N sequential `prompt` events for one
	//        multi-question ask_user → we sniff the tool_call's `questions`
	//        array, collect answers locally, reply sequentially with
	//        waitForNextPrompt between replies.
	interface BatchQuestion { question: string; options: string[]; header?: string; }
	let batchQuestions = $state<BatchQuestion[]>([]);
	let batchAnswers = $state<string[]>([]);
	let batchSelections = $state<string[][]>([]);
	let batchFocusIdx = $state(0);
	let inBatchMode = $state(false);
	let batchMode = $state<'v1' | 'v2' | null>(null);
	let batchTabsPromptId = $state<string | null>(null);
	let batchFreetext = $state('');
	let recordingSeconds = $state(0);
	let recordingTimer: ReturnType<typeof setInterval> | null = null;
	let transcribing = $state(false);
	// Voice capabilities come from the shared voice-info store so StatusBar
	// (auto-speak toggle) and ChatView (speaker button, privacy hint) stay in
	// lockstep without duplicating the /api/voice/info probe.
	void ensureVoiceInfoProbed();
	const transcribeProvider = $derived(getSttProvider());
	const ttsAvailable = $derived(isTtsAvailable());

	const voicePrivacyKey = $derived(
		transcribeProvider === 'mistral-voxtral' ? 'chat.voice_privacy_hint'
		: transcribeProvider === 'whisper-cpp' ? 'chat.voice_privacy_hint_local'
		: null,
	);

	const pendingChangeset = $derived(getPendingChangeset());
	const changesetLoading = $derived(getChangesetLoading());

	const UNSUPPORTED_FORMATS = new Set(['image/heic', 'image/heif']);

	function addFile(file: File) {
		// HEIC/HEIF can't be decoded by most browsers
		const lowerName = file.name.toLowerCase();
		if (UNSUPPORTED_FORMATS.has(file.type) || lowerName.endsWith('.heic') || lowerName.endsWith('.heif')) {
			addToast('HEIC/HEIF nicht unterstützt. Bitte als JPEG oder PNG exportieren.', 'error', 5000);
			return;
		}

		const needsConvert = file.type.startsWith('image/') && !SUPPORTED_IMAGE_TYPES.has(file.type);
		if (needsConvert || file.type.startsWith('image/')) {
			// Convert all images via Canvas (ensures compatible format)
			const img = new Image();
			const url = URL.createObjectURL(file);
			img.onload = () => {
				const canvas = document.createElement('canvas');
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				canvas.getContext('2d')!.drawImage(img, 0, 0);
				const outType = SUPPORTED_IMAGE_TYPES.has(file.type) ? file.type : 'image/png';
				const dataUrl = canvas.toDataURL(outType);
				const base64 = dataUrl.split(',')[1] ?? '';
				const ext = outType.split('/')[1] ?? 'png';
				pendingFiles = [...pendingFiles, { name: file.name.replace(/\.\w+$/, `.${ext}`), type: outType, data: base64 }];
				URL.revokeObjectURL(url);
			};
			img.onerror = () => { URL.revokeObjectURL(url); addToast(t('common.error'), 'error'); };
			img.src = url;
		} else {
			const reader = new FileReader();
			reader.onload = () => {
				const base64 = (reader.result as string).split(',')[1] ?? '';
				pendingFiles = [...pendingFiles, { name: file.name, type: file.type, data: base64 }];
			};
			reader.readAsDataURL(file);
		}
	}

	function handleFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files) return;
		for (const file of input.files) {
			addFile(file);
		}
		input.value = '';
	}

	function removeFile(idx: number) {
		pendingFiles = pendingFiles.filter((_, i) => i !== idx);
	}

	let mediaRecorder: MediaRecorder | null = null;
	let audioAnalyser: AnalyserNode | null = null;
	let waveformBars = $state<number[]>(new Array(24).fill(3));
	let waveformRaf: number | null = null;
	let recordingDiscarded = false;
	let activeAudioCtx: AudioContext | null = null;
	let activeStream: MediaStream | null = null;
	let recordingStartedByTouch = false;

	function updateWaveform() {
		if (!audioAnalyser || !recording) return;
		const data = new Uint8Array(audioAnalyser.frequencyBinCount);
		audioAnalyser.getByteFrequencyData(data);
		const step = Math.floor(data.length / 24);
		const bars: number[] = [];
		for (let i = 0; i < 24; i++) {
			const val = data[i * step] ?? 0;
			bars.push(Math.max(3, Math.round((val / 255) * 28)));
		}
		waveformBars = bars;
		waveformRaf = requestAnimationFrame(updateWaveform);
	}

	function cleanupRecording() {
		recording = false;
		recordingSeconds = 0;
		if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
		if (waveformRaf) { cancelAnimationFrame(waveformRaf); waveformRaf = null; }
		audioAnalyser = null;
		if (activeAudioCtx) { void activeAudioCtx.close(); activeAudioCtx = null; }
		if (activeStream) { activeStream.getTracks().forEach((track) => track.stop()); activeStream = null; }
		mediaRecorder = null;
		waveformBars = new Array(24).fill(3);
	}

	async function startRecording() {
		if (recording) return;
		recordingDiscarded = false;
		try {
			if (!navigator.mediaDevices?.getUserMedia) {
				addToast(t('chat.mic_requires_https'), 'error');
				return;
			}
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			activeStream = stream;

			const audioCtx = new AudioContext();
			activeAudioCtx = audioCtx;
			const source = audioCtx.createMediaStreamSource(stream);
			const analyser = audioCtx.createAnalyser();
			analyser.fftSize = 128;
			source.connect(analyser);
			audioAnalyser = analyser;

			const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
				: MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
				: '';
			const recorder = mimeType
				? new MediaRecorder(stream, { mimeType })
				: new MediaRecorder(stream);
			const actualMime = recorder.mimeType || 'audio/webm';
			const ext = actualMime.includes('mp4') ? 'mp4' : actualMime.includes('aac') ? 'aac' : 'webm';
			const chunks: Blob[] = [];

			recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
			recorder.onstop = async () => {
				const discarded = recordingDiscarded;
				cleanupRecording();
				if (discarded) return;

				// Show placeholder bubble immediately with live transcription
				const placeholderIdx = pushPlaceholder(`🎤 ${t('chat.voice_processing')}`);

				const blob = new Blob(chunks, { type: actualMime });
				const reader = new FileReader();
				reader.onload = async () => {
					const base64 = (reader.result as string).split(',')[1] ?? '';
					try {
						const res = await fetch(`${getApiBase()}/transcribe`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ audio: base64, filename: `voice.${ext}`, language: getLocale() })
						});

						if (!res.ok || !res.body) {
							removePlaceholder(placeholderIdx);
							if (res.status === 503) addToast(t('chat.whisper_unavailable'), 'error');
							else addToast(t('chat.transcribe_failed'), 'error');
							return;
						}

						// Read SSE stream — show segments live in the bubble
						const sseReader = res.body.getReader();
						const decoder = new TextDecoder();
						let finalText = '';
						let segments: string[] = [];
						let sseBuffer = '';

						while (true) {
							const { done: streamDone, value } = await sseReader.read();
							if (streamDone) break;
							sseBuffer += decoder.decode(value, { stream: true });
							const lines = sseBuffer.split('\n');
							sseBuffer = lines.pop() ?? '';
							for (const line of lines) {
								if (!line.startsWith('data: ')) continue;
								const data = JSON.parse(line.slice(6)) as { status?: string; segment?: string; done?: boolean; text?: string; error?: string };
								if (data.status === 'transcribing') {
									updatePlaceholder(placeholderIdx, `🎤 ${t('chat.transcribing')}`);
								} else if (data.segment) {
									segments.push(data.segment);
									updatePlaceholder(placeholderIdx, `🎤 ${segments.join(' ')}`);
								} else if (data.done && data.text) {
									finalText = data.text;
								} else if (data.error) {
									removePlaceholder(placeholderIdx);
									addToast(t('chat.transcribe_failed'), 'error');
									return;
								}
							}
						}

						// Replace placeholder with final text and send to AI
						removePlaceholder(placeholderIdx);
						if (finalText.trim()) {
							await sendMessage(`🎤 ${finalText.trim()}`);
						}
					} catch {
						removePlaceholder(placeholderIdx);
						addToast(t('chat.transcribe_failed'), 'error');
					}
				};
				reader.readAsDataURL(blob);
			};

			recorder.start();
			recording = true;
			recordingSeconds = 0;
			recordingTimer = setInterval(() => { recordingSeconds++; }, 1000);
			mediaRecorder = recorder;
			waveformRaf = requestAnimationFrame(updateWaveform);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'NotAllowedError') {
				addToast(t('chat.mic_denied'), 'error');
			} else {
				addToast(t('chat.mic_unavailable'), 'error');
			}
		}
	}

	function stopRecording() {
		if (!recording || !mediaRecorder) return;
		mediaRecorder.stop();
	}

	function discardRecording() {
		if (!recording || !mediaRecorder) return;
		recordingDiscarded = true;
		mediaRecorder.stop();
	}

	// Standalone onboarding: check if LLM provider is configured
	let hasApiKey = $state<boolean | null>(null);
	let activeProvider = $state<string>('anthropic');
	let setupKey = $state('');
	let setupSaving = $state(false);
	let justCompleted = $state(false);

	async function checkApiKey() {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			const data = (await res.json()) as { provider?: string; configured: Record<string, boolean> };
			activeProvider = data.provider ?? 'anthropic';
			hasApiKey = data.configured['api_key'] ?? false;
		} catch {
			hasApiKey = null; // Engine not reachable
		}
	}

	async function saveInlineKey() {
		if (!setupKey.trim()) return;
		if (!setupKey.trim().startsWith('sk-ant-')) {
			addToast(t('onboard.api_key_format'), 'error', 4000);
			return;
		}
		setupSaving = true;
		try {
			await fetch(`${getApiBase()}/secrets/ANTHROPIC_API_KEY`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: setupKey })
			});
			setupKey = '';
			hasApiKey = true;
			justCompleted = true;
			addToast(t('onboard.key_saved'), 'success');
			setTimeout(() => { justCompleted = false; }, 5000);
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		setupSaving = false;
	}

	function answerPrompt(answer: string) {
		// Batch mode handles both v1 (sequential) and v2 (tabs). The v2 path
		// has no pendingPermission — it has pendingTabsPrompt instead — so we
		// must NOT early-return on !pendingPermission in batch mode.
		if (inBatchMode) {
			batchAnswers[batchFocusIdx] = answer;
			batchAnswers = [...batchAnswers]; // trigger reactivity
			selectedOptions = [];

			// v2: persist partial progress so a reconnect restores the batch.
			if (batchMode === 'v2' && batchTabsPromptId) {
				postTabProgress(batchTabsPromptId, batchAnswers.map(a => a || null));
			}

			// Find next unanswered
			const nextEmpty = batchAnswers.findIndex((a, i) => i > batchFocusIdx && !a);
			if (nextEmpty !== -1) {
				batchFocusIdx = nextEmpty;
			} else {
				// All answered — check if any still empty
				const firstEmpty = batchAnswers.findIndex(a => !a);
				if (firstEmpty !== -1) {
					batchFocusIdx = firstEmpty;
				} else {
					// All filled — submit all
					submitBatch();
				}
			}
			return;
		}

		// Single-question path: requires pendingPermission.
		if (!pendingPermission) return;
		// Keep only the last answer — back-to-back prompts during one run
		// were stacking the entire decision history above the active prompt
		// and pushing the chat off-screen. Users only need the last answer
		// to reconsider via the "edit" button below.
		answeredPrompts = [{ question: pendingPermission.question, answer }];
		selectedOptions = [];
		promptAnswer = '';
		replyPermission(answer);
	}

	async function submitBatch() {
		// v2: one-shot reply. Engine's promptTabs resolves with the whole array.
		if (batchMode === 'v2' && batchTabsPromptId) {
			await replyPermissionTabs(batchAnswers.map(a => a || '__dismissed__'));
			resetBatch();
			return;
		}
		// v1 legacy fallback: Engine's ask-user.ts loops through `questions` and
		// calls promptUser once per question — each with its own promptId. We
		// reply then wait for the NEXT promptId via SSE before sending the next
		// answer. Fixed timing (setTimeout) raced on slow connections; the
		// observer approach below removes that race for legacy engines.
		for (let idx = 0; idx < batchAnswers.length; idx++) {
			const prevPromptId = getPendingPermission()?.promptId;
			replyPermission(batchAnswers[idx]!);
			if (idx + 1 < batchAnswers.length) {
				const arrived = await waitForNextPrompt(prevPromptId);
				if (!arrived) break; // tool errored or completed early — stop sending
			}
		}
		resetBatch();
	}

	function resetBatch(): void {
		inBatchMode = false;
		batchMode = null;
		batchTabsPromptId = null;
		batchQuestions = [];
		batchAnswers = [];
		batchSelections = [];
		batchFocusIdx = 0;
		lastBatchToolId = '';
	}

	/** Resolve true once pendingPermission carries a new promptId, or false on timeout. */
	async function waitForNextPrompt(prevPromptId: string | undefined, timeoutMs = 15_000): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const cur = getPendingPermission();
			if (cur && cur.promptId !== prevPromptId) return true;
			await new Promise(r => setTimeout(r, 50));
		}
		return false;
	}

	// v1 fallback: detect multi-question ask_user from tool_call input
	let lastBatchToolId = $state('');

	// v2 path: server sends a single `prompt_tabs` SSE event. This effect
	// observes pendingTabsPrompt and enters batch mode authoritatively (no
	// sniffing). Wins over v1 if both signals arrive.
	$effect(() => {
		const tabs = pendingTabsPrompt;
		if (!tabs) {
			if (batchMode === 'v2') resetBatch();
			return;
		}
		if (batchMode === 'v2' && batchTabsPromptId === tabs.promptId) return;
		batchQuestions = tabs.questions.map(q => ({
			question: q.question,
			options: (q.options ?? []).filter((o: string) => o !== '\x00'),
			header: q.header,
		}));
		// Restore partial answers if the server had any (reconnect mid-batch).
		const partial = tabs.partialAnswers ?? [];
		batchAnswers = tabs.questions.map((_q, i) => partial[i] ?? '');
		batchSelections = tabs.questions.map(() => [] as string[]);
		batchFocusIdx = batchAnswers.findIndex(a => !a);
		if (batchFocusIdx < 0) batchFocusIdx = 0;
		batchMode = 'v2';
		batchTabsPromptId = tabs.promptId;
		inBatchMode = true;
	});

	// v1 fallback: sniff tool_call.input.questions when pendingPermission is set
	// and no v2 tabs prompt is active.
	$effect(() => {
		if (pendingTabsPrompt) return; // v2 path owns it
		if (!pendingPermission) {
			if (!isStreaming && inBatchMode && batchMode === 'v1') resetBatch();
			return;
		}
		const lastMsg = messages[messages.length - 1];
		if (!lastMsg?.toolCalls) return;
		const askUserTc = lastMsg.toolCalls.findLast(tc => tc.name === 'ask_user' && tc.status === 'running');
		if (!askUserTc) return;

		// Check if this is a NEW ask_user (different from the one we already batched)
		const tcId = JSON.stringify(askUserTc.input).slice(0, 100);
		if (inBatchMode && tcId === lastBatchToolId) return; // same batch, skip

		const input = askUserTc.input as Record<string, unknown> | null;
		const questions = input?.['questions'] as BatchQuestion[] | undefined;
		if (questions && questions.length > 1) {
			batchQuestions = questions.map(q => ({
				question: q.question,
				options: (q.options ?? []).filter((o: string) => o !== '\x00'),
				header: q.header,
			}));
			batchAnswers = new Array(questions.length).fill('');
			batchSelections = questions.map(() => [] as string[]);
			batchFocusIdx = 0;
			inBatchMode = true;
			batchMode = 'v1';
			lastBatchToolId = tcId;
		}
	});

	const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.kind === 'file') {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) continue;
				// Use addFile which handles image conversion
				const name = file.name || `paste-${Date.now()}.${file.type.split('/')[1] ?? 'png'}`;
				addFile(new File([file], name, { type: file.type }));
			}
		}
	}


	$effect(() => { checkApiKey(); });

	// Clear answered stack when streaming fully ends (not between sequential prompts)
	$effect(() => { if (!isStreaming && !pendingPermission && answeredPrompts.length > 0) answeredPrompts = []; });

	const messages = $derived(getMessages());
	const isStreaming = $derived(getIsStreaming());
	const streamActivity = $derived(getStreamingActivity());
	const streamToolName = $derived(getStreamingToolName());

	// Auto-speak per text-block. The chat store bumps `completedTextBlockGen`
	// every time the assistant closes a text block — either because a tool
	// call interrupts the writing or the turn ends. We pick that up here and
	// enqueue the block via `playSpeechQueued`, which chains playbacks via
	// `audio.onended` so block-N speaks while the model is still writing
	// block-(N+1). The first block's TTS request fires within ~100 ms of the
	// model starting the next tool call, so the user hears something almost
	// immediately instead of waiting for the whole turn to finish.
	const completedBlockGen = $derived(getCompletedTextBlockGen());
	let prevCompletedGen = 0;
	$effect(() => {
		const gen = completedBlockGen;
		if (gen <= prevCompletedGen) return;
		prevCompletedGen = gen;
		if (!ttsAvailable || !isAutoSpeakEnabled()) return;
		const block = getCompletedTextBlock();
		if (!block.content.trim()) return;
		maybeShowPrivacyHint(t('chat.tts_privacy_hint'));
		void playSpeechQueued(block.content, block.key).then((err) => {
			if (err) addToast(formatSpeakError(err), 'error');
		});
	});

	// Translate the SpeakError discriminator into a user-facing string. Lives
	// here (not in the speak store) so the speak store stays free of i18n
	// concerns and so the toast text stays in the same module as `addToast`.
	function formatSpeakError(err: SpeakError): string {
		switch (err.code) {
			case 'unavailable': return t('chat.speak_failed_unavailable');
			case 'too_long':    return t('chat.speak_failed_too_long');
			case 'http':        return `${t('chat.speak_failed_http')} ${String(err.status)}`;
			case 'network':     return t('chat.speak_failed_network');
			case 'stream':      return t('chat.speak_failed_stream');
			case 'synth':       return t('chat.speak_failed_synth');
			case 'empty':       return t('chat.speak_failed_empty');
			case 'blocked':     return t('chat.speak_failed_blocked');
		}
	}

	// Double-tap the modifier key (⌘ on macOS, Ctrl on Win/Linux) to toggle
	// voice recording — Raycast/Spotlight-style, zero collision with any
	// other shortcut because the modifier alone is never bound to anything.
	//
	// Detection rule: two bare modifier presses within 350 ms without any
	// other key pressed in between. "Bare" means we saw the keydown + keyup
	// of the modifier with no intervening keydown of another key — that
	// filters out normal chord usage like ⌘K, where the modifier goes down
	// first but is followed by another key.
	$effect(() => {
		const TAP_WINDOW_MS = 350;
		let lastTap = 0;
		let heldModifier: 'Meta' | 'Control' | null = null;
		let chordBroken = false;

		function onKeyDown(e: KeyboardEvent): void {
			if (e.key === 'Meta' || e.key === 'Control') {
				if (heldModifier === null) {
					heldModifier = e.key;
					chordBroken = false;
				}
				return;
			}
			if (heldModifier !== null) chordBroken = true;
		}

		function onKeyUp(e: KeyboardEvent): void {
			if (e.key !== 'Meta' && e.key !== 'Control') return;
			if (heldModifier !== e.key) return;
			const wasBareTap = !chordBroken;
			heldModifier = null;
			chordBroken = false;
			if (!wasBareTap) { lastTap = 0; return; }

			const now = Date.now();
			if (now - lastTap < TAP_WINDOW_MS) {
				lastTap = 0;
				if (recording) stopRecording();
				else void startRecording();
			} else {
				lastTap = now;
			}
		}

		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
		};
	});
	const streamingLabel = $derived.by(() => {
		if (!isStreaming) return '';
		if (streamActivity === 'writing') return t('chat.activity.writing');
		if (streamActivity === 'thinking') return t('chat.activity.thinking');
		if (streamActivity === 'tool' && streamToolName) {
			// Try specific tool label, fall back to generic "Arbeitet..."
			const toolLabels: Record<string, string> = {
				memory_recall: t('chat.activity.tool.memory_recall'),
				memory_store: t('chat.activity.tool.memory_store'),
				http_request: t('chat.activity.tool.http_request'),
				web_search: t('chat.activity.tool.web_search'),
				artifact_save: t('chat.activity.tool.artifact_save'),
				ask_user: t('chat.activity.tool.ask_user'),
				bash: t('chat.activity.tool.bash'),
				task_list: t('chat.activity.tool.task_list'),
				send_email: t('chat.activity.tool.send_email'),
				read_email: t('chat.activity.tool.read_email'),
				calendar: t('chat.activity.tool.calendar'),
			};
			return toolLabels[streamToolName] ?? t('chat.activity.tool.default');
		}
		return t('chat.thinking');
	});
	const queueLength = $derived(getQueueLength());
	const pendingPermission = $derived(getPendingPermission());
	const pendingTabsPrompt = $derived(getPendingTabsPrompt());
	const pendingSecret = $derived(getPendingSecretPrompt());
	const chatError = $derived(getChatError());
	const chatErrorDetail = $derived(getChatErrorDetail());
	const retryStatus = $derived(getRetryStatus());
	const isOffline = $derived(getIsOffline());
	const ready = $derived(hasApiKey !== false);
	const ctxModel = $derived(getSessionModel());
	const ctxBudget = $derived(getContextBudget());
	const ctxWindow = $derived(getContextWindow());

	// Active pipeline from the latest message (for sticky progress bar)
	const activePipeline = $derived(
		(() => {
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]?.pipeline) return messages[i]!.pipeline!;
			}
			return null;
		})(),
	);
	const pipelineRunning = $derived(
		activePipeline != null && activePipeline.steps.some(s => s.status === 'pending' || s.status === 'running'),
	);

	// Per-session artifact shelf. Populated from the shared artifacts store,
	// filtered to the current thread. Kick a load on mount and again when the
	// session changes so the shelf is ready without needing a prior visit to
	// /app/artifacts.
	const currentSessionId = $derived(getSessionId());
	const sessionArtifacts = $derived(getSessionArtifacts(currentSessionId));
	let artifactShelfExpanded = $state(false);
	$effect(() => {
		if (currentSessionId) void loadArtifacts();
	});

	// Auto-focus textarea and clear leftover input when chat is empty (new chat or initial load)
	function focusInput() {
		if (messages.length === 0 && !isStreaming && textareaEl) {
			inputText = '';
			if (textareaEl) textareaEl.style.height = 'auto';
			void tick().then(() => textareaEl?.focus());
		}
	}
	$effect(() => { focusInput(); });
	// Re-focus after SvelteKit navigation (goto('/app') resets focus)
	afterNavigate(() => { focusInput(); stopSpeech(); });

	// Slash commands handled client-side (navigate instead of sending to agent)
	const SLASH_ROUTES: Record<string, string> = {
		'/settings': '/app/settings',
		'/google auth': '/app/settings',
		'/google': '/app/settings',
		'/memory': '/app/knowledge',
		'/knowledge': '/app/knowledge',
		'/graph': '/app/knowledge',
		'/insights': '/app/knowledge',
		'/history': '/app/activity',
		'/tasks': '/app/activity',
		'/activity': '/app/activity',
		'/contacts': '/app/contacts',
		'/files': '/app/artifacts',
		'/artifacts': '/app/artifacts',
	};

	async function handleSend() {
		const task = inputText.trim();
		if (!task && pendingFiles.length === 0) return;

		// Handle slash commands as navigation
		const slashRoute = SLASH_ROUTES[task.toLowerCase()];
		if (slashRoute) {
			inputText = '';
			if (textareaEl) textareaEl.style.height = 'auto';
			goto(slashRoute);
			return;
		}

		// If a prompt is active, treat chat input as answer
		if (pendingPermission && task) {
			inputText = '';
			if (textareaEl) textareaEl.style.height = 'auto';
			answerPrompt(task);
			return;
		}

		// Chat input guard: warn if text looks like an API key or secret
		if (looksLikeSecret(task)) {
			addToast(t('chat.secret_warning'), 'error', 6000);
			return;
		}

		if (!ready) return;
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
		// Desktop: Enter sends, Shift+Enter = newline
		// Mobile: Enter = newline (no hardware keyboard), use Send button
		const isMobile = window.innerWidth < 768;
		if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
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
			fmtCost(u.costUsd),
		];
		if (cachePct > 0) parts.push(`${cachePct}% cache`);
		return parts.join(' · ');
	}

	function formatK(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
		return String(n);
	}

	function autoResize(e: Event) {
		const el = e.target as HTMLTextAreaElement;
		el.style.height = 'auto';
		let maxH = 150;
		if (window.innerWidth < 768) {
			// Account for virtual keyboard: use visualViewport height if available
			const vh = window.visualViewport?.height ?? window.innerHeight;
			maxH = Math.min(200, Math.floor(vh * 0.3));
		}
		el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
		el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden';
	}
</script>

{#snippet speakButton(msgKey: string, msgContent: string)}
	{#if ttsAvailable && !isStreaming}
		{@const speakState = getSpeakState()}
		{@const active = isSpeakActive(msgKey) && speakState !== 'idle'}
		<button
			onclick={() => {
				if (active) { stopSpeech(); return; }
				maybeShowPrivacyHint(t('chat.tts_privacy_hint'));
				void playSpeech(msgContent, msgKey).then((err) => {
					if (err) addToast(formatSpeakError(err), 'error');
				});
			}}
			class="text-text-subtle hover:text-text transition-all p-1 rounded-[var(--radius-sm)] hover:bg-bg-muted {active ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100 focus:opacity-100'}"
			title={active ? (speakState === 'playing' ? t('chat.stop_speaking') : t('chat.speak_synthesizing')) : t('chat.speak')}
			aria-label={active ? t('chat.stop_speaking') : t('chat.speak')}
		>
			{#if active && speakState === 'synthesizing'}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
			{:else if active && speakState === 'playing'}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><rect x="6" y="6" width="12" height="12" rx="1" stroke-linejoin="round" /></svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>
			{/if}
		</button>
	{/if}
{/snippet}

<div class="flex h-full flex-col">
	<!-- Messages -->
	<div class="flex-1 overflow-y-auto px-4 py-6 md:px-6" bind:this={messagesEl}>
		{#if messages.length === 0 && !isStreaming}
			<div class="flex h-full items-center justify-center">
				{#if hasApiKey === false}
					<!-- Inline API Key Setup (no navigation away) -->
					<div class="w-full max-w-md space-y-6 px-4">
						<div class="text-center">
							<h2 class="text-2xl font-light tracking-tight text-text mb-2">{t('onboard.welcome')}</h2>
							<p class="text-sm text-text-muted">{t('onboard.standalone_hint')}</p>
						</div>

						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5 space-y-4">
							<div>
								<label for="inline-key" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('onboard.api_key_label')}</label>
								<input
									id="inline-key"
									type="password"
									bind:value={setupKey}
									placeholder="sk-ant-..."
									onkeydown={(e) => e.key === 'Enter' && saveInlineKey()}
									class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5 text-[16px] md:text-sm font-mono outline-none focus:border-border-hover"
								/>
							</div>
							<button
								onclick={saveInlineKey}
								disabled={!setupKey.trim() || setupSaving}
								class="w-full rounded-[var(--radius-sm)] bg-accent px-4 py-2.5 text-sm font-medium text-text hover:opacity-90 disabled:opacity-30 transition-opacity"
							>
								{setupSaving ? t('onboard.setting_up') : t('onboard.save_key')}
							</button>
						</div>

						<p class="text-center text-xs text-text-subtle">
							{t('onboard.api_key_hint')} <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">console.anthropic.com</a>
						</p>
						<p class="text-center text-xs text-text-subtle">{t('onboard.api_key_secure')}</p>
					</div>
				{:else}
					<!-- Welcome screen -->
					<div class="w-full max-w-xl px-4 welcome-fade">
						{#if justCompleted}
							<div class="text-center">
							<h2 class="text-2xl font-light tracking-tight text-text mb-2">{t('onboard.ready_title')}</h2>
							<p class="text-sm text-text-muted">{t('onboard.ready_hint')}</p>
							</div>
						{:else}
							<!-- Greeting -->
							{#if true}
								{@const greeting = getGreeting(getLocale())}
								<div class="text-center mb-8">
									<div class="icon-entrance mb-4 sonar-wrap">
										<div class="pulse-ring pulse-ring-1"></div>
										<div class="pulse-ring pulse-ring-2"></div>
										<div class="pulse-ring pulse-ring-3"></div>
										<img src="/icon.svg" alt="" class="icon-float relative z-[2] w-14 h-14" />
									</div>
									<h1 class="text-2xl md:text-3xl font-light tracking-tight text-text welcome-greeting">
										{greeting.text}{#if displayName}, {displayName}{/if}{greeting.punct}
									</h1>
								</div>
							{/if}

							<!-- Onboarding: all steps with done/current/future states -->
							{#if showOnboarding}
								<div class="mt-6 space-y-2.5">
									<p class="text-center text-sm text-text-muted mb-4">{t('onboard.ready_hint')}</p>
									{#each ONBOARDING_CHIPS as chip, idx}
										{#if idx < onboardingStep}
											<!-- Done -->
											<div class="w-full rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 opacity-60 p-4">
												<div class="flex items-center gap-3">
													<span class="flex shrink-0 items-center justify-center w-7 h-7 rounded-full text-sm bg-accent/20 text-accent-text">
														<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
													</span>
													<div class="flex-1 min-w-0">
														<span class="text-sm font-medium text-text-muted line-through">{t(`onboard.${chip.key}` as 'onboard.chip_1')}</span>
														<span class="ml-2 text-[10px] font-mono uppercase tracking-widest text-accent-text">{t('onboard.step_done')}</span>
													</div>
												</div>
											</div>
										{:else if idx === onboardingStep}
											<!-- Current step -->
											{#if idx === 0 && showUrlInput}
												<!-- Step 1: inline URL input (skips LLM ask_user round-trip) -->
												<div class="w-full rounded-[var(--radius-md)] border border-accent/40 bg-accent/10 p-4 space-y-3">
													<div class="flex items-center gap-3">
														<span class="flex shrink-0 items-center justify-center w-7 h-7 rounded-full text-sm bg-accent/20 text-accent-text">1</span>
														<div class="flex-1 min-w-0">
															<span class="text-sm font-medium text-text">{t('onboard.chip_1')}</span>
															<span class="ml-2 text-[10px] font-mono uppercase tracking-widest text-accent-text">{t('onboard.step')} 1/3</span>
														</div>
													</div>
													<div class="flex gap-2">
														<input
															type="url"
															bind:value={onboardingUrl}
															placeholder={t('onboard.url_placeholder')}
															onkeydown={(e) => e.key === 'Enter' && submitOnboardingUrl()}
															class="flex-1 rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[16px] md:text-sm outline-none focus:border-accent/60"
														/>
														<button
															onclick={submitOnboardingUrl}
															disabled={!onboardingUrl.trim()}
															class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-30 transition-opacity"
														>
															{t('onboard.url_go')}
														</button>
													</div>
												</div>
											{:else}
												<!-- Clickable chip -->
												<button
													onclick={() => handleChipClick(idx)}
													class="w-full rounded-[var(--radius-md)] border border-accent/40 bg-accent/10 hover:border-accent/60 hover:bg-accent/15 p-4 text-left transition-all cursor-pointer"
												>
													<div class="flex items-center gap-3">
														<span class="flex shrink-0 items-center justify-center w-7 h-7 rounded-full text-sm bg-accent/20 text-accent-text">{idx + 1}</span>
														<div class="flex-1 min-w-0">
															<div class="flex items-center gap-2">
																<span class="text-sm font-medium text-text">{t(`onboard.${chip.key}` as 'onboard.chip_1')}</span>
																<span class="text-[10px] font-mono uppercase tracking-widest text-accent-text">{t('onboard.step')} {idx + 1}/3</span>
															</div>
															<p class="text-xs text-text-muted mt-0.5">{t(`onboard.${chip.descKey}` as 'onboard.chip_1_desc')}</p>
														</div>
														<svg class="shrink-0 text-accent-text" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
													</div>
												</button>
											{/if}
										{:else}
											<!-- Future: faded -->
											<div class="w-full rounded-[var(--radius-md)] border border-border/50 bg-bg-subtle opacity-40 p-4">
												<div class="flex items-center gap-3">
													<span class="flex shrink-0 items-center justify-center w-7 h-7 rounded-full text-sm bg-bg-muted text-text-subtle">{idx + 1}</span>
													<div class="flex-1 min-w-0">
														<span class="text-sm font-medium text-text-subtle">{t(`onboard.${chip.key}` as 'onboard.chip_1')}</span>
														<p class="text-xs text-text-muted mt-0.5">{t(`onboard.${chip.descKey}` as 'onboard.chip_1_desc')}</p>
													</div>
												</div>
											</div>
										{/if}
									{/each}
									<button onclick={skipOnboarding} class="w-full text-center text-xs text-text-subtle hover:text-text-muted transition-colors mt-3 py-1">
										{t('onboard.skip_onboarding')}
									</button>
								</div>
							{:else}
								<!-- Daily quote (shown after onboarding or for returning users) -->
								{@const quote = getTodaysQuote()}
								<blockquote class="text-center mt-2">
									<p class="text-sm italic text-text-muted leading-relaxed">&ldquo;{quote.text}&rdquo;</p>
									<footer class="mt-1.5 text-xs text-text-subtle">&mdash; {quote.author}</footer>
								</blockquote>
							{/if}
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<div class="mx-auto max-w-3xl space-y-5">
			{#each messages as msg, msgIdx (msgIdx + ':' + msg.content.slice(0, 20))}
				{#if msg.role === 'user'}
					<div class="flex justify-end">
						<button
							onclick={() => { if (msg.failed) { sendMessage(msg.content); msg.failed = false; } else { navigator.clipboard.writeText(msg.content); addToast(t('common.copied'), 'success', 1500); } }}
							class="rounded-[var(--radius-md)] px-4 py-2.5 text-sm max-w-[80%] text-left cursor-pointer hover:opacity-80 transition-opacity {msg.failed ? 'bg-danger/10 border border-danger/30 text-danger' : msg.queued ? 'bg-bg-muted border border-border text-text-muted' : 'bg-accent/10 border border-accent/20'}"
						>
							{#if hasVoicePrefix(msg.content)}
								<svg xmlns="http://www.w3.org/2000/svg" class="inline-block h-3.5 w-3.5 mr-1.5 -mt-0.5 text-current opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d={MIC_SVG_PATH} /></svg>{stripVoicePrefix(msg.content)}
							{:else}
								{msg.content}
							{/if}
							{#if msg.failed}
								<span class="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-danger/70 mt-1">{t('chat.send_failed')}</span>
							{:else if msg.queued}
								<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle ml-2">{t('chat.queued')}</span>
							{/if}
						</button>
					</div>
				{:else}
					<div class="space-y-2">
						{#if msg.thinking}
							<details class="text-xs text-text-subtle">
								<summary class="cursor-pointer hover:text-text-muted font-mono uppercase tracking-widest text-[11px]">{t('chat.thinking_label')}</summary>
								<pre class="mt-2 whitespace-pre-wrap font-mono text-xs text-text-subtle/70 border-l-2 border-accent/20 pl-3">{maskText(msg.thinking ?? '')}</pre>
							</details>
						{/if}

						<!-- Interleaved blocks: grouped tool calls + text in chronological order -->
						{#each msg.blocks?.length ? groupedToolCalls(msg.blocks, msg.toolCalls ?? []) : [] as gBlock, gIdx (gIdx)}
							{#if gBlock.type === 'plan'}
								<details class="text-xs text-text-subtle border-l-2 border-accent/30 pl-3 py-1 my-1">
									<summary class="cursor-pointer hover:text-text-muted font-medium text-text-muted">{gBlock.summary || 'Plan'}</summary>
									<div class="mt-1.5 space-y-1">
										{#each gBlock.phases as phase, pi}
											<div>
												<span class="font-medium text-text-muted">{pi + 1}. {phase.name}</span>
												{#if phase.steps.length > 0}
													<ul class="list-disc list-inside text-text-subtle/60 ml-2 mt-0.5">
														{#each phase.steps as step}
															<li>{step}</li>
														{/each}
													</ul>
												{/if}
											</div>
										{/each}
									</div>
								</details>
							{:else if gBlock.type === 'step_done'}
								{@const stepName = gBlock.stepId.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase())}
								<div class="flex items-start gap-2 md:gap-1.5 text-[13px] md:text-[11px] border-l-2 border-success/30 pl-3 py-1 md:py-0.5">
									<span class="text-success text-xs md:text-[10px] font-bold flex-shrink-0 mt-px">✓</span>
									<span class="text-text-muted"><span class="font-medium">{stepName}</span>{#if gBlock.summary}<span class="text-text-subtle/70"> — {gBlock.summary.length > 120 ? gBlock.summary.slice(0, 120) + '...' : gBlock.summary}</span>{/if}</span>
								</div>
							{:else if gBlock.type === 'tools'}
								{@const toolDef = getToolIcon(gBlock.toolName)}
								<div class="flex items-center gap-2 md:gap-1.5 text-[13px] md:text-[11px] text-text-subtle/70 border-l-2 border-border pl-3 py-1 md:py-0.5">
									<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 md:h-3 md:w-3 shrink-0 {toolDef.color}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
										{#each toolDef.paths as p}<path stroke-linecap="round" stroke-linejoin="round" d={p} />{/each}
									</svg>
									<span>{gBlock.action}{gBlock.subjects.length > 0 ? ': ' + gBlock.subjects.join(', ') : ''}</span>
								</div>
								{#if gBlock.toolName === 'spawn_agent' && msg.spawn}
									{@const sp = msg.spawn}
									{@const elapsed = Math.max(sp.elapsedS, Math.floor((Date.now() - sp.startedAt) / 1000))}
									<div class="ml-3 mt-1 mb-1 text-[11px] font-mono text-text-subtle/80 border-l-2 border-warning/30 pl-3 py-1">
										<div class="flex items-center gap-2 text-text-subtle">
											<span>{elapsed}s</span>
											{#if sp.running.length > 0}
												<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning animate-pulse" aria-hidden="true"></span>
												<span>{sp.running.length} aktiv</span>
											{:else}
												<span>fertig</span>
											{/if}
											{#if elapsed >= 120 && sp.running.length > 0}
												<span class="text-warning">ungewöhnlich lang</span>
											{/if}
										</div>
										{#each sp.running as subName}
											<div class="flex items-center gap-2 mt-0.5">
												<span class="text-text-subtle/60">-&gt;</span>
												<span class="text-text">{subName}</span>
												{#if sp.lastToolBySub[subName]}
													<span class="text-text-subtle/60">·</span>
													<span class="text-text-subtle/70">{sp.lastToolBySub[subName]}</span>
												{/if}
											</div>
										{/each}
										{#each sp.done as d}
											<div class="flex items-center gap-2 mt-0.5">
												<span class={d.ok ? 'text-success' : 'text-danger'}>{d.ok ? '✓' : '✗'}</span>
												<span class="text-text-subtle/80">{d.name}</span>
												<span class="text-text-subtle/50">{d.elapsedS}s</span>
											</div>
										{/each}
									</div>
								{/if}
							{:else if gBlock.type === 'text' && gBlock.text}
								{@const hasArtifact = gBlock.text.includes('```html') && (gBlock.text.includes('<!DOCTYPE') || gBlock.text.includes('<html'))}
								<div class="relative group/copy">
									<MarkdownRenderer content={gBlock.text} streaming={isStreaming && msgIdx === messages.length - 1} />
									<div class="absolute top-0 right-0 flex gap-1">
										{@render speakButton(`msg-${msgIdx}`, msg.content)}
										{#if !hasArtifact}
											<button
												onclick={() => { navigator.clipboard.writeText(msg.content); addToast(t('common.copied'), 'success', 1500); }}
												class="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 text-text-subtle hover:text-text transition-opacity p-1 rounded-[var(--radius-sm)] hover:bg-bg-muted"
												title={t('common.copy')}
												aria-label={t('common.copy')}
											>
												<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
											</button>
										{/if}
									</div>
								</div>
						{/if}
						{/each}
						<!-- Fallback for legacy messages without blocks -->
						{#if !msg.blocks?.length}
							{@const legacyGroups = groupedToolCalls((msg.toolCalls ?? []).map((_, i) => ({ type: 'tool_call' as const, index: i })), msg.toolCalls ?? [])}
							{#each legacyGroups as lg}
								{#if lg.type === 'tools'}
									{@const lgDef = getToolIcon(lg.toolName)}
									<div class="flex items-center gap-2 md:gap-1.5 text-[13px] md:text-[11px] text-text-subtle/70 py-1 md:py-0.5">
										<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 md:h-3 md:w-3 shrink-0 {lgDef.color}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
											{#each lgDef.paths as p}<path stroke-linecap="round" stroke-linejoin="round" d={p} />{/each}
										</svg>
										<span>{lg.action}{lg.subjects.length > 0 ? ': ' + lg.subjects.join(', ') : ''}</span>
									</div>
								{/if}
							{/each}
							{#if msg.content}
								{@const hasArtifact = msg.content.includes('```html') && (msg.content.includes('<!DOCTYPE') || msg.content.includes('<html'))}
								<div class="relative group/copy">
									<MarkdownRenderer content={msg.content} streaming={isStreaming && msgIdx === messages.length - 1} />
									<div class="absolute top-0 right-0 flex gap-1">
										{@render speakButton(`msg-${msgIdx}`, msg.content)}
										{#if !hasArtifact}
											<button
												onclick={() => { navigator.clipboard.writeText(msg.content); addToast(t('common.copied'), 'success', 1500); }}
												class="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 text-text-subtle hover:text-text transition-opacity p-1 rounded-[var(--radius-sm)] hover:bg-bg-muted"
												title={t('common.copy')}
												aria-label={t('common.copy')}
											>
												<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
											</button>
										{/if}
									</div>
								</div>
							{/if}
						{/if}
						{#if msg.usage && !isStreaming && msgIdx !== messages.length - 1}
							<p class="text-[11px] font-mono text-text-subtle mt-1">{formatUsage(msg.usage)}</p>
						{/if}
					</div>
				{/if}
			{/each}

			{#if isStreaming && !pendingPermission}
				<div class="flex items-center gap-2 text-xs text-text-subtle">
					<span class="inline-block h-2 w-2 animate-pulse rounded-full bg-accent"></span>
					{streamingLabel}
				</div>
			{/if}

			{#if messages.length > 0}
				<div class="flex items-center gap-3 flex-wrap">
					{#if messages[messages.length - 1]?.usage && !isStreaming}
						{@const lastUsage = messages[messages.length - 1].usage}
						{#if lastUsage}
							<span class="text-[11px] font-mono text-text-subtle">{formatUsage(lastUsage)}</span>
						{/if}
					{/if}
					{#if hasToolCalls}
						<button onclick={toggleAllToolCalls} class="hidden md:inline text-xs text-text-subtle hover:text-text transition-colors font-mono uppercase tracking-widest">
							{toolCallsExpanded ? t('chat.collapse_all') : t('chat.expand_all')}
						</button>
					{/if}
					<button onclick={() => downloadExport('md')} class="hidden md:inline text-xs text-text-subtle hover:text-text transition-colors font-mono uppercase tracking-widest">↓ Export</button>
					<button onclick={async () => { const { exportAsJSON } = await import('../stores/chat.svelte.js'); await navigator.clipboard.writeText(exportAsJSON()); addToast(t('common.copied'), 'success', 1500); }} class="hidden md:inline text-xs text-text-subtle hover:text-text transition-colors font-mono uppercase tracking-widest">⎘ JSON</button>
				</div>
			{/if}

			<!-- Follow-up suggestion chips -->
			{#if !isStreaming && messages.length > 0}
				{@const lastAssistant = messages[messages.length - 1]}
				{#if lastAssistant?.role === 'assistant' && lastAssistant.followUps?.length}
					<div class="flex flex-wrap gap-2 mt-1">
						{#each lastAssistant.followUps as fu}
							<button
								onclick={() => sendMessage(fu.task)}
								class="rounded-full border border-accent/30 bg-accent/5 px-3 py-1.5 text-xs text-accent-text hover:border-accent/50 hover:bg-accent/10 transition-all"
							>{fu.label}</button>
						{/each}
					</div>
				{/if}
			{/if}

			<!-- Inline onboarding chip for steps 2+3 (same thread) -->
			{#if showOnboarding && onboardingStep > 0 && messages.length > 0 && !isStreaming}
				{@const chip = ONBOARDING_CHIPS[onboardingStep]}
				{#if chip}
					<div class="mt-4 mb-2">
						<button
							onclick={() => handleChipClick(onboardingStep)}
							class="w-full max-w-lg rounded-[var(--radius-md)] border border-accent/40 bg-accent/10 hover:border-accent/60 hover:bg-accent/15 p-4 text-left transition-all cursor-pointer"
						>
							<div class="flex items-center gap-3">
								<span class="flex shrink-0 items-center justify-center w-7 h-7 rounded-full text-sm bg-accent/20 text-accent-text">{onboardingStep + 1}</span>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="text-sm font-medium text-text">{t(`onboard.${chip.key}` as 'onboard.chip_1')}</span>
										<span class="text-[10px] font-mono uppercase tracking-widest text-accent-text">{t('onboard.step')} {onboardingStep + 1}/3</span>
									</div>
									<p class="text-xs text-text-muted mt-0.5">{t(`onboard.${chip.descKey}` as 'onboard.chip_1_desc')}</p>
								</div>
								<svg class="shrink-0 text-accent-text" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
							</div>
						</button>
						<button onclick={skipOnboarding} class="text-center text-xs text-text-subtle hover:text-text-muted transition-colors mt-2 py-1">
							{t('onboard.skip_onboarding')}
						</button>
					</div>
				{/if}
			{/if}

			<!-- Post-onboarding "What's Next" -->
			{#if onboardingJustCompleted && !isStreaming && messages.length > 0}
				<div class="mt-4 mb-2 w-full max-w-lg rounded-[var(--radius-md)] border border-accent/20 bg-accent/5 p-5">
					<h3 class="text-sm font-semibold text-text mb-1">{t('onboard.whats_next_title')}</h3>
					<p class="text-xs text-text-muted mb-3">{t('onboard.whats_next_subtitle')}</p>
					<div class="space-y-2">
						<a href="/app/settings/integrations" class="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border/50 px-3 py-2.5 hover:border-accent/30 hover:bg-accent/5 transition-all">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" /></svg>
							<div>
								<span class="text-sm font-medium text-text">{t('onboard.whats_next_google')}</span>
								<p class="text-xs text-text-muted">{t('onboard.whats_next_google_desc')}</p>
							</div>
						</a>
						<a href="/app/settings/mobile" class="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border/50 px-3 py-2.5 hover:border-accent/30 hover:bg-accent/5 transition-all">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 0 0 6 3.75v16.5a2.25 2.25 0 0 0 2.25 2.25h7.5A2.25 2.25 0 0 0 18 20.25V3.75a2.25 2.25 0 0 0-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" /></svg>
							<div>
								<span class="text-sm font-medium text-text">{t('onboard.whats_next_mobile')}</span>
								<p class="text-xs text-text-muted">{t('onboard.whats_next_mobile_desc')}</p>
							</div>
						</a>
						<a href="/app/settings/integrations" class="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border/50 px-3 py-2.5 hover:border-accent/30 hover:bg-accent/5 transition-all">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" /></svg>
							<div>
								<span class="text-sm font-medium text-text">{t('onboard.whats_next_notifications')}</span>
								<p class="text-xs text-text-muted">{t('onboard.whats_next_notifications_desc')}</p>
							</div>
						</a>
						<a href="/app/knowledge" class="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border/50 px-3 py-2.5 hover:border-accent/30 hover:bg-accent/5 transition-all">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg>
							<div>
								<span class="text-sm font-medium text-text">{t('onboard.whats_next_knowledge')}</span>
								<p class="text-xs text-text-muted">{t('onboard.whats_next_knowledge_desc')}</p>
							</div>
						</a>
						<button onclick={() => { onboardingJustCompleted = false; }} class="w-full text-center text-xs text-text-subtle hover:text-text-muted transition-colors mt-2 py-1">
							{t('onboard.whats_next_chat')}
						</button>
					</div>
				</div>
			{/if}

			{#if isOffline}
				<div role="status" class="rounded-[var(--radius-md)] bg-warning/10 border border-warning/20 px-4 py-2.5 text-sm text-warning flex items-center gap-2">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 5.636a9 9 0 010 12.728M5.636 5.636a9 9 0 000 12.728M12 12h.01M8.464 8.464a5 5 0 000 7.072M15.536 8.464a5 5 0 010 7.072" /><line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2" /></svg>
					<span>{t('chat.error_offline')}</span>
				</div>
			{/if}

			{#if retryStatus}
				<div class="rounded-[var(--radius-md)] bg-warning/10 border border-warning/20 px-4 py-2.5 text-sm text-warning flex items-center gap-2">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
					<span>{retryStatus.reason === 'busy' ? t('chat.busy_wait') : t('chat.retry').replace('{attempt}', String(retryStatus.attempt)).replace('{max}', String(retryStatus.maxAttempts))}</span>
				</div>
			{/if}

			{#if chatError}
				<div role="alert" class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger flex items-center justify-between gap-3">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
					<span class="flex-1">{@html chatError
						.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
						.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, text: string, url: string) => {
							try { const u = new URL(url, location.origin); if (u.protocol !== 'http:' && u.protocol !== 'https:') return text; } catch { if (!url.startsWith('/')) return text; }
							return `<a href="${url}" class="underline hover:opacity-80">${text}</a>`;
						})}</span>
					<div class="flex items-center gap-2 shrink-0">
						{#if chatErrorDetail}
							<button onclick={async () => { await navigator.clipboard.writeText(chatErrorDetail ?? ''); addToast(t('chat.error_copy_detail'), 'success', 1500); }} class="text-xs opacity-60 hover:opacity-100" title={t('chat.error_copy_detail')}>
								<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
							</button>
						{/if}
						<button onclick={clearError} class="text-xs opacity-60 hover:opacity-100">{t('common.ok')}</button>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- Pipeline progress: sticky above input during active execution only -->
	{#if activePipeline && isStreaming && pipelineRunning}
		<div class="border-t border-border bg-bg-subtle px-4 py-2">
			<div class="max-w-3xl mx-auto">
				<PipelineProgress pipeline={activePipeline} />
			</div>
		</div>
	{/if}

	<!-- Changeset review: show after run completes with file changes -->
	{#if !isStreaming && (pendingChangeset || changesetLoading)}
		<div class="border-t border-border bg-bg-subtle px-4 py-3" data-changeset-review>
			<div class="max-w-3xl mx-auto">
				{#if changesetLoading}
					<div class="text-xs text-text-muted font-mono animate-pulse">{t('changeset.loading')}</div>
				{:else if pendingChangeset && pendingChangeset.length > 0}
					<ChangesetReview
						files={pendingChangeset}
						onReview={(action, rolledBackFiles) => submitChangesetReview(action, rolledBackFiles)}
					/>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Batch mode: all questions as form. Drives off either pendingTabsPrompt
	     (v2, one-shot reply) or pendingPermission (v1, sequential fallback). -->
	{#if inBatchMode && (pendingPermission || pendingTabsPrompt)}
		<div role="dialog" aria-label={t('chat.batch_mode')} tabindex="-1" class="border-t border-border bg-bg-subtle px-4 py-3"
			onkeydown={(e) => { if (e.key === 'Escape') answerPrompt('__dismissed__'); }}>
			<div class="max-w-3xl mx-auto space-y-1">
				{#each batchQuestions as q, i}
					{#if batchFocusIdx === i}
						<!-- Focused question: expanded -->
						<div class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 px-3 py-2">
							<p class="text-xs font-medium text-text-muted mb-1">{q.header ?? q.question}</p>
							{#if q.options.length > 0}
								<div class="flex flex-wrap gap-1.5">
									{#each q.options as option}
										<button onclick={() => {
											const sel = batchSelections[i] ?? [];
											if (sel.includes(option)) {
												batchSelections[i] = sel.filter(o => o !== option);
											} else {
												batchSelections[i] = [...sel, option];
											}
											batchSelections = [...batchSelections];
											batchAnswers[i] = (batchSelections[i] ?? []).join(', ');
											batchAnswers = [...batchAnswers];
										}}
											class="rounded-[var(--radius-sm)] border px-2.5 py-1 text-xs transition-all {(batchSelections[i] ?? []).includes(option) ? 'border-accent bg-accent/15 text-accent-text' : 'border-border bg-bg text-text-muted hover:text-text hover:border-border-hover'}"
										>{option}</button>
									{/each}
								</div>
								<div class="flex gap-2 mt-1.5">
									<button onclick={() => { if (batchAnswers[i]) answerPrompt(batchAnswers[i]!); }}
										disabled={!(batchSelections[i] ?? []).length}
										class="rounded-[var(--radius-sm)] bg-accent px-3 py-1 text-xs text-text hover:opacity-90 disabled:opacity-30"
									>{t('chat.send')}</button>
									<button onclick={() => answerPrompt('__dismissed__')}
										class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1 text-xs text-text-subtle hover:text-text transition-all"
									>{t('chat.skip')}</button>
								</div>
							{:else}
								<form onsubmit={(e) => { e.preventDefault(); const val = batchFreetext.trim(); if (val) answerPrompt(val); batchFreetext = ''; }} class="flex flex-col sm:flex-row gap-1.5">
									<input bind:value={batchFreetext} placeholder={q.question} class="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5 text-[16px] md:text-xs outline-none focus:border-border-hover" />
									<div class="flex gap-1.5">
										<button type="submit" disabled={!batchFreetext.trim()} class="flex-1 sm:flex-none rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-xs text-text hover:opacity-90 disabled:opacity-30">{t('chat.send')}</button>
										<button type="button" onclick={() => answerPrompt('__dismissed__')} class="flex-1 sm:flex-none rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-subtle hover:text-text transition-all">{t('chat.skip')}</button>
									</div>
								</form>
							{/if}
						</div>
					{:else}
						{@const ans = batchAnswers[i]}
						{@const isDismissed = ans === '__dismissed__'}
						{@const isAnswered = !!ans && !isDismissed}
						<!-- Compact: answered, dismissed, or unanswered -->
						<button onclick={() => { if (ans) { batchAnswers[i] = ''; batchSelections[i] = []; batchAnswers = [...batchAnswers]; batchSelections = [...batchSelections]; } batchFocusIdx = i; }}
							class="w-full flex flex-col md:flex-row items-start md:items-center gap-0.5 md:gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs text-left transition-all {isAnswered ? 'text-text-muted hover:bg-bg-muted' : isDismissed ? 'text-text-subtle hover:bg-bg-muted' : 'text-text-subtle italic hover:bg-bg'}">
							<span class="font-medium shrink-0 w-auto md:w-20 md:truncate">{q.header ?? '?'}</span>
							<span class="min-w-0 md:flex-1 break-words md:truncate {isAnswered ? 'text-accent-text' : isDismissed ? 'text-text-subtle' : ''}">{isDismissed ? t('chat.skipped') : (ans || q.question)}</span>
							{#if isAnswered}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle hover:text-accent-text md:ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
							{/if}
						</button>
					{/if}
				{/each}
				<!-- Cancel batch: submit answered questions, dismiss the rest -->
				<button onclick={() => {
					for (let i = 0; i < batchAnswers.length; i++) {
						if (!batchAnswers[i]) batchAnswers[i] = '__dismissed__';
					}
					batchAnswers = [...batchAnswers];
					submitBatch();
				}}
					class="w-full text-center rounded-[var(--radius-sm)] px-3 py-1.5 text-xs text-text-subtle hover:text-text hover:bg-bg-muted transition-all mt-1"
				>{t('chat.dismiss')}</button>
			</div>
		</div>
	{/if}

	<!-- Answered prompts stack (single-question mode only) -->
	{#if answeredPrompts.length > 0 && pendingPermission && !inBatchMode}
		<div class="border-t border-border bg-bg-subtle/50 px-4 py-2">
			<div class="max-w-3xl mx-auto space-y-1">
				{#each answeredPrompts as ap}
					<div class="flex items-center gap-2 text-xs group">
						<span class="text-text-subtle flex-1">{ap.question}</span>
						<span class="text-accent-text font-medium">{ap.answer}</span>
						<button
							onclick={() => { abortRun(); answeredPrompts = []; addToast(t('chat.retry_hint'), 'info'); }}
							class="text-text-subtle hover:text-accent-text transition-colors shrink-0 p-1.5"
							title={t('chat.edit_answer')}
						>
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Permission / Ask User prompt (hidden in batch mode) -->
	{#if pendingPermission && !inBatchMode}
		{@const opts = pendingPermission.options ?? []}
		{@const isPermissionGuard = opts.includes('Allow') && opts.includes('Deny')}
		{@const visibleOptions = isPermissionGuard ? [] : opts.filter(o => o !== '\x00')}
		<div class="border-t border-border bg-bg-subtle px-4 py-3">
			<div class="max-w-3xl mx-auto space-y-2">
				<div class="flex items-start gap-2">
					{#if isPermissionGuard}
						<pre class="flex-1 text-sm text-text-muted whitespace-pre-wrap font-sans leading-relaxed max-h-64 overflow-y-auto scrollbar-thin">{pendingPermission.question}</pre>
					{:else}
						<div class="flex-1 text-sm text-text-muted leading-relaxed max-h-64 overflow-y-auto scrollbar-thin [&_strong]:text-text [&_blockquote]:border-l-2 [&_blockquote]:border-accent/30 [&_blockquote]:pl-3 [&_blockquote]:my-2 [&_blockquote]:text-text [&_p]:my-1">
							<MarkdownRenderer content={pendingPermission.question} streaming={false} />
						</div>
					{/if}
					<div class="flex items-center gap-1.5 shrink-0">
						{#if promptSecondsLeft != null}
							<span class="text-[11px] font-mono tabular-nums {promptSecondsLeft < 60 ? 'text-warning' : 'text-text-subtle'}" title={t('chat.prompt_timeout_left')}>{formatCountdown(promptSecondsLeft)}</span>
						{/if}
						{#if !isPermissionGuard}
							<button onclick={() => answerPrompt('__dismissed__')} class="p-1.5 rounded text-text-subtle hover:text-text hover:bg-bg-muted transition-colors" aria-label={t('chat.dismiss')}>
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
							</button>
						{/if}
					</div>
				</div>

				{#if isPermissionGuard}
					<div class="flex flex-wrap gap-2">
						<button onclick={() => answerPrompt('y')} class="rounded-[var(--radius-sm)] bg-success/15 border border-success/30 px-3 py-1.5 text-sm text-success hover:bg-success/25 transition-opacity">{t('chat.allow')}</button>
						<button onclick={() => answerPrompt('n')} class="rounded-[var(--radius-sm)] bg-danger/15 border border-danger/30 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 transition-opacity">{t('chat.deny')}</button>
					</div>
				{:else if visibleOptions.length > 0}
					<div class="flex flex-wrap gap-2">
						{#each visibleOptions as option}
							<button
								onclick={() => answerPrompt(option)}
								class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-sm text-text-muted hover:text-text hover:border-accent hover:bg-accent/10 transition-all"
							>{option}</button>
						{/each}
						<button onclick={() => answerPrompt('__dismissed__')} class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-sm text-text-subtle hover:text-text transition-all">{t('chat.skip')}</button>
					</div>
				{:else}
					<!-- Open-ended: user types in normal chat input below -->
					<p class="text-xs text-text-subtle">{t('chat.hint')}</p>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Secure Secret Prompt -->
	{#if pendingSecret}
		<div class="border-t border-border bg-bg-subtle px-4 py-3">
			<div class="max-w-3xl mx-auto space-y-3">
				<div class="flex items-center gap-2">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-warning shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
					<span class="text-sm font-medium text-text">{pendingSecret.prompt}</span>
				</div>

				{#if !secretConsented}
					<div class="flex items-center gap-2 text-xs text-text-subtle bg-bg-muted rounded-[var(--radius-sm)] px-3 py-2">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
						<span>{t('chat.secret_consent')}</span>
					</div>
					<div class="flex gap-2">
						<button onclick={() => { secretConsented = true; }} class="rounded-[var(--radius-sm)] bg-accent/15 border border-accent/30 px-3 py-1.5 text-sm text-accent hover:bg-accent/25 transition-all">OK</button>
						<button onclick={handleSecretCancel} class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-sm text-text-subtle hover:text-text transition-all">{t('chat.secret_cancel')}</button>
					</div>
				{:else}
					<div class="flex gap-2">
						<input
							type="password"
							bind:value={secretValue}
							bind:this={secretInputEl}
							onkeydown={(e) => { if (e.key === 'Enter') handleSecretSave(); }}
							class="flex-1 rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-sm text-text focus:border-accent focus:outline-none font-mono"
							placeholder={pendingSecret.name}
							autocomplete="off"
							data-1p-ignore
						/>
						<button onclick={handleSecretSave} disabled={!secretValue.trim()} class="rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed">{t('chat.secret_save')}</button>
						<button onclick={handleSecretCancel} class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-sm text-text-subtle hover:text-text transition-all">{t('chat.secret_cancel')}</button>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Per-session artifact shelf — silent unless artifacts exist in this thread -->
	{#if sessionArtifacts.length > 0}
		<div class="border-t border-border bg-bg-subtle px-4 py-1.5 text-xs">
			<div class="max-w-3xl mx-auto">
				<button
					type="button"
					onclick={() => { artifactShelfExpanded = !artifactShelfExpanded; }}
					class="flex items-center gap-2 text-text-subtle hover:text-text transition-colors w-full text-left"
					aria-expanded={artifactShelfExpanded}
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0 transition-transform {artifactShelfExpanded ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
					</svg>
					<span class="font-mono tabular-nums">{sessionArtifacts.length} · {t('artifacts.title')}</span>
				</button>
				{#if artifactShelfExpanded}
					<div class="mt-2 flex flex-wrap gap-1.5 pb-1">
						{#each sessionArtifacts as a}
							<a
								href="/app/artifacts?focus={encodeURIComponent(a.id)}"
								class="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 py-1 text-[11px] text-text-muted hover:text-text hover:border-accent/40 transition-all max-w-[20rem]"
								title={a.title}
							>
								<span class="uppercase tracking-wider text-accent-text text-[9px] font-medium shrink-0">{a.type}</span>
								<span class="truncate">{a.title}</span>
							</a>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Context-usage banner (only renders at ≥60 %, silent below) -->
	{#if ctxBudget && ctxBudget.usagePercent >= 60}
		{@const pct = ctxBudget.usagePercent}
		{@const critical = pct >= 75}
		<div
			class="border-t {critical ? 'border-danger/30 bg-danger/10 text-danger' : 'border-warning/30 bg-warning/10 text-warning'} px-4 py-1.5 text-xs"
			role="status"
			aria-live="polite"
		>
			<div class="max-w-3xl mx-auto flex items-center gap-2">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3l-6.93-12a2 2 0 00-3.48 0l-6.93 12a2 2 0 001.74 3z" />
				</svg>
				<span class="font-mono tabular-nums">{t('status.context')}: {pct}%</span>
				<span class="opacity-70 font-mono tabular-nums hidden sm:inline">·</span>
				<span class="opacity-70 font-mono tabular-nums hidden sm:inline">{formatK(ctxBudget.totalTokens)} / {formatK(ctxBudget.maxTokens)} {t('chat.context_tokens')}</span>
				{#if critical}
					<span class="opacity-80 ml-auto">— {t('chat.context_auto_compact_imminent')}</span>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Input -->
	<div class="border-t border-border bg-bg-subtle px-2 py-2 md:px-4 md:py-2" style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.5rem);">
		<!-- Pending files -->
		{#if pendingFiles.length > 0}
			<div class="max-w-3xl mx-auto flex flex-wrap gap-2 mb-2">
				{#each pendingFiles as file, i}
					<div class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs text-text-muted">
						<span class="truncate max-w-24 md:max-w-32" title={file.name}>{file.name}</span>
						<button onclick={() => removeFile(i)} class="text-text-subtle hover:text-danger ml-1 p-1" aria-label="Remove">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="max-w-3xl mx-auto flex items-center gap-1.5 md:gap-2">
			<input bind:this={fileInputEl} type="file" multiple class="hidden" onchange={handleFiles} accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.txt,.md,.json,.csv,.ts,.js,.py,.html,.css" />

			{#if transcribing}
				<!-- Transcribing state -->
				<div class="flex-1 flex items-center gap-2 rounded-2xl md:rounded-[var(--radius-md)] border border-border bg-bg px-3 py-3">
					<svg class="h-4 w-4 animate-spin text-accent shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
					</svg>
					<span class="text-sm text-text-subtle">{t('chat.transcribing')}</span>
				</div>
				<div class="shrink-0 h-11 w-11"></div>
			{:else if recording}
				<!-- Recording state: [🗑  ● 0:03 ━━━━━]  [➤] -->
				<div class="flex-1 flex items-center gap-2 rounded-2xl md:rounded-[var(--radius-md)] border border-danger/30 bg-bg px-3 py-2">
					<button onclick={discardRecording} class="text-text-subtle hover:text-danger transition-colors shrink-0" aria-label="Discard">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
					</button>
					<span class="h-2 w-2 rounded-full bg-danger animate-pulse shrink-0"></span>
					<span class="text-xs font-mono text-text-subtle tabular-nums shrink-0">{recordingSeconds}s</span>
					<!-- Live waveform bars -->
					<div class="flex-1 flex items-center justify-center gap-[2px] h-8">
						{#each waveformBars as height}
							<div
								class="w-[3px] rounded-full bg-accent/70 transition-all duration-75"
								style="height: {height}px;"
							></div>
						{/each}
					</div>
				</div>
				<!-- Send button during recording -->
				<button
					onclick={stopRecording}
					class="shrink-0 h-11 w-11 flex items-center justify-center rounded-full bg-accent text-text hover:opacity-90 transition-all"
					aria-label={t('chat.send')}
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
				</button>
			{:else}
				<!-- Normal: 📎  [Nachricht eingeben...]  ➤ -->
				<button
					onclick={() => fileInputEl.click()}
					disabled={!ready}
					class="shrink-0 h-11 w-11 flex items-center justify-center rounded-full text-text-subtle hover:text-text disabled:opacity-30 transition-opacity outline-none focus:outline-none"
					aria-label={t('chat.attach_file')}
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
					</svg>
				</button>
				<div class="flex-1 flex items-end rounded-2xl md:rounded-[var(--radius-md)] border border-border/50 md:border-border bg-bg overflow-hidden">
					<textarea
						bind:this={textareaEl}
						bind:value={inputText}
						onkeydown={handleKeydown}
						oninput={autoResize}
						onpaste={handlePaste}
						placeholder={pendingPermission && !inBatchMode ? t('chat.placeholder_answer') : isStreaming ? t('chat.placeholder_streaming') : t('chat.placeholder')}
						rows="1"
						disabled={!ready && !pendingPermission}
						class="flex-1 resize-none border-0 bg-transparent px-4 py-2.5 text-[16px] md:text-sm text-text placeholder:text-text-subtle outline-none disabled:opacity-50 overflow-hidden"
					></textarea>
				</div>

				{#if isStreaming && !pendingPermission}
					<button
						onclick={() => abortRun()}
						class="shrink-0 h-11 w-11 flex items-center justify-center rounded-full border border-danger/30 bg-danger/15 text-danger hover:bg-danger/25 transition-all"
						aria-label={t('chat.abort')}
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1" /></svg>
					</button>
				{:else if inputText.trim() || pendingFiles.length > 0 || pendingPermission}
					<button
						onclick={handleSend}
						disabled={(!inputText.trim() && pendingFiles.length === 0) || (!ready && !pendingPermission) || !!pendingChangeset}
						class="shrink-0 h-11 w-11 flex items-center justify-center rounded-full bg-accent text-text hover:opacity-90 disabled:opacity-30 transition-all"
						aria-label={t('chat.send')}
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
					</button>
				{:else}
					<!-- Touch: hold to record, release to send. Mouse: click to toggle. -->
					<button
						onclick={() => {
							if (recordingStartedByTouch) return;
							if (recording) { stopRecording(); } else { void startRecording(); }
						}}
						onpointerdown={(e) => {
							if (e.pointerType !== 'touch') return;
							e.preventDefault();
							recordingStartedByTouch = true;
							void startRecording();
						}}
						onpointerup={() => {
							if (recordingStartedByTouch) {
								recordingStartedByTouch = false;
								stopRecording();
							}
						}}
						onpointerleave={() => {
							if (recordingStartedByTouch) {
								recordingStartedByTouch = false;
								stopRecording();
							}
						}}
						oncontextmenu={(e) => e.preventDefault()}
						disabled={!ready}
						class="shrink-0 h-11 w-11 flex items-center justify-center rounded-full text-text-subtle hover:text-text active:bg-accent/20 active:text-accent disabled:opacity-30 transition-all select-none touch-none"
						aria-label={t('chat.voice_input')}
						title="{t('chat.voice_input')} ({t('shortcut.voice_record')})"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
						</svg>
					</button>
				{/if}
			{/if}
		</div>
		{#if (recording || transcribing) && voicePrivacyKey}
			<p class="mt-1.5 max-w-3xl mx-auto text-[11px] text-text-subtle px-3 leading-snug">
				{t(voicePrivacyKey)}
			</p>
		{/if}
		{#if isStreaming && queueLength > 0}
			<div class="hidden md:flex mt-1.5 max-w-3xl mx-auto items-center gap-3">
				<p class="text-[11px] font-mono uppercase tracking-widest text-text-subtle shrink-0">
					{queueLength} {t('chat.hint_queued')}
				</p>
				<button onclick={cancelQueue} class="text-[11px] font-mono uppercase tracking-widest text-danger hover:text-danger/80 transition-colors shrink-0">
					{t('chat.cancel_queue')}
				</button>
			</div>
		{/if}
	</div>
</div>

{#if showVaultCheckpoint && vaultCheckpointKey}
	<div class="fixed inset-0 z-[9998] bg-black/40 flex items-center justify-center" role="dialog" aria-modal="true" tabindex="-1"
		onkeydown={(e) => { if (e.key === 'Escape') confirmVaultCheckpoint(); }}
	>
		<div class="bg-bg border border-border rounded-[var(--radius-md)] p-6 max-w-md mx-4 space-y-4">
			<div>
				<h2 class="text-base font-medium text-text">{t('onboard.vault_title')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('onboard.vault_desc')}</p>
			</div>
			<div class="flex items-center gap-2">
				<code class="flex-1 rounded-[var(--radius-sm)] bg-bg-subtle px-3 py-2 text-sm font-mono select-all break-all">
					{vaultCheckpointRevealed ? vaultCheckpointKey : maskCheckpointKey(vaultCheckpointKey)}
				</code>
				<button onclick={() => (vaultCheckpointRevealed = !vaultCheckpointRevealed)} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0">
					{vaultCheckpointRevealed ? t('config.hide') : t('config.reveal')}
				</button>
				<button onclick={copyCheckpointKey} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0 {vaultCheckpointCopied ? 'text-success border-success/30' : ''}">
					{t('config.copy')}
				</button>
			</div>
			<p class="text-xs text-text-muted">{t('config.vault_key_hint')}</p>
			<div class="flex gap-2">
				<button onclick={confirmVaultCheckpoint} class="flex-1 rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90">
					{t('onboard.vault_confirm_btn')}
				</button>
				<button onclick={confirmVaultCheckpoint} class="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover transition-all">
					{t('onboard.vault_skip_btn')}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* On touch devices (no hover capability), reveal hover-only action buttons
	   like the per-message copy + speak controls. Without this, the
	   `opacity-0 group-hover/copy:opacity-100` Tailwind pattern leaves them
	   permanently invisible on iOS/Android because :hover never fires. */
	@media (hover: none) {
		:global(.opacity-0.group-hover\/copy\:opacity-100) {
			opacity: 1;
		}
	}

	@keyframes fadeUp {
		from { opacity: 0; transform: translateY(12px); }
		to { opacity: 1; transform: translateY(0); }
	}
	@keyframes iconEntrance {
		0% { opacity: 0; transform: scale(0.5) rotate(-10deg); }
		60% { opacity: 1; transform: scale(1.08) rotate(2deg); }
		100% { opacity: 1; transform: scale(1) rotate(0deg); }
	}
	@keyframes iconFloat {
		0%, 100% { transform: translateY(0); }
		50% { transform: translateY(-6px); }
	}
	@keyframes iconGlow {
		0%, 100% { filter: drop-shadow(0 0 8px rgba(101, 37, 239, 0.3)); }
		50% { filter: drop-shadow(0 0 20px rgba(101, 37, 239, 0.6)); }
	}
	.welcome-fade :global(.icon-entrance) {
		animation: iconEntrance 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}
	.welcome-fade :global(.icon-float) {
		animation: iconFloat 4s ease-in-out infinite, iconGlow 4s ease-in-out infinite;
	}
	:global(.sonar-wrap) {
		position: relative;
		width: 96px;
		height: 96px;
		margin: 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	:global(.pulse-ring) {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 72px;
		height: 72px;
		margin-top: -36px;
		margin-left: -36px;
		border-radius: 50%;
		border: 2px solid rgba(155, 138, 255, 0.4);
		z-index: 0;
		animation: sonarPulse 5s ease-out infinite;
	}
	:global(.pulse-ring-2) { animation-delay: 1.67s; }
	:global(.pulse-ring-3) { animation-delay: 3.33s; }
	@keyframes -global-sonarPulse {
		0% { transform: scale(0.8); opacity: 0.6; }
		50% { opacity: 0.3; }
		100% { transform: scale(2.5); opacity: 0; }
	}
	.welcome-fade :global(.welcome-greeting) {
		animation: fadeUp 0.8s ease-out 0.3s both;
	}
	.welcome-fade :global(blockquote) {
		animation: fadeUp 0.8s ease-out 0.6s both;
	}
	:global(.prompt-chip) {
		display: flex;
		align-items: center;
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border, #1a1a4a);
		background: var(--color-bg-subtle, #0a0a1a);
		cursor: pointer;
		transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
		text-align: left;
	}
	:global(.prompt-chip:hover) {
		border-color: var(--color-accent, #6525EF);
		box-shadow: 0 0 16px rgba(101, 37, 239, 0.08);
		background: var(--color-bg-muted, #0c0c20);
	}
	:global(.prompt-chip-text) {
		font-size: 0.8125rem;
		color: var(--color-text-muted, #8888aa);
	}
	:global(.prompt-chip:hover .prompt-chip-text) {
		color: var(--color-text, #e8e8f0);
	}
</style>
