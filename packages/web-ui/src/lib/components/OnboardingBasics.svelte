<!--
  Onboarding Wave 1 (D9v2) — Step-0 engine basics.
  The engine poses the identity catalog questions (company/role) VERBATIM; the answers are
  promoted directly to durable knowledge as user_asserted (the model is never in this
  path). This is the "clean phase" before any web_research taints the thread.
  Decoupled from the model run: a plain start -> reply-tabs -> promote request cycle.
  Fails OPEN — if the basics can't run, onboarding continues to the website scan.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';

	interface Props {
		/** The onboarding thread's session id — carries source_thread_id on every promoted fact. */
		sessionId: string;
		/** Basics promoted (or skipped) — advance to the scan step. Carries the typed
		 *  company name (or null) so the scan step can pre-fill a candidate domain. */
		onDone: (company: string | null) => void;
	}
	let { sessionId, onDone }: Props = $props();

	/** The typed company answer, matched by its stable catalog header (not position). */
	function companyAnswer(): string | null {
		const i = questions.findIndex((q) => q.header === 'Company');
		const val = (i >= 0 ? answers[i] : answers[0])?.trim();
		return val && val.length > 0 ? val : null;
	}

	interface BasicQuestion {
		question: string;
		header?: string | undefined;
	}

	let questions = $state<BasicQuestion[]>([]);
	let answers = $state<string[]>([]);
	let promptId = $state('');
	let loading = $state(true);
	let saving = $state(false);

	onMount(() => {
		void start();
	});

	async function start(): Promise<void> {
		loading = true;
		try {
			const lang = getLocale() === 'de' ? 'de' : 'en';
			const res = await fetch(`${getApiBase()}/onboarding/knowledge/start`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId, lang }),
			});
			if (!res.ok) {
				onDone(null); // fail open — skip the basics, continue onboarding
				return;
			}
			const data = (await res.json()) as { promptId: string; questions: BasicQuestion[] };
			promptId = data.promptId;
			questions = data.questions;
			answers = data.questions.map(() => '');
		} catch {
			onDone(null); // engine unreachable — don't block onboarding
		} finally {
			loading = false;
		}
	}

	async function save(): Promise<void> {
		if (saving || !promptId) return;
		saving = true;
		try {
			// Settle the tabs prompt with the typed answers, then promote. A blank answer
			// rides the canonical skip marker — the engine promotion writes nothing for it.
			await fetch(`${getApiBase()}/sessions/${sessionId}/reply-tabs`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ promptId, answers: answers.map((a) => a.trim() || '__dismissed__') }),
			});
			await fetch(`${getApiBase()}/onboarding/knowledge/promote`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ promptId }),
			});
		} catch {
			/* best-effort — onboarding continues regardless of a promote hiccup */
		} finally {
			saving = false;
			onDone(companyAnswer());
		}
	}

	function onKeydown(e: KeyboardEvent, idx: number): void {
		// Enter on the last field submits; on an earlier field, advance focus is left to the browser.
		if (e.key === 'Enter' && idx === questions.length - 1) {
			e.preventDefault();
			void save();
		}
	}
</script>

<div class="w-full rounded-[var(--radius-md)] border border-accent/40 bg-accent/10 p-4 space-y-3.5">
	<div class="flex items-center gap-3">
		<span class="flex shrink-0 items-center justify-center w-7 h-7 rounded-full text-sm bg-accent/20 text-accent-text">1</span>
		<div class="flex-1 min-w-0">
			<span class="text-sm font-medium text-text">{t('onboard.basics_step')}</span>
			<span class="ml-2 text-[10px] font-mono uppercase tracking-widest text-accent-text">{t('onboard.step')} 1/4</span>
		</div>
	</div>

	{#if loading}
		<div class="flex items-center gap-2 py-2 text-sm text-text-muted">
			<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
			<span>…</span>
		</div>
	{:else}
		<div class="space-y-3">
			{#each questions as q, idx (idx)}
				<div>
					<label for={`onb-basic-${idx}`} class="block text-[13px] font-medium text-text mb-1">{q.question}</label>
					<input
						id={`onb-basic-${idx}`}
						bind:value={answers[idx]}
						onkeydown={(e) => onKeydown(e, idx)}
						disabled={saving}
						class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[16px] md:text-sm text-text outline-none focus:border-accent/60 disabled:opacity-50"
					/>
				</div>
			{/each}
		</div>
		<div class="flex items-center gap-2 pt-0.5">
			<button
				onclick={() => void save()}
				disabled={saving}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-40 transition-opacity"
			>
				{saving ? t('onboard.basics_saving') : t('onboard.basics_save')}
			</button>
			<button
				onclick={() => onDone(null)}
				disabled={saving}
				class="rounded-[var(--radius-sm)] px-3 py-2 text-sm text-text-muted hover:text-text disabled:opacity-40 transition-colors"
			>
				{t('onboard.skip_onboarding')}
			</button>
		</div>
	{/if}
</div>
