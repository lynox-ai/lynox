<script lang="ts">
	// WhatsApp inbox — Phase 0 MVP. List threads, read messages (incl. voice
	// transcripts), type and send. LLM-assisted drafting happens in the main
	// chat via the `whatsapp` tool; this view is the manual mirror.

	import { onMount, onDestroy } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	type Direction = 'inbound' | 'outbound';
	type Kind = 'text' | 'voice' | 'image' | 'document' | 'location' | 'contact' | 'sticker' | 'reaction' | 'unsupported';

	interface ThreadSummary {
		threadId: string;
		phoneE164: string;
		displayName: string | null;
		lastMessageAt: number;
		lastMessagePreview: string;
		unreadCount: number;
		hasVoiceNote: boolean;
	}
	interface WhatsAppMessage {
		id: string;
		threadId: string;
		phoneE164: string;
		direction: Direction;
		kind: Kind;
		text: string | null;
		transcript: string | null;
		mimeType: string | null;
		timestamp: number;
		isEcho: boolean;
	}
	interface ContactInfo {
		phoneE164: string;
		displayName: string | null;
		profileName: string | null;
		lastSeenAt: number;
	}

	interface Status { featureEnabled: boolean; available: boolean; configured: boolean; }

	let featureEnabled = $state<boolean | null>(null);
	let threads = $state<ThreadSummary[]>([]);
	let loading = $state(true);
	let selectedThreadId = $state<string | null>(null);
	let messages = $state<WhatsAppMessage[]>([]);
	let contact = $state<ContactInfo | null>(null);
	let loadingThread = $state(false);
	let composeText = $state('');
	let sending = $state(false);
	let filterText = $state('');
	let replyingTo = $state<WhatsAppMessage | null>(null);
	let composeTextarea = $state<HTMLTextAreaElement | null>(null);
	let showEmojis = $state(false);

	// Curated set covering ~95% of real conversational usage without pulling in
	// a 10-MB emoji library. Recents (localStorage) float to the front.
	const DEFAULT_EMOJIS = ['😊','😂','❤️','👍','🙏','🎉','👌','✅','🔥','💯','😅','🤔','👋','😍','🥰','😭','😎','👏','🙌','💪','☝️','👇','🤝','🙈','🤷','😉','😬','😴','🤗','😇'];
	const EMOJI_RECENTS_KEY = 'lynox-whatsapp-emoji-recents';
	function loadEmojiRecents(): string[] {
		if (typeof localStorage === 'undefined') return [];
		try {
			const raw = localStorage.getItem(EMOJI_RECENTS_KEY);
			if (!raw) return [];
			const arr: unknown = JSON.parse(raw);
			if (!Array.isArray(arr)) return [];
			return arr.filter((x: unknown): x is string => typeof x === 'string').slice(0, 8);
		} catch { return []; }
	}
	let emojiRecents = $state<string[]>(loadEmojiRecents());
	const emojiList = $derived.by(() => {
		const seen = new Set(emojiRecents);
		const rest = DEFAULT_EMOJIS.filter(e => !seen.has(e));
		return [...emojiRecents, ...rest];
	});

	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	// Pause polling when the browser tab is hidden to save battery on mobile.
	// Resume + immediate refresh on visibilitychange when the tab comes back.
	let tabVisible = $state(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true);

	// Per-thread draft cache, persisted in localStorage so a page refresh
	// mid-reply doesn't lose what the user was typing.
	const DRAFT_STORAGE_KEY = 'lynox-whatsapp-drafts';
	function loadDraftsFromStorage(): Record<string, string> {
		if (typeof localStorage === 'undefined') return {};
		try {
			const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
			if (!raw) return {};
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== 'object' || parsed === null) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof v === 'string') out[k] = v;
			}
			return out;
		} catch { return {}; }
	}
	function persistDrafts(): void {
		if (typeof localStorage === 'undefined') return;
		try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)); } catch { /* quota or disabled */ }
	}
	let drafts = $state<Record<string, string>>(loadDraftsFromStorage());

	const filteredThreads = $derived.by(() => {
		const q = filterText.trim().toLowerCase();
		if (q.length === 0) return threads;
		return threads.filter(t =>
			(t.displayName && t.displayName.toLowerCase().includes(q)) ||
			t.phoneE164.includes(q.replace(/[^0-9]/g, '')) ||
			t.lastMessagePreview.toLowerCase().includes(q),
		);
	});

	async function loadStatus(): Promise<boolean> {
		try {
			const res = await fetch(`${getApiBase()}/whatsapp/status`);
			if (!res.ok) return false;
			const data = await res.json() as Status;
			featureEnabled = data.featureEnabled;
			return data.featureEnabled;
		} catch {
			featureEnabled = false;
			return false;
		}
	}

	const selectedThread = $derived(
		selectedThreadId ? threads.find(t => t.threadId === selectedThreadId) ?? null : null,
	);

	async function loadInbox() {
		try {
			const res = await fetch(`${getApiBase()}/whatsapp/threads`);
			if (!res.ok) throw new Error();
			const data = await res.json() as { threads: ThreadSummary[] };
			threads = data.threads;
		} catch {
			threads = [];
		}
		loading = false;
	}

	async function openThread(threadId: string) {
		// Save the in-progress draft for the thread the user is leaving.
		if (selectedThreadId && selectedThreadId !== threadId) {
			const trimmed = composeText.trim();
			if (trimmed.length > 0) drafts[selectedThreadId] = composeText;
			else delete drafts[selectedThreadId];
			persistDrafts();
		}
		selectedThreadId = threadId;
		composeText = drafts[threadId] ?? '';
		loadingThread = true;
		messages = [];
		contact = null;
		try {
			const res = await fetch(`${getApiBase()}/whatsapp/threads/${encodeURIComponent(threadId)}`);
			if (!res.ok) throw new Error();
			const data = await res.json() as { messages: WhatsAppMessage[]; contact: ContactInfo | null };
			messages = data.messages;
			contact = data.contact;
			// Mark as read (fire-and-forget).
			void fetch(`${getApiBase()}/whatsapp/threads/${encodeURIComponent(threadId)}/read`, { method: 'POST' });
			await loadInbox(); // refresh unread counts
		} catch {
			addToast('Thread konnte nicht geladen werden', 'error');
		}
		loadingThread = false;
	}

	// ── Composer: formatting toolbar + emoji picker + reply-quote ──

	function wrapSelection(prefix: string, suffix: string): void {
		const ta = composeTextarea;
		if (!ta) return;
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		const selected = composeText.slice(start, end);
		const before = composeText.slice(0, start);
		const after = composeText.slice(end);
		composeText = `${before}${prefix}${selected}${suffix}${after}`;
		// Restore selection around the wrapped text.
		const newStart = start + prefix.length;
		const newEnd = newStart + selected.length;
		requestAnimationFrame(() => {
			ta.focus();
			ta.setSelectionRange(newStart, newEnd);
		});
	}

	function insertEmoji(e: string): void {
		const ta = composeTextarea;
		const pos = ta?.selectionStart ?? composeText.length;
		composeText = `${composeText.slice(0, pos)}${e}${composeText.slice(pos)}`;
		// Bump this emoji to the front of recents and persist.
		emojiRecents = [e, ...emojiRecents.filter(x => x !== e)].slice(0, 8);
		if (typeof localStorage !== 'undefined') {
			try { localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(emojiRecents)); } catch { /* quota */ }
		}
		showEmojis = false;
		requestAnimationFrame(() => {
			if (!ta) return;
			ta.focus();
			const newPos = pos + e.length;
			ta.setSelectionRange(newPos, newPos);
		});
	}

	function startReply(m: WhatsAppMessage): void {
		replyingTo = m;
		requestAnimationFrame(() => composeTextarea?.focus());
	}

	function cancelReply(): void {
		replyingTo = null;
	}

	function replyPreview(m: WhatsAppMessage): string {
		if (m.transcript) return `🎤 ${m.transcript}`;
		if (m.text) return m.text;
		switch (m.kind) {
			case 'voice': return '🎤 Sprachnachricht';
			case 'image': return '🖼️ Bild';
			case 'document': return '📄 Dokument';
			default: return `[${m.kind}]`;
		}
	}

	async function sendReply() {
		const body = composeText.trim();
		if (!body || !selectedThread) return;
		sending = true;
		try {
			const payload: Record<string, unknown> = { to: selectedThread.phoneE164, body };
			if (replyingTo) payload['replyTo'] = replyingTo.id;
			const res = await fetch(`${getApiBase()}/whatsapp/send`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({ error: 'Send failed' }))) as { error?: string };
				throw new Error(err.error ?? 'Send failed');
			}
			composeText = '';
			replyingTo = null;
			// Clear the persisted draft for this thread on successful send.
			delete drafts[selectedThread.threadId];
			persistDrafts();
			addToast('Gesendet', 'success', 1500);
			// Reload thread to reflect the new message + refresh inbox.
			await openThread(selectedThread.threadId);
		} catch (e) {
			addToast(e instanceof Error ? e.message : 'Send fehlgeschlagen', 'error');
		}
		sending = false;
	}

	function fmtDate(ts: number): string {
		const d = new Date(ts * 1000);
		const now = new Date();
		const isToday = d.toDateString() === now.toDateString();
		return isToday
			? d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' }) + ' ' +
			  d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
	}

	function messageBody(m: WhatsAppMessage): string {
		if (m.transcript) return m.transcript;
		if (m.text) return m.text;
		switch (m.kind) {
			// Voice bubbles render the <audio> element separately — the text row is
			// only shown to fall back when transcription isn't done yet.
			case 'voice': return '';
			case 'image': return '🖼️ Bild';
			case 'document': return '📄 Dokument';
			case 'location': return '📍 Standort';
			case 'contact': return '👤 Kontakt';
			case 'sticker': return 'Sticker';
			case 'reaction': return 'Reaktion';
			default: return '[nicht unterstützter Inhalt]';
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		// Enter submits, Shift+Enter inserts a newline (standard messenger UX)
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void sendReply();
		}
	}

	function handleVisibilityChange() {
		tabVisible = document.visibilityState === 'visible';
		if (tabVisible) {
			// Immediate refresh when the user returns to the tab so they aren't
			// staring at stale data for up to the next poll tick.
			void loadInbox();
			if (selectedThreadId) void openThread(selectedThreadId);
		}
	}

	onMount(async () => {
		const enabled = await loadStatus();
		if (!enabled) { loading = false; return; }
		void loadInbox();
		document.addEventListener('visibilitychange', handleVisibilityChange);
		// Poll every 10s for new messages — skip ticks when tab is hidden so
		// mobile browsers don't drain the battery while the UI isn't visible.
		// Phase 1 replaces this with SSE push.
		refreshTimer = setInterval(() => {
			if (!tabVisible) return;
			void loadInbox();
			if (selectedThreadId) void openThread(selectedThreadId);
		}, 10_000);
	});

	onDestroy(() => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}
	});
</script>

{#if featureEnabled === false}
	<div class="feature-off">
		<h2>WhatsApp Inbox nicht aktiviert</h2>
		<p>Dieses Feature ist derzeit nicht für deine Instanz freigeschaltet.</p>
	</div>
{:else}
<div class="wa-inbox">
	<aside class="thread-list">
		<header>
			<h2>WhatsApp</h2>
			<button class="refresh" onclick={loadInbox} disabled={loading} aria-label="Neu laden">↻</button>
		</header>
		{#if loading}
			<p class="muted">Lade …</p>
		{:else if threads.length === 0}
			<p class="muted">Noch keine WhatsApp-Nachrichten. Warte auf eingehende Nachrichten oder prüfe die Integration.</p>
		{:else}
			<input
				type="search"
				class="filter"
				placeholder="Name, Nummer oder Text …"
				bind:value={filterText}
				aria-label="Threads filtern"
			/>
			{#if filteredThreads.length === 0}
				<p class="muted">Kein Treffer für „{filterText}".</p>
			{/if}
			<ul>
				{#each filteredThreads as thread (thread.threadId)}
					<li>
						<button
							class="thread-item"
							class:active={selectedThreadId === thread.threadId}
							class:unread={thread.unreadCount > 0}
							onclick={() => openThread(thread.threadId)}
						>
							<div class="thread-head">
								<span class="name">{thread.displayName ?? thread.phoneE164}</span>
								<span class="time">{fmtDate(thread.lastMessageAt)}</span>
							</div>
							<div class="preview">
								{#if thread.hasVoiceNote}🎤 {/if}
								{thread.lastMessagePreview}
							</div>
							{#if thread.unreadCount > 0}
								<span class="badge">{thread.unreadCount}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</aside>

	<section class="thread-view">
		{#if !selectedThreadId}
			<div class="placeholder">Wähle einen Chat aus der Liste.</div>
		{:else if loadingThread}
			<div class="placeholder">Lade Thread …</div>
		{:else}
			<header class="thread-header">
				<h3>{contact?.displayName ?? selectedThread?.phoneE164}</h3>
				<p class="phone">+{selectedThread?.phoneE164}</p>
			</header>
			<div class="messages">
				{#each messages as msg (msg.id)}
					<div class="msg" class:out={msg.direction === 'outbound'} class:echo={msg.isEcho}>
						<div class="bubble">
							{#if msg.kind === 'voice'}
								<div class="voice-badge">
									🎤
									{#if msg.transcript}
										Transkript (Voxtral)
									{:else}
										Wird transkribiert…
									{/if}
								</div>
								<audio controls preload="none" src="{getApiBase()}/whatsapp/media/{encodeURIComponent(msg.id)}">
									<track kind="captions" />
								</audio>
							{/if}
							<div class="body">{messageBody(msg)}</div>
							<div class="meta">
								{fmtDate(msg.timestamp)}
								{#if msg.isEcho}· via Mobile App{/if}
							</div>
							<button class="reply-btn" title="Antworten" aria-label="Antworten" onclick={() => startReply(msg)}>↩</button>
						</div>
					</div>
				{/each}
			</div>
			<div class="compose">
				{#if replyingTo}
					<div class="reply-preview">
						<div class="reply-col">
							<div class="reply-meta">Antwort auf {replyingTo.direction === 'outbound' ? 'dich' : (contact?.displayName ?? 'Kontakt')}</div>
							<div class="reply-body">{replyPreview(replyingTo)}</div>
						</div>
						<button class="reply-close" onclick={cancelReply} aria-label="Antwort verwerfen">×</button>
					</div>
				{/if}
				<div class="format-bar">
					<button type="button" class="fmt" title="Fett (*text*)" onclick={() => wrapSelection('*', '*')}><strong>B</strong></button>
					<button type="button" class="fmt" title="Kursiv (_text_)" onclick={() => wrapSelection('_', '_')}><em>I</em></button>
					<button type="button" class="fmt" title="Durchgestrichen (~text~)" onclick={() => wrapSelection('~', '~')}><s>S</s></button>
					<button type="button" class="fmt" title="Code (```text```)" onclick={() => wrapSelection('```', '```')}>&lt;/&gt;</button>
					<button type="button" class="fmt emoji-toggle" title="Emoji" onclick={() => { showEmojis = !showEmojis; }}>😊</button>
				</div>
				{#if showEmojis}
					<div class="emoji-popup" role="menu">
						{#each emojiList as e (e)}
							<button type="button" class="emoji" onclick={() => insertEmoji(e)}>{e}</button>
						{/each}
					</div>
				{/if}
				<div class="compose-row">
					<textarea
						bind:this={composeTextarea}
						bind:value={composeText}
						onkeydown={handleKeydown}
						placeholder="Antwort schreiben… (Enter = senden, Shift+Enter = neue Zeile)"
						rows="2"
						disabled={sending}
					></textarea>
					<button class="send" onclick={sendReply} disabled={sending || composeText.trim().length === 0}>
						{sending ? 'Sende …' : 'Senden'}
					</button>
				</div>
			</div>
		{/if}
	</section>
</div>
{/if}

<style>
	.feature-off { padding: 3rem 1.5rem; text-align: center; color: var(--color-muted, #888); }
	.feature-off h2 { margin-bottom: 0.5rem; font-size: 1.2rem; color: inherit; }
	.wa-inbox {
		display: grid;
		grid-template-columns: 320px 1fr;
		height: 100%;
		min-height: 500px;
		background: var(--color-bg, #0d0d0d);
	}
	.thread-list {
		border-right: 1px solid var(--color-border, #2a2a2a);
		overflow-y: auto;
		padding: 0.75rem;
	}
	.thread-list header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--color-border, #2a2a2a);
		margin-bottom: 0.5rem;
	}
	.thread-list h2 { margin: 0; font-size: 1.05rem; }
	.refresh {
		background: none; border: 1px solid var(--color-border, #333); color: inherit;
		border-radius: 999px; width: 28px; height: 28px; cursor: pointer;
	}
	.refresh:hover { background: rgba(255,255,255,0.05); }
	.thread-list ul { list-style: none; margin: 0; padding: 0; }
	.filter {
		width: 100%; padding: 0.35rem 0.55rem; margin-bottom: 0.4rem;
		border-radius: 0.35rem; border: 1px solid var(--color-border, #333);
		background: var(--color-bg, #0d0d0d); color: inherit;
		font-family: inherit; font-size: 0.8rem;
	}
	.thread-list li { margin: 0; }
	.thread-item {
		width: 100%; text-align: left; background: none; border: none;
		color: inherit; padding: 0.6rem 0.5rem; border-radius: 0.4rem;
		cursor: pointer; position: relative; display: block;
		border-bottom: 1px solid rgba(255,255,255,0.04);
	}
	.thread-item:hover { background: rgba(255,255,255,0.04); }
	.thread-item.active { background: rgba(59, 130, 246, 0.08); }
	.thread-item.unread .name { font-weight: 600; }
	.thread-head { display: flex; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.15rem; }
	.name { font-size: 0.9rem; }
	.time { font-size: 0.7rem; color: var(--color-muted, #888); white-space: nowrap; }
	.preview {
		font-size: 0.8rem; color: var(--color-muted, #aaa);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.badge {
		position: absolute; top: 0.5rem; right: 0.5rem;
		background: #3b82f6; color: white; font-size: 0.7rem;
		padding: 0.05rem 0.4rem; border-radius: 0.8rem;
	}
	.thread-view { display: flex; flex-direction: column; height: 100%; }
	.placeholder {
		display: flex; align-items: center; justify-content: center;
		flex: 1; color: var(--color-muted, #888);
	}
	.thread-header {
		padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-border, #2a2a2a);
	}
	.thread-header h3 { margin: 0; font-size: 1rem; }
	.phone { margin: 0.1rem 0 0 0; color: var(--color-muted, #888); font-size: 0.75rem; }
	.messages {
		flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem;
	}
	.msg { display: flex; }
	.msg.out { justify-content: flex-end; }
	.bubble {
		max-width: 70%; padding: 0.5rem 0.75rem; border-radius: 0.6rem;
		background: rgba(255,255,255,0.05); font-size: 0.9rem;
	}
	.msg.out .bubble { background: rgba(59, 130, 246, 0.15); }
	.msg.echo .bubble { background: rgba(168, 85, 247, 0.12); }
	.voice-badge { font-size: 0.65rem; color: var(--color-muted, #bbb); margin-bottom: 0.25rem; }
	.bubble audio { width: 100%; margin: 0.25rem 0; max-width: 280px; }
	.body { white-space: pre-wrap; word-break: break-word; }
	.body:empty { display: none; }
	.meta { font-size: 0.65rem; color: var(--color-muted, #888); margin-top: 0.25rem; }
	.compose {
		padding: 0.75rem 1rem; border-top: 1px solid var(--color-border, #2a2a2a);
		display: flex; flex-direction: column; gap: 0.4rem;
	}
	.compose-row {
		display: flex; gap: 0.5rem; align-items: flex-end;
	}
	.compose textarea {
		flex: 1; padding: 0.5rem; border-radius: 0.3rem;
		border: 1px solid var(--color-border, #333); background: var(--color-bg, #0d0d0d);
		color: inherit; font-family: inherit; font-size: 0.9rem; resize: vertical; min-height: 2.2rem;
	}
	.compose .send {
		background: #3b82f6; color: white; border: none; border-radius: 0.3rem;
		padding: 0.5rem 1rem; cursor: pointer; font-size: 0.9rem; white-space: nowrap;
	}
	.compose .send:disabled { opacity: 0.5; cursor: not-allowed; }

	.format-bar { display: flex; gap: 0.2rem; flex-wrap: wrap; }
	.fmt {
		background: transparent; border: 1px solid var(--color-border, #333);
		border-radius: 0.25rem; color: var(--color-muted, #bbb);
		font-size: 0.8rem; padding: 0.15rem 0.5rem; min-width: 1.8rem; cursor: pointer;
	}
	.fmt:hover { background: rgba(255,255,255,0.05); }
	.fmt strong, .fmt em, .fmt s { font-family: inherit; }
	.emoji-popup {
		display: grid; grid-template-columns: repeat(8, 1fr); gap: 0.1rem;
		padding: 0.4rem; background: var(--color-surface, #141414);
		border: 1px solid var(--color-border, #333); border-radius: 0.3rem;
		max-width: 100%;
	}
	.emoji {
		background: transparent; border: none; font-size: 1.1rem;
		padding: 0.2rem; cursor: pointer; border-radius: 0.2rem;
	}
	.emoji:hover { background: rgba(255,255,255,0.08); }

	.reply-preview {
		display: flex; gap: 0.5rem; align-items: flex-start;
		padding: 0.4rem 0.6rem;
		border-left: 3px solid #3b82f6;
		background: rgba(59, 130, 246, 0.08); border-radius: 0.3rem;
	}
	.reply-col { flex: 1; min-width: 0; }
	.reply-meta { font-size: 0.7rem; color: var(--color-muted, #888); }
	.reply-body {
		font-size: 0.85rem; color: var(--color-muted, #ccc);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.reply-close {
		background: none; border: none; color: var(--color-muted, #888);
		font-size: 1.2rem; cursor: pointer; padding: 0 0.3rem;
	}
	.reply-btn {
		position: absolute; top: 0.25rem; right: 0.25rem;
		background: rgba(0,0,0,0.3); border: none; color: var(--color-muted, #aaa);
		font-size: 0.8rem; padding: 0.1rem 0.35rem; border-radius: 0.2rem;
		cursor: pointer; opacity: 0; transition: opacity 120ms;
	}
	.bubble { position: relative; }
	.bubble:hover .reply-btn { opacity: 1; }
	.reply-btn:hover { background: rgba(0,0,0,0.5); color: inherit; }

	@media (max-width: 760px) {
		.wa-inbox { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
		.thread-list { max-height: 40vh; border-right: none; border-bottom: 1px solid var(--color-border, #2a2a2a); }
	}
</style>
