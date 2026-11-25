<!--
	BulkRunDetail — one bulk run: its steps, counts, preview per target, and the owner's next
	act (PRD bulk-changes-reversible §3.9): start a run that waits for its start, approve a
	preview, confirm a probe, prepare and approve an undo. Each act sends what this page was
	shown — the approval checksum, the list's start checksum or the judge rule's hash the route
	returned with the run — so a run that changed since is refused, not approved.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { formatCost } from '../format.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import { isMandateSession, isOwnerSession, viewerNote } from '../stores/settings-viewer.svelte.js';
	import ViewerUnavailableNotice from './settings-readonly/ViewerUnavailableNotice.svelte';
	import BulkRefusedValue from './BulkRefusedValue.svelte';
	import BulkStartDomains from './BulkStartDomains.svelte';
	import BulkHost from './BulkHost.svelte';
	import {
		BULK_STEPS, bulkHostSplit, bulkLabelParts, bulkTemplateParts, bulkMandateI18n, bulkOne, bulkAtProbe, bulkCanUndo, bulkCostCap, bulkHaltCause, bulkHaltHeadKey, bulkHaltText, bulkInvalidText, bulkListFilterFolded, bulkListFilterText, bulkListStatusText, bulkSkippedHead, bulkFieldNamesText, bulkFieldLabelKey, bulkFieldShapeText, bulkSentenceParts, bulkSecretInContextKey, bulkFieldChoices, bulkStartHintKey, bulkHostOf, bulkIsShopifyHost, bulkJudgeProviderName, bulkManagedOf, bulkMarkupList, bulkRestartCap, bulkRestartKind, bulkResumeKind, bulkResumeMax, bulkResumeText, bulkRollbackIncomplete, bulkRollbackLeft, bulkSentUnknownText, bulkSentUnknownParts, bulkConflictsText, bulkSeoEntityCount, bulkStartButtonKey, bulkStartKind, bulkStep, bulkStepLabelKey, bulkSteps, bulkAfterTakenBack, bulkUndoneText, bulkTargetName, bulkTargetLabel, bulkEngineWorking, bulkFollowDelay, BULK_FOLLOW_MS, BULK_FOLLOW_MAX_MS, bulkSupportMailto, bulkUsd, bulkVisibleText, bulkSystemName, bulkValueText, bulkWaitsForStart, bulkWriting, BULK_DESELECT_REFUSALS, bulkTakesStartDomains, bulkHiddenSegments, bulkHiddenAddsOf, bulkHiddenCountText, bulkOutlierOrder, bulkOutlierReasonMap, bulkOutlierCountText, bulkOutlierSpreadTexts, bulkOutlierSpreadClosing, bulkOutlierSpreadSeqs, bulkOutlierShowText, bulkOutlierFilteredText, bulkRawText, bulkHiddenHtml, bulkUncheckedCountText, bulkHiddenUnchecked, bulkResumeWords, bulkRolledBackParts, bulkCountsPending, bulkHeadCounts, bulkWorkingLine, bulkWorkingStep,
		type BulkRunDetailData, type BulkTarget, type BulkSentencePart, type BulkMarkerKind, bulkRestartNoneNote, bulkReachRefusalKey, bulkReachHopeless, bulkShowsFailure,
	} from './bulk-runs.js';

	let { runId, onBack, onOpen }: { runId: string; onBack: () => void; onOpen: (id: string) => void } = $props();

	// A first page short enough that the owner's next act stays in view below it.
	const i18n = { t, tf };
	const FIRST_PAGE = 6;
	const PAGE = 500;

	let run = $state<BulkRunDetailData | null>(null);
	let targets = $state<BulkTarget[]>([]);
	let creates = $state<BulkTarget[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actionError = $state('');
	// A start check that can never pass refused approving or writing on this run (its id and the
	// engine's code): both stay off for it, with the cause by the button, until the page shows
	// another run, is opened again, or is loaded by the owner's own act.
	let hopeless = $state<{ id: string; code: string } | null>(null);
	let hopelessLine = $state<HTMLParagraphElement | null>(null);
	let busy = $state(false);
	// The owner asked to discard the run and is shown the confirmation (U-324).
	let confirmingDiscard = $state(false);
	let unmeasuredOk = $state(false);
	// Unchanged targets fold away: the owner checks what is written and what lynox leaves out.
	let showUnchanged = $state(false);
	// A run not loaded whole that leaves targets unchanged, or has written, opens on the targets its
	// plan changes, the written ones first, so what it wrote is on the page however late in the run
	// it comes (U-437). The unchanged ones and the rest load, in plan order, on the owner's ask.
	let changedOnly = $state(false);
	let probeOk = $state(false);
	let maxTargets = $state(1);
	// The spend limit of a judged start, as the owner types it; no default (there is no estimate).
	let capInput = $state('');
	// The started, unapproved judged run a judged start would end, once the engine has named it.
	let supersedable = $state<{ id: string; costUsd: number } | null>(null);
	// The link domains a judged list run's start allows, as the owner typed them, and whether
	// every line reads as a domain: a start with a wrong line waits, the engine's check is a net.
	let startDomains = $state<string[]>([]);
	let startDomainsValid = $state(true);
	// Whether this is a managed instance: two halt sentences name a different next step there.
	// Unknown (not yet loaded, or the config could not be read) reads as managed.
	let managed = $state<boolean | null>(null);

	async function json<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
		const res = await fetch(`${getApiBase()}${path}`, init);
		if (res.status === 429) lastRetryAfter = Number(res.headers.get('Retry-After'));
		const body = (await res.json().catch(() => ({}))) as T;
		return { ok: res.ok, status: res.status, body };
	}

	type PostBody = { error?: string; id?: string; code?: string; checksum?: string; supersedable?: { id: string; costUsd: number } };
	function post(path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: PostBody }> {
		return json(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		});
	}

	/** A page of the run's targets. A failed fetch throws: an empty page would read as a run
	 *  with fewer targets than the approval covers. */
	async function loadTargets(id: string, offset: number, limit: number, changed = false): Promise<BulkTarget[]> {
		const r = await json<{ targets?: BulkTarget[] }>(`/bulk/runs/${encodeURIComponent(id)}/targets?offset=${offset}&limit=${limit}${changed ? '&changed=1' : ''}`);
		if (!r.ok || !Array.isArray(r.body.targets)) throw new Error('targets');
		return r.body.targets;
	}

	/** Every target from `offset` on, page by page (the route serves at most PAGE at once). */
	async function loadFrom(id: string, offset: number, total: number): Promise<BulkTarget[]> {
		const out: BulkTarget[] = [];
		for (let at = offset; at < total; at += PAGE) {
			const page = await loadTargets(id, at, PAGE);
			out.push(...page);
			if (page.length < PAGE) break;
		}
		return out;
	}

	/** Every target an undo deletes — the entries its source created, listed in full. The
	 *  approval deletes all of them, so a list shorter than the run's own count is not shown
	 *  as the whole: it fails, and approving waits for a page that lists them all. */
	async function loadCreates(r: BulkRunDetailData): Promise<BulkTarget[]> {
		const out = (await loadFrom(r.id, 0, r.total)).filter((x) => x.change === 'delete');
		if (out.length !== r.changes.delete) throw new Error('creates');
		return out;
	}

	// The run a follow loop (below) belongs to: a new load for another run, or the page going
	// away, ends the loop of the one before.
	let following = 0;
	// The follow loop gave up after `BULK_FOLLOW_MAX_MS` while the run still worked: the page says so.
	let followStopped = $state(false);
	// What the engine's last 429 said to wait (Retry-After, seconds), for a follow loop's next wait.
	let lastRetryAfter: number | null = null;

	/** Ask for the run again while the engine moves it on by itself (a list read, a judging, a
	 *  write the owner started), so the page shows the next step without a reload. Only while the
	 *  tab is visible, one request an ask. While the run still works the page keeps what it shows:
	 *  its counts and the marks on its targets come from one load and agree. Once the run stopped
	 *  working, the page loads it once as on opening. A refused or failed ask or load leaves the
	 *  page as it is and waits longer ({@link bulkFollowDelay}); the loop ends once that load
	 *  succeeded, after `BULK_FOLLOW_MAX_MS`, or when the page shows another run. */
	async function follow(): Promise<void> {
		const mine = ++following;
		followStopped = false;
		const until = Date.now() + BULK_FOLLOW_MAX_MS;
		let delay = BULK_FOLLOW_MS;
		while (mine === following && run !== null && bulkEngineWorking(run) && Date.now() < until) {
			await new Promise((r) => setTimeout(r, delay));
			if (mine !== following) return;
			if (busy || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) continue;
			let res: Response | null = null;
			try {
				res = await fetch(`${getApiBase()}/bulk/runs/${encodeURIComponent(runId)}`);
			} catch {
				res = null;
			}
			if (mine !== following) return;
			const body = res?.ok ? ((await res.json().catch(() => null)) as BulkRunDetailData | null) : null;
			let retryAfter = res?.status === 429 ? Number(res.headers.get('Retry-After')) : null;
			let ok = body !== null;
			// A newer follow loop (another run, the page gone, a restarted follow) owns the page: this
			// answer is older than what it shows.
			if (mine !== following) return;
			const current = run;
			if (body !== null && bulkEngineWorking(body) && body.id === runId && current !== null) {
				if (body.phase !== current.phase || bulkWorkingStep(body) !== bulkWorkingStep(current)) {
					// Another step: the run is loaded anew, its targets and counts with it.
					lastRetryAfter = null;
					ok = await load({ quiet: true });
					if (!ok) retryAfter = lastRetryAfter;
				} else {
					// The same step: the page takes the run's progress from the ask, so the working line,
					// the head's counts, the warning about unclear sends, the cost and a pause move with the run. Every other count stays
					// as loaded, with the targets and their marks it speaks of; no input is offered then.
					run = {
						...current, applied: body.applied, conflicts: body.conflicts, failed: body.failed, heads: body.heads, sentUnknown: body.sentUnknown, judge: body.judge,
						costUsd: body.costUsd, resumesAt: body.resumesAt,
					};
				}
			}
			if (body !== null && !bulkEngineWorking(body)) {
				lastRetryAfter = null;
				ok = await load({ quiet: true });
				if (!ok) retryAfter = lastRetryAfter;
			}
			delay = bulkFollowDelay(delay, ok, retryAfter);
		}
		// Given up, not ended: the run still works and the page no longer asks.
		if (mine === following && run !== null && bulkEngineWorking(run) && Date.now() >= until) followStopped = true;
	}

	// Each load counts up; an answer is the page's only while no later load has begun. The run's id
	// alone does not tell: after A, B and back to A, the first load of A is no longer the page's.
	let loadGen = 0;

	/** Load the run and its targets. True when the page now shows them; false when the load
	 *  failed (a quiet load leaves the page as it was), the page moved on to another run, or a
	 *  later load replaced this one. */
	async function load(opts: { quiet?: boolean } = {}): Promise<boolean> {
		const quiet = opts.quiet === true;
		const id = runId;
		const gen = ++loadGen;
		const left = (): boolean => gen !== loadGen || id !== runId;
		if (!quiet) {
			loading = true;
			error = '';
			// A load the owner set off asks the run anew: a cause lynox fixed meanwhile no longer
			// keeps approving or writing on off, and the route answers again on the next press.
			hopeless = null;
		}
		try {
			const r = await json<BulkRunDetailData>(`/bulk/runs/${encodeURIComponent(id)}`);
			if (left()) return false;
			if (!r.ok) { if (!quiet) error = t('common.load_failed'); loading = false; return false; }
			// The run is shown only with its targets: a page that could not load them all shows
			// the error, never a run whose approval covers more than it lists.
			// A preview the owner approves is loaded whole: the approval covers every target, and
			// each one the owner may take out has to be on the page to be taken out.
			// So is a run whose rollback left targets: the sentence names the marked ones, and each
			// has to be on the page to be seen. So is a run with a product its store kept with markup
			// lynox did not send: the halt's sentence points at it, and the mark outlives that halt.
			// An undo the owner approves is loaded whole too: each target that writes markup back is
			// listed with it (1010), and an approval covers every one.
			const approving = r.body.phase === 'previewed';
			const whole = approving || bulkRollbackIncomplete(r.body) || (r.body.shopAddedMarkup ?? 0) > 0 || (r.body.hostRewrote ?? 0) > 0
				// A run whose targets add hidden characters: its count says they are marked in the
				// preview, at a probe too, so each has to be on the page.
				|| (r.body.hiddenAddsTargets ?? 0) > 0
				// So does one with a field that could not be checked for them: its sentence stands under it.
				|| (r.body.hiddenUncheckedTargets ?? 0) > 0
				// So does one halted on its failures: the step to check the targets with an error
				// stands only where one is marked, and a marked one may lie past the first page.
				|| r.body.haltKey === 'failureRate' || r.body.haltKey === 'consecutiveFailures';
			// Every page is asked for the run this load opened, never for one the page has moved to since.
			let firstChanged = !whole && (r.body.changes.unchanged > 0 || r.body.applied > 0);
			let shown = whole ? await loadFrom(id, 0, r.body.total) : await loadTargets(id, 0, FIRST_PAGE, firstChanged);
			// A run whose plan changes nothing opens on its first page as before: its unchanged
			// targets are what there is to show.
			if (firstChanged && shown.length === 0 && !left()) {
				firstChanged = false;
				shown = await loadTargets(id, 0, FIRST_PAGE);
			}
			// A short page ends the loading early: fewer targets than the run's count are not the whole.
			if (left()) return false;
			if (whole && shown.length !== r.body.total) { if (!quiet) error = t('common.load_failed'); loading = false; return false; }
			const deleted = r.body.kind === 'undo' ? await loadCreates(r.body) : [];
			// A load for a run the page no longer shows, or that a later load replaced, writes nothing.
			if (left()) return false;
			// Another run's domains are never sent with this one, and its wrong line never holds
			// this one's start.
			if (r.body.id !== run?.id) { startDomains = []; startDomainsValid = true; actionError = ''; showUnchanged = false; hopeless = null; }
			run = r.body;
			targets = shown;
			changedOnly = firstChanged;
			creates = deleted;
			// A follow ask runs only while the engine works, when the page offers the owner no input.
			maxTargets = Math.max(1, bulkWriting(run));
			unmeasuredOk = false;
			probeOk = false;
			supersedable = null;
		} catch {
			if (left()) return false;
			if (!quiet) error = t('common.load_failed');
			loading = false;
			return false;
		}
		loading = false;
		if (!quiet && run !== null && bulkEngineWorking(run)) void follow();
		return true;
	}

	/** Loads the rest of the run; true once the page shows it. */
	async function showMore(): Promise<boolean> {
		// While another run loads, the page still shows the one before: its rest is not asked for.
		if (!run || run.id !== runId) return false;
		// A list that a load has replaced since, or a run the page has left, is not appended to; a
		// load of this run that failed and replaced nothing does not drop it.
		const id = run.id;
		const shown = targets;
		const left = (): boolean => runId !== id || targets !== shown;
		try {
			// A page that holds only the changed targets loads the run whole, in plan order.
			const whole = changedOnly;
			const more = await loadFrom(id, whole ? 0 : targets.length, run.total);
			if (left()) return false;
			targets = whole ? more : [...targets, ...more];
			changedOnly = false;
			return true;
		} catch {
			if (left()) return false;
			actionError = t('common.load_failed');
			return false;
		}
	}

	async function act(fn: (id: string) => Promise<string | null>): Promise<void> {
		// While another run loads, the page still shows the one before: nothing it shows is sent
		// for the run it opens. Each act is bound to the run it began on: every request names that
		// run, and what comes back after the page moved to another run is not shown there.
		if (run === null || run.id !== runId) return;
		const id = runId;
		busy = true;
		actionError = '';
		try {
			const refusal = await fn(id);
			if (runId === id) {
				if (refusal !== null) actionError = refusal;
				else await load();
			}
		} catch {
			if (runId === id) actionError = t('common.load_failed');
		}
		busy = false;
	}

	// A run no one can be shown to have planned is refused a resume by its code, worded here.
	// The refusals with a sentence of the page's own; the engine's English is the fallback.
	const REFUSAL_KEYS: Readonly<Record<string, string>> = {
		planner_unknown: 'bulk.resume.refused.planner_unknown',
		start_domains_invalid: 'bulk.start_domains.invalid',
		start_domains_frozen: 'bulk.start_domains.frozen',
	};
	const hopelessReason = $derived.by(() => {
		if (hopeless === null || run === null || hopeless.id !== run.id) return null;
		const key = bulkReachRefusalKey(hopeless.code);
		return key !== null ? t(key) : null;
	});
	const refusalOf = (r: { ok: boolean; body: { error?: string; code?: string } }): string | null => {
		if (r.ok) return null;
		const code = r.body.code;
		const key = code !== undefined && Object.hasOwn(REFUSAL_KEYS, code) ? REFUSAL_KEYS[code] : code !== undefined ? bulkReachRefusalKey(code) ?? undefined : undefined;
		return key !== undefined ? t(key) : (r.body.error ?? t('common.load_failed'));
	};

	function approve(oneFirst: boolean): Promise<void> {
		return act(async (id) => {
			if (!run?.checksum) return t('common.load_failed');
			const r = await post(`/bulk/runs/${encodeURIComponent(id)}/approve`, {
				checksum: run.checksum,
				maxTargets: oneFirst ? 1 : maxTargets,
				...(run.writeForm === 'unmeasured' ? { unmeasuredConfirmed: unmeasuredOk } : {}),
			});
			return (await reachHopeless(id, r)) ? '' : refusalOf(r);
		});
	}

	/** After a toggle the run is asked for again — its counts and the checksum the approval
	 *  presents moved — but of its targets only the toggled one changed: it is marked here instead
	 *  of every page being loaded again. False where the run is no longer the preview this page
	 *  shows, could not be read, or is not the run the toggle answered: its checksum differs from
	 *  the one the toggle returned, so another view moved a target since (even a pair that cancels
	 *  out, which the counts cannot tell) and another row would be stale. The caller then loads it
	 *  whole. The toggle's compare-and-set proved the run was the one whose checksum the page holds,
	 *  and the ledger hashes its answer under the same lock as the write, so a run with the toggle's
	 *  checksum is that run plus this toggle, whoever else writes the database. */
	async function afterToggle(id: string, seq: number, deselected: boolean, checksum: string | undefined): Promise<boolean> {
		const before = run;
		const r = await json<BulkRunDetailData>(`/bulk/runs/${encodeURIComponent(id)}`);
		// A refused or failed ask carries no run, so no phase `previewed`.
		if (id !== runId || run !== before || before === null || r.body.phase !== 'previewed' || r.body.total !== before.total) return false;
		if (checksum === undefined || r.body.checksum !== checksum) return false;
		if (r.body.deselected !== before.deselected + (deselected ? 1 : -1)) return false;
		run = r.body;
		targets = targets.map((x) => (x.seq === seq ? { ...x, deselected } : x));
		maxTargets = Math.max(1, bulkWriting(r.body));
		unmeasuredOk = false;
		probeOk = false;
		supersedable = null;
		return true;
	}

	/** Take one target out of the write, or put it back, against the checksum this page showed:
	 *  each moves the checksum, so the page approves only the run as it now is. Like every act it is
	 *  bound to the run it began on: each request names that run, and what comes back after the page
	 *  moved to another run is not shown there. Unlike them it reloads only the run, not every target. */
	async function toggleSelected(target: BulkTarget): Promise<void> {
		if (run === null || run.id !== runId) return;
		const id = runId;
		busy = true;
		actionError = '';
		try {
			if (!run.checksum) {
				actionError = t('common.load_failed');
			} else {
				const deselect = target.deselected !== true;
				const r = await post(`/bulk/runs/${encodeURIComponent(id)}/targets/${target.seq}/${deselect ? 'deselect' : 'reselect'}`, { checksum: run.checksum });
				if (runId === id) {
					// The refusals the owner can meet here are worded by their code; the engine's English is the fallback.
					const code = r.body.code;
					if (!r.ok && code !== undefined && BULK_DESELECT_REFUSALS.includes(code)) actionError = t(`bulk.deselect.refused.${code}`);
					else if (!r.ok) actionError = refusalOf(r) ?? t('common.load_failed');
					else {
						// A run that could not be read after the toggle is loaded whole, so the page
						// shows no checksum from before a toggle that went through.
						const marked = await afterToggle(id, target.seq, deselect, r.body.checksum).catch(() => false);
						if (!marked && runId === id) await load();
					}
				}
			}
		} catch {
			if (runId === id) actionError = t('common.load_failed');
		}
		busy = false;
	}

	/** Discard a run before approving it: the owner's act alone (the route refuses a mandate), after
	 *  the confirmation; the page reloads and shows the run as discarded. */
	function discard(): Promise<void> {
		return act(async (id) => {
			const refusal = refusalOf(await post(`/bulk/runs/${encodeURIComponent(id)}/discard`));
			if (refusal === null) confirmingDiscard = false;
			return refusal;
		});
	}

	function approveUndo(): Promise<void> {
		return act(async (id) => {
			if (!run?.checksum) return t('common.load_failed');
			const r = await post(`/bulk/runs/${encodeURIComponent(id)}/approve`, { checksum: run.checksum });
			return (await reachHopeless(id, r)) ? '' : refusalOf(r);
		});
	}

	/** Approving or writing on again would meet the same refusal: both go off for this run, and the
	 *  cause is said by the button instead of as the act's error line (the act then answers an
	 *  empty error, so the run is not reloaded). The button that was pressed goes off under the focus,
	 *  so the focus moves to the cause. */
	async function reachHopeless(id: string, r: { ok: boolean; body: PostBody }): Promise<boolean> {
		if (r.ok || !bulkReachHopeless(r.body.code)) return false;
		// The page moved to another run while the approval was out: neither its state nor its focus.
		if (runId !== id) return true;
		hopeless = { id, code: r.body.code! };
		await tick();
		if (runId === id) hopelessLine?.focus();
		return true;
	}

	/** Confirm the probe, then resume with the cap the owner set — against the checksum of the
	 *  run as this page showed it. The checksum does not cover the probe, so confirming does
	 *  not move it; a run that changed since it was shown is refused, never resumed. */
	function confirmProbeAndResume(): Promise<void> {
		return act(async (id) => {
			if (!run?.checksum) return t('common.load_failed');
			const shown = run.checksum;
			const confirmed = await post(`/bulk/runs/${encodeURIComponent(id)}/confirm-probe`);
			if (!confirmed.ok) return refusalOf(confirmed);
			if (runId !== id) return null;
			const r = await post(`/bulk/runs/${encodeURIComponent(id)}/resume`, { checksum: shown, maxTargets });
			return (await reachHopeless(id, r)) ? '' : refusalOf(r);
		});
	}

	/** Start a run that waits for its start, with what this page showed: a list read with the
	 *  list's start checksum, a judged start with the rule's hash and the spend limit as typed.
	 *  A judged start never ends another run unasked: the engine names it, the owner sees what
	 *  it has spent, and only a second click with its id ends it. */
	function start(supersedes?: string): Promise<void> {
		return act(async (id) => {
			if (!run) return t('common.load_failed');
			const kind = bulkStartKind(run);
			let body: Record<string, unknown> = {};
			if (kind === 'list') {
				if (!run.listStartChecksum) return t('common.load_failed');
				body = { listChecksum: run.listStartChecksum };
			} else if (kind === 'judge') {
				const cap = bulkCostCap(capInput);
				if (cap === null) return t('bulk.start.cap_invalid');
				if (!run.judgeRuleHash) return t('common.load_failed');
				body = {
					judgeRuleHash: run.judgeRuleHash, costCapUsd: cap,
					// Sent only when the owner gave some: without a list the run has none, as before.
					...(bulkTakesStartDomains(run) && startDomains.length > 0 ? { startDomains } : {}),
					...(supersedes !== undefined ? { supersedes } : {}),
				};
			} else if (kind !== 'read') {
				return t('common.load_failed');
			}
			const r = await post(`/bulk/runs/${encodeURIComponent(id)}/resume`, body);
			// The page moved to another run meanwhile: nothing of this answer is that run's.
			if (runId !== id) return null;
			if (!r.ok && r.body.code === 'supersede_required' && r.body.supersedable) {
				supersedable = r.body.supersedable;
				return '';
			}
			// A refused start may have changed the run (an ended mandate ends it): show it as it is now.
			// If that reload fails, the page shows the refusal in place of the run, not that loading failed.
			const refusal = refusalOf(r);
			if (refusal !== null) {
				await load();
				if (runId !== id) return null;
				if (error) error = refusal;
			} else {
				// A started run that halts on its limit later offers an empty field, not this one.
				capInput = '';
			}
			return refusal;
		});
	}

	/** Move a planned run on that halted on a failure (`bulkRestartKind`), with what this page
	 *  showed: a list's start checksum, a judged run's rule hash, and on a run halted at its spend
	 *  limit the higher limit as typed. Without a new limit a judged run keeps the one it started
	 *  with. A judged restart ends another started judged run only as a start does: named first. */
	function restart(supersedes?: string): Promise<void> {
		return act(async (id) => {
			if (!run) return t('common.load_failed');
			const kind = bulkRestartKind(run);
			let body: Record<string, unknown> = {};
			if (kind === 'list') {
				if (!run.listStartChecksum) return t('common.load_failed');
				body = { listChecksum: run.listStartChecksum };
			} else if (kind === 'judge' || kind === 'judge_cap') {
				if (!run.judgeRuleHash) return t('common.load_failed');
				body = { judgeRuleHash: run.judgeRuleHash, ...(supersedes !== undefined ? { supersedes } : {}) };
				if (kind === 'judge_cap') {
					const cap = bulkRestartCap(capInput, run.costCapUsd);
					if (cap === null) return tf('bulk.restart.cap_low', { cap: bulkUsd(run.costCapUsd ?? 0) });
					body['costCapUsd'] = cap;
				}
			} else if (kind !== 'read') {
				return t('common.load_failed');
			}
			const r = await post(`/bulk/runs/${encodeURIComponent(id)}/resume`, body);
			// The page moved to another run meanwhile: nothing of this answer is that run's.
			if (runId !== id) return null;
			if (!r.ok && r.body.code === 'supersede_required' && r.body.supersedable) {
				supersedable = r.body.supersedable;
				return '';
			}
			const refusal = refusalOf(r);
			if (refusal !== null) {
				await load();
				if (runId !== id) return null;
				if (error) error = refusal;
			} else {
				capInput = '';
			}
			return refusal;
		});
	}

	/** Write on a run that halted while writing (`bulkResumeKind`), against the checksum of the
	 *  run as this page showed it: a run that changed since is refused, never written on. A run
	 *  halted at its maximum writes on only under the higher maximum the owner typed. `check` is
	 *  the same resume: its pass would send nothing and only reads the unclear targets. */
	function resume(): Promise<void> {
		return act(async (id) => {
			if (!run?.checksum) return t('common.load_failed');
			const kind = bulkResumeKind(run);
			const body: Record<string, unknown> = { checksum: run.checksum };
			if (kind === 'max') {
				const max = bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run));
				if (max === null) return tf('bulk.resume.max_more', { max: String(run.maxTargets ?? 0), all: String(bulkWriting(run)) });
				body['maxTargets'] = max;
			} else if (kind !== 'write' && kind !== 'check') {
				return t('common.load_failed');
			}
			const r = await post(`/bulk/runs/${encodeURIComponent(id)}/resume`, body);
			return (await reachHopeless(id, r)) ? '' : refusalOf(r);
		});
	}

	/** Plan the undo of this run; it is a run of its own, opened for its second approval. */
	function planUndo(): Promise<void> {
		return act(async (id) => {
			const r = await post(`/bulk/runs/${encodeURIComponent(id)}/undo`);
			if (!r.ok) return refusalOf(r);
			// The undo opens over the run it was planned from, not over one the page moved to since.
			if (r.body.id && runId === id) onOpen(r.body.id);
			return null;
		});
	}

	function when(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	}
	/** The day an earlier write was applied, as the owner reads a date. */
	function markedDateText(iso: string): string | null {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
	}

	$effect(() => { void runId; following++; followStopped = false; void load(); });
	// The page going away ends a follow loop.
	$effect(() => () => { following++; });
	$effect(() => {
		const noteViewer = viewerNote();
		fetch(`${getApiBase()}/config`)
			.then(async (r) => {
				const body: unknown = r.ok ? await r.json() : null;
				managed = bulkManagedOf(r.ok, body);
				// Whose session reads the run: a mandate's sees it without the owner's acts.
				noteViewer(body);
			})
			.catch(() => { managed = null; });
	});

	// Between two sentences of the probe's confirmation.
	const SENTENCE_GAP = ' ';
	const host = $derived(run ? bulkHostOf(run.targetSystem) || null : null);
	const atProbe = $derived(run !== null && bulkAtProbe(run));
	const step = $derived(run ? bulkStep(run) : 'planned');
	const steps = $derived(run ? bulkSteps(run) : BULK_STEPS);
	const undoneText = $derived(run ? bulkUndoneText(run, getLocale(), i18n) : null);
	const provider = $derived(run ? bulkSystemName(run.targetSystem, i18n) : '');
	// What the engine works on while it moves the run on by itself; the page keeps its counts until then.
	// The step cannot change while the page waits: a list read ends in its own halt (`listed`), the
	// judge is fixed at planning, and approved and writing are both the write. An interrupted run
	// that resumes later says so in its own line and gets no working line.
	const workingStep = $derived(run && !run.resumesAt ? bulkWorkingStep(run) : null);
	const workingLine = $derived(run && workingStep !== null ? bulkWorkingLine(workingStep, run) : null);
	// The probe's target by its title where the loaded targets hold its before-image.
	const probeLabel = $derived(run?.probe ? bulkTargetLabel(run.targetSystem, { key: run.probe.key }, i18n) : '');
	// The probe's admin link: its target is often not among the targets the page shows.
	const probeName = $derived(run?.probe ? bulkTargetName(run.targetSystem, { key: run.probe.key }) : null);
	// The unmeasured note in English is the engine's own sentence; German is the approved translation.
	// With one target to write the note keeps its first two sentences, here and in the engine's own (EN).
	const unmeasuredNote = $derived(getLocale() === 'de' || !run?.writeFormNote
		? t(run !== null && bulkWriting(run) === 1 ? 'bulk.approve.unmeasured_note_one' : 'bulk.approve.unmeasured_note')
		: run.writeFormNote);
	const unmeasuredConfirmation = $derived(getLocale() === 'de' || !run?.writeFormConfirmation ? t('bulk.approve.unmeasured_confirm') : run.writeFormConfirmation);
	const canUndo = $derived(run !== null && bulkCanUndo(run));
	const startKind = $derived(run ? bulkStartKind(run) : null);
	// The start button's label, from the same source as the button itself: the halt sentence names it.
	const startButton = $derived(run ? bulkStartButtonKey(run, startKind, supersedable !== null) : null);
	// Why the judged start is disabled, as a line under its buttons (U-333); the button points to it.
	// Not while a start is under way: it empties the cost field before the page shows the started run.
	const startHint = $derived(busy ? null : bulkStartHintKey(capInput, startDomainsValid));
	const supportMail = $derived(run ? bulkSupportMailto(run, managed, i18n) : null);
	// Every act on this page is the owner's (the routes refuse a mandate), so its buttons show only
	// once the server said the session is the owner's: a mandate does not see them even while the
	// answer is out. The sentence and the wording for a mandate wait for the server to say so.
	const ownerActs = $derived(isOwnerSession());
	const mandate = $derived(isMandateSession());
	// A sentence that names an owner's act names the owner to a mandate.
	const view = $derived(mandate ? bulkMandateI18n(i18n) : i18n);
	const restartKind = $derived(run ? bulkRestartKind(run) : null);
	const failureMarked = $derived(targets.some(bulkShowsFailure));
	const haltText = $derived(run ? bulkHaltText(run, managed, i18n, failureMarked) : null);
	// A long filter list is folded until the owner shows it all; for this run only (ux U-175).
	let filtersShownFor = $state<string | null>(null);
	const filtersFolded = $derived(run !== null && filtersShownFor !== run.id ? bulkListFilterFolded(run.listFilters) : 0);
	const listFilterText = $derived(run ? bulkListFilterText(run.listFilters, i18n, filtersFolded > 0) : null);
	// Which statuses a store's product list reads: drafts, archived products and gift cards unless a status narrows it.
	const listStatusText = $derived(run ? bulkListStatusText(run.listFilters, i18n) : null);
	let filterLine = $state<HTMLParagraphElement | null>(null);
	async function showAllFilters(): Promise<void> {
		if (run === null) return;
		filtersShownFor = run.id;
		// The button is gone: focus moves to the line it opened, not to nowhere.
		await tick();
		filterLine?.focus();
	}
	const resumeKind = $derived(run ? bulkResumeKind(run) : null);
	// Writing on was refused for good. The page shows the halt it was refused on until the owner's
	// own load, which asks the run anew and clears the refusal.
	const resumeHopeless = $derived(hopelessReason !== null);
	const resumeText = $derived(run ? bulkResumeText(run, managed, i18n, failureMarked) : null);
	const resumeWords = $derived(run ? bulkResumeWords(run, i18n) : null);
	const rolledBack = $derived(run ? bulkRolledBackParts(run, view) : null);
	const sentUnknownText = $derived(run ? bulkSentUnknownText(run, view) : null);
	const sentUnknownParts = $derived(run ? bulkSentUnknownParts(run, view) : null);
	const conflictsText = $derived(run ? bulkConflictsText(run, i18n) : null);
	const shopify = $derived(bulkIsShopifyHost(host));
	const approving = $derived(run !== null && run.phase === 'previewed' && run.kind === 'apply');
	const skipped = $derived(run && approving ? bulkSkippedHead(run, shopify, view) : { text: null, nothing: false });
	// Counted over the loaded targets: a preview the owner approves is loaded whole.
	const seoEntity = $derived(approving ? bulkSeoEntityCount(targets) : 0);
	// The table on one run line's verdicts alone (U-417), for this run only; the line above the table says so.
	let spreadShown = $state<{ run: string; kind: BulkMarkerKind } | null>(null);
	const spreadKind = $derived(approving && run !== null && spreadShown?.run === run.id ? spreadShown.kind : null);
	const spreadSeqs = $derived(bulkOutlierSpreadSeqs(approving ? run?.judgeOutliers : null, spreadKind));
	const unfolded = $derived(showUnchanged ? targets : targets.filter((x) => x.change !== 'unchanged'));
	const shownTargets = $derived(spreadSeqs === null ? unfolded : unfolded.filter((x) => spreadSeqs.has(x.seq)));
	function toggleSpread(kind: BulkMarkerKind): void {
		if (run === null) return;
		spreadShown = spreadKind === kind ? null : { run: run.id, kind };
	}
	// The buttons of the box by line: showing all from over the table removes that line, so the focus goes
	// back to the button of the same kind in the box.
	let spreadButtons = $state<(HTMLButtonElement | null)[]>([]);
	// Showing all from the approval: the focus stays at the approval, where the owner is; while its button
	// cannot be pressed, it goes to the button of that kind in the box.
	let approveButton = $state<HTMLButtonElement | null>(null);
	async function showAllAtApproval(): Promise<void> {
		const kind = spreadKind;
		spreadShown = null;
		await tick();
		if (approveButton !== null && !approveButton.disabled) { approveButton.focus(); return; }
		const i = (run?.judgeOutliers?.spread ?? []).findIndex((x) => x.kind === kind);
		if (i >= 0) spreadButtons[i]?.focus();
	}
	async function showAllFromTable(): Promise<void> {
		const kind = spreadKind;
		spreadShown = null;
		await tick();
		const i = (run?.judgeOutliers?.spread ?? []).findIndex((x) => x.kind === kind);
		if (i >= 0) spreadButtons[i]?.focus();
	}
	// The unchanged targets the run holds, as its counts say, while only the changed ones are loaded.
	const foldedUnchanged = $derived(changedOnly && run !== null ? run.changes.unchanged : targets.length - unfolded.length);
	async function showUnchangedTargets(): Promise<void> {
		// Unfolded only once they are on the page: a load that failed or was overtaken leaves the fold.
		if (changedOnly && !(await showMore())) return;
		showUnchanged = true;
	}
	const writes = (x: BulkTarget): boolean => x.change === 'update' || x.change === 'create' || x.change === 'delete';
	// The sentence under a field not checked for hidden characters: the way out only where the owner
	// can take the target out on this page (U-294).
	const uncheckedNoteKey = (x: BulkTarget): string =>
		approving && ownerActs && writes(x) && !x.deselected ? 'bulk.unchecked.field_take_out' : 'bulk.unchecked.field';
	// Hidden characters a target adds where text may carry one: the legend over the list
	// once any shown target is marked, and the count wherever the run is approved or confirmed.
	// A value taken back no longer holds what the legend says will be written (U-218): its mark
	// turns grey with it, and it calls for no legend.
	const hiddenMarked = $derived(run !== null && shownTargets.some((x) => (x.hiddenAdds?.length ?? 0) > 0 && !bulkAfterTakenBack(run!, x)));
	const hiddenCount = $derived(run ? bulkHiddenCountText(run.hiddenAddsTargets, shopify, view) : null);
	const uncheckedCount = $derived(run ? bulkUncheckedCountText(run.hiddenUncheckedTargets, shopify, view) : null);
	// A judged run's verdicts that differ from the rest of it: listed first, each with its reasons, and
	// a line over the list that says this is a reading order, not a check (U-387).
	const outliers = $derived(approving ? run?.judgeOutliers ?? null : null);
	const orderedTargets = $derived(bulkOutlierOrder(shownTargets, outliers));
	const outlierReasons = $derived(bulkOutlierReasonMap(outliers));
	const outlierCount = $derived(bulkOutlierCountText(outliers, view));
	const outlierSpread = $derived(bulkOutlierSpreadTexts(outliers, view));
	const outlierSpreadClosing = $derived(bulkOutlierSpreadClosing(outliers, view));
	// The rows the table shows, not the server's count: the line over the table says what is in it.
	const spreadCount = $derived(spreadSeqs === null ? 0 : shownTargets.length);

	const btn = 'rounded-[var(--radius-sm)] px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed';
	const btnPrimary = `${btn} bg-accent text-accent-fg hover:opacity-90`;
	const btnPlain = `${btn} border border-border hover:bg-bg-muted`;
	const inputClass = 'w-24 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-sm';
</script>

<!-- Taking the run back: offered on its own, and beside writing on a run that halted. -->
{#snippet filterLineOf(text: string)}
	<p class="text-sm" tabindex="-1" bind:this={filterLine}>{filtersFolded > 0 ? `${text} ` : text}{#if filtersFolded > 0}<button type="button" class="underline text-accent hover:opacity-80" onclick={() => showAllFilters()}>{tf('bulk.list.showAll', { n: String(filtersFolded) })}</button>{/if}</p>
{/snippet}

{#snippet undoOffer()}
	<div class="space-y-3 border-t border-border pt-4">
		<h2 class="text-sm font-medium">{t('bulk.undo.title')}</h2>
		<p class="text-sm">{t('bulk.undo.explain')}</p>
		<button type="button" class={btnPlain} disabled={busy} onclick={planUndo}>{t('bulk.undo.prepare')}</button>
	</div>
{/snippet}

<!-- A field's name (U-333): the host's readable name where lynox has one, as its own word; else the
     name the planner set, in a value box, so it does not read as a word of lynox's. -->
{#snippet fieldName(field: string)}{@const key = bulkFieldLabelKey(host, field)}{#if key !== null}{t(key)}{:else}<bdi class="rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 font-mono text-text" data-testid="bulk-field-own-name">{bulkVisibleText(field)}</bdi>{/if}{/snippet}
{#snippet fieldNames(fields: readonly string[])}{#each fields as f, i (i)}{i > 0 ? ', ' : ''}{@render fieldName(f)}{/each}{/snippet}
<!-- The host the planner set, boxed as code wherever it stands among the page's words. -->
{#snippet hostBox()}<BulkHost value={host ?? ''} />{/snippet}
<!-- A text of the page that names the host among its words: the host boxed wherever it stands. -->
{#snippet hostText(text: string)}{#each bulkHostSplit(text, host) as part, i (i)}{#if 'slot' in part}{@render hostBox()}{:else}{part.text}{/if}{/each}{/snippet}
{#snippet sentence(parts: BulkSentencePart[], fields: readonly string[])}{#each parts as part, i (i)}{#if 'slot' in part}{@render fieldNames(fields)}{:else}{part.text}{/if}{/each}{/snippet}
<!-- A sentence of the page split at its placeholders: the host boxed, the target's name and the field
     names as the page shows them. Text the page did not write (a target's key) is never searched for
     the host, so it cannot get a box that vouches for part of another name. -->
{#snippet placed(key: string, fields: readonly string[] = [])}{#each bulkTemplateParts(t(key), ['provider', 'host', 'target', 'field'], {}) as part, i (i)}{#if 'text' in part}{part.text}{:else if part.slot === 'target'}{probeLabel}{:else if part.slot === 'field'}{@render fieldNames(fields)}{:else if host !== null}{@render hostBox()}{:else}{provider}{/if}{/each}{/snippet}

<!-- A target's new value with a mark behind each hidden character it adds where text may carry
     one: the word in the text, the kind and code point only in the label. -->
{#snippet markedValue(text: string, codePoints: number[], html: boolean, takenBack = false)}
	{#each bulkHiddenSegments(text, codePoints, view, html) as part, i (i)}{#if 'mark' in part}<span class="mx-0.5 inline-block rounded-full px-1.5 text-[11px] {takenBack ? 'bg-bg-muted text-text-subtle' : 'bg-warning/15 border border-warning/40 text-warning'}" title={part.label} aria-label={part.label} data-testid="bulk-hidden-mark">{part.mark}</span>{:else}{part.text}{/if}{/each}
{/snippet}

<!-- The markup a target's new value adds and removes in an HTML field (1010), as code text with
     every attribute whole (sec-core M3): set as text, never rendered, and wrapped so a long value
     stays in view. On an undo it says what the undo writes back and takes out. -->
{#snippet targetName(target: { key: string })}
	{@const name = bulkTargetName(run?.targetSystem ?? '', target)}
	{#if name.adminUrl === null}
		<code class="text-xs break-all">{bulkVisibleText(target.key)}</code>
	{:else}
		<a class="text-sm underline hover:text-text" href={name.adminUrl} target="_blank" rel="noopener noreferrer" title={t('bulk.target.open_admin')} data-testid="bulk-target-admin">{tf('bulk.target.product', { n: name.number ?? '' })}<span aria-hidden="true"> ↗</span></a>
	{/if}
{/snippet}

{#snippet markupList(target: BulkTarget, undo: boolean)}
	{#each target.markupChanges ?? [] as change (change.field)}
		{@const list = bulkMarkupList(change, undo, shopify ? bulkFieldNamesText(host, [change.field], t) : bulkVisibleText(change.field), view)}
		<div class="mt-1 text-xs [overflow-wrap:anywhere]" data-testid="bulk-markup">
			{#if list.head}<div class="text-text-subtle" data-testid="bulk-markup-head">{@render sentence(bulkSentenceParts(view.t('bulk.markup.head'), 'field', {}), [change.field])}</div>{/if}
			{#if list.restoresNote}<p class={list.restoresActive ? 'text-warning' : 'text-text-subtle'} data-testid="bulk-markup-restores-note">{list.restoresNote}</p>{/if}
			<ul class="space-y-0.5">
				{#each list.lines as markupLine, i (i)}
					<li class="min-w-0"><span class="text-text-subtle">{markupLine.label}</span> <code class="whitespace-pre-wrap break-all">{bulkVisibleText(markupLine.code)}</code><span class="text-text-subtle">{markupLine.template === null ? '' : ` ${markupLine.template}`}</span></li>
				{/each}
			</ul>
			<p class="text-text-subtle">{list.note}</p>
		</div>
	{/each}
{/snippet}

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<ViewerUnavailableNotice />
	<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.back')}</button>

	{#if loading && run === null}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if error || run === null}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">{error || t('common.load_failed')}</div>
	{:else}
		<section class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-4">
			<h1 class="text-lg font-medium" data-testid="bulk-title">{#each bulkLabelParts(run, i18n, bulkCountsPending(workingStep)) as part, i (i)}{#if 'slot' in part}{@render hostBox()}{:else}{part.text}{/if}{/each}</h1>

			<ol class="flex flex-wrap gap-1.5 text-[11px]">
				{#each steps as s (s)}
					<li class="rounded-full px-2 py-0.5 {s === step ? 'bg-accent text-accent-fg' : 'bg-bg-muted text-text-muted'}" aria-current={s === step ? 'step' : undefined}>{t(bulkStepLabelKey(run, s))}</li>
				{/each}
			</ol>
			{#if undoneText}
				<p class="text-sm rounded-[var(--radius-sm)] bg-bg-muted border border-border px-3 py-2" data-testid="bulk-undone">
					{undoneText}
					{#if run.undoneBy}
						<button type="button" class="{btnPlain} ml-1" onclick={() => onOpen(run!.undoneBy!.runId)}>{t('bulk.undone.open')}</button>
					{/if}
				</p>
			{/if}

			<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
				<dt class="text-text-subtle">{t('bulk.head.target')}</dt>
				<dd>{#if host !== null}{@render hostBox()}{:else}{provider}{/if}{run.writeMethod ? ` · ${run.writeMethod}` : ''}</dd>
				<dt class="text-text-subtle">{t('bulk.head.status')}</dt>
				<dd data-testid="bulk-counts">{bulkHeadCounts(workingStep, run, i18n)}</dd>
				{#if run.costUsd > 0 || run.costCapUsd !== null}
					<dt class="text-text-subtle">{t('bulk.head.cost')}</dt>
					<dd class="font-mono">{formatCost(run.costUsd)}{run.costCapUsd !== null ? ` / ${formatCost(run.costCapUsd)}` : ''}</dd>
				{/if}
				{#if run.haltReason}
					<dt class="text-text-subtle">{t(bulkHaltHeadKey(run, startButton !== null && ownerActs))}</dt>
					<!-- The engine's own words for a halt (its reason, when the page has no sentence for it) stay text. -->
					{@const cause = bulkHaltCause(run, managed, startButton === null ? null : t(startButton), view, !ownerActs)}
					<!-- An atomic undo that rolled back links the run it takes back, where it says to start again (U-335). -->
					<dd data-testid="bulk-halt-cause">{#if rolledBack}{rolledBack.before}<button type="button" class="underline text-accent hover:opacity-80" onclick={() => onOpen(run!.sourceRunId!)}>{rolledBack.link}</button>{rolledBack.after}{:else if cause === run.haltReason}{cause}{:else}{@render hostText(cause)}{/if}</dd>
				{/if}
			</dl>

			{#if run.resumesAt}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{tf('bulk.resumes_at', { time: when(run.resumesAt) })}</p>
			{/if}
			{#if workingStep !== null && followStopped}
				<p class="text-sm text-text-muted" data-testid="bulk-follow-stopped">{t('bulk.follow.stopped')}</p>
			{:else if workingLine !== null}
				<p class="text-sm text-text-muted" data-testid="bulk-working">{tf(workingLine.key, { provider, ...workingLine.params })}</p>
			{/if}
			{#if bulkWaitsForStart(run)}
				<p class="text-sm text-text-muted">{t('bulk.awaiting_start')}</p>
			{/if}
			{#if run.phase === 'planned' && run.haltKey === 'listed'}
				{#if ownerActs}
					<p class="text-sm">{tf(run.judge !== null ? 'bulk.start.listed_judge' : 'bulk.start.listed', { n: String(run.total) })}</p>
				{/if}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.list_note')}</p>
			{/if}
			{#if conflictsText}
				<p class="text-sm text-text-muted">{conflictsText}</p>
			{/if}
			{#if (run.hostRewrote ?? 0) > 0}
				<p class="text-sm text-text-muted" data-testid="bulk-host-rewrote-count">{run.hostRewrote === 1 ? t('bulk.run.host_rewrote_one') : tf('bulk.run.host_rewrote', { n: String(run.hostRewrote) })}</p>
			{/if}
			{#if sentUnknownText}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-sent-unknown">{#if sentUnknownParts}{sentUnknownParts.before}<button type="button" class="underline text-accent hover:opacity-80" onclick={() => onOpen(run!.sourceRunId!)}>{sentUnknownParts.link}</button>{sentUnknownParts.after}{:else}{sentUnknownText}{/if}</p>
			{/if}

			{#if approving && ownerActs && run.judgeRule}
				<!-- What the values were decided by, for the owner who approves them: the rule the start showed (U-335). -->
				<div data-testid="bulk-approve-rule">
					<h2 class="text-sm font-medium mb-1">{t('bulk.start.rule')}</h2>
					<p class="text-sm whitespace-pre-wrap rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2">{bulkVisibleText(run.judgeRule.rule)}</p>
					<p class="text-sm text-text-muted mt-1" data-testid="bulk-rule-drafted">{t('bulk.approve.rule_drafted')}</p>
				</div>
			{/if}
			{#if run.kind === 'apply' && targets.length > 0}
				<div>
					<h2 class="text-sm font-medium mb-2">{tf('bulk.preview.title', { k: String(targets.length), n: String(run.total) })}</h2>
					{#if skipped.text && !skipped.nothing}
						<p class="text-sm mb-2">{skipped.text}</p>
					{/if}
					{#if seoEntity > 0}
						<p class="text-sm mb-2 rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-seo-entity-count">{seoEntity === 1 ? t('bulk.preview.seo_entity_one') : tf('bulk.preview.seo_entity', { n: String(seoEntity) })}</p>
					{/if}
					{#if outlierCount}
						<p class="text-sm mb-2 rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-outlier-count">{outlierCount}</p>
					{/if}
					{#if outlierSpread.length > 0 && outliers}
						<!-- One box: each kind's line, its button to show the table on those verdicts alone, and the way
						     out once below them (U-417). Hosts as text, never as a link: the warning must not be the
						     click. They come from verdict text, so a hidden character in one is shown. -->
						<div class="text-sm mb-2 rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2 space-y-1" data-testid="bulk-outlier-spread-box">
							{#each outlierSpread as line, i (i)}
								{@const entry = outliers.spread[i]!}
								<p class="[overflow-wrap:anywhere]"><span data-testid="bulk-outlier-spread">{bulkVisibleText(line)}</span>{#if entry.seqs !== undefined && entry.seqs.length > 0}<button type="button" class="block sm:inline sm:ml-1 whitespace-nowrap underline text-accent hover:opacity-80" data-testid="bulk-outlier-spread-show" bind:this={spreadButtons[i]} onclick={() => toggleSpread(entry.kind)}>{bulkOutlierShowText(entry.seqs.length, spreadKind === entry.kind, view)}</button>{/if}</p>
							{/each}
							{#if outlierSpreadClosing}
								<p data-testid="bulk-outlier-spread-closing">{outlierSpreadClosing}</p>
							{/if}
						</div>
					{/if}
					{#if hiddenMarked}
						<p class="text-sm mb-2 text-text-muted" data-testid="bulk-hidden-legend">{t('bulk.hidden.legend')}</p>
					{/if}
					<!-- Said over the table itself: on a phone the box above is out of sight, and a reader in the table
					     would take it for the whole run, which the approval is for (U-417). -->
					<div aria-live="polite">
						{#if spreadKind !== null}
							<p class="text-sm mb-2 rounded-[var(--radius-sm)] bg-bg-muted border border-border px-3 py-2" data-testid="bulk-outlier-filtered">{bulkOutlierFilteredText(spreadKind, spreadCount, view)} <button type="button" class="block sm:inline whitespace-nowrap underline text-accent hover:opacity-80" data-testid="bulk-outlier-filtered-all" onclick={() => showAllFromTable()}>{t('bulk.outliers.spread.show_all')}</button></p>
						{/if}
					</div>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-xs text-text-subtle border-b border-border">
									<th class="py-1.5 pr-3 font-medium">{t('bulk.head.target')}</th>
									<th class="py-1.5 font-medium">{t('bulk.preview.before_after')}</th>
								</tr>
							</thead>
							<tbody>
								{#each orderedTargets as target (target.seq)}
									<tr class="border-b border-border align-top {target.deselected ? 'opacity-60' : ''}">
										<td class="py-1.5 pr-3">
											{@render targetName(target)}
											{#if target.shopAddedMarkup}
												<span class="ml-1 inline-block rounded-full bg-danger/15 border border-danger/40 px-1.5 text-[11px] text-danger" data-testid="bulk-shop-added-markup">{t('bulk.target.shop_added_markup')}</span>
											{/if}
											{#if target.hostRewrote && !target.shopAddedMarkup}
												<span class="ml-1 inline-block rounded-full bg-bg-subtle border border-border px-1.5 text-[11px] text-text-muted" data-testid="bulk-host-rewrote">{t('bulk.target.host_rewrote')}</span>
											{/if}
											{#if (target.seoEntityFields?.length ?? 0) > 0}
												<span class="ml-1 inline-block rounded-full bg-warning/15 border border-warning/40 px-1.5 text-[11px] text-warning" data-testid="bulk-seo-entity">{t('bulk.target.seo_entity')}</span>
											{/if}
											{#each outlierReasons.get(target.seq) ?? [] as reason (reason)}
												<span class="ml-1 inline-block whitespace-nowrap rounded-full bg-warning/15 border border-warning/40 px-1.5 text-[11px] text-warning" data-testid="bulk-outlier">{t(`bulk.outlier.${reason}`)}</span>
											{/each}
											{#if bulkRollbackLeft(run, target)}
												<span class="ml-1 inline-block rounded-full bg-warning/15 border border-warning/40 px-1.5 text-[11px] text-warning" data-testid="bulk-rollback-left">{t('bulk.target.not_taken_back')}</span>
											{/if}
										</td>
										<td class="py-1.5">
											{#if target.diff.kind === 'fields'}
												{#each target.diff.fields as f (f.field)}
													<!-- A long value without spaces (HTML, a URL) breaks inside the cell instead of running past it. -->
													<div class="[overflow-wrap:anywhere]">
														<span class="text-text-subtle" data-testid="bulk-field-name">{@render fieldName(f.field)}:</span>
														{#if bulkValueText(f.before) === ''}<span class="text-text-subtle">{t('bulk.preview.empty_value')}</span>{:else}<del class="text-danger">{bulkValueText(f.before)}</del>{/if}
														→ <ins class="{bulkAfterTakenBack(run, target) ? 'text-text-subtle' : 'text-success'} no-underline" data-testid="bulk-after">{#if bulkHiddenAddsOf(target, f.field).length > 0}{@render markedValue(bulkRawText(f.after), bulkHiddenAddsOf(target, f.field), bulkHiddenHtml(target, f.field), bulkAfterTakenBack(run, target))}{:else}{bulkValueText(f.after)}{/if}</ins>
														{#if bulkHiddenUnchecked(target, f.field)}
															<!-- Not checked for hidden characters: said under the field, and the way out only where the owner can take the target out here. -->
															<div class="text-xs text-text-subtle" data-testid="bulk-unchecked">{view.t(uncheckedNoteKey(target))}</div>
														{/if}
													</div>
												{/each}
											{:else if target.diff.kind === 'text'}
												<pre class="text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{#each target.diff.removed as line, i (i)}<del class="text-danger">- {bulkVisibleText(line)}</del>
{/each}{#each target.diff.added as line, i (i)}<ins class="{bulkAfterTakenBack(run, target) ? 'text-text-subtle' : 'text-success'} no-underline" data-testid="bulk-after">+ {@render markedValue(line, bulkHiddenAddsOf(target, ''), false, bulkAfterTakenBack(run, target))}</ins>
{/each}</pre>
											{:else if target.error && target.change !== 'invalid'}
												<span class="text-text-subtle">{bulkVisibleText(target.error)}</span>
											{/if}
											{@render markupList(target, false)}
											{#if target.change === 'invalid' && target.error}
												<p class="text-sm" data-testid="bulk-invalid-text">{#if target.error === 'secret_in_context' && target.contextField !== undefined}{@render sentence(bulkSentenceParts(view.t(bulkSecretInContextKey(shopify, run.targetSystem === 'data_store')), 'field', {}), [target.contextField])}{:else}{bulkInvalidText(target.error, shopify, managed, view, { field: target.contextField, host, dataStore: run.targetSystem === 'data_store', listForm: run.listForm, judgesHtml: run.judgesHtml, markedDate: target.shopMarkedAt ? markedDateText(target.shopMarkedAt) : null, startDomains: ownerActs && bulkTakesStartDomains(run), linkDomain: target.linkDomain })}{/if}</p>
												{#if target.error === 'shortcode_changed' && target.refusedValues}
													{#each target.refusedValues as { field, value, codePoints } (field)}
														{#if target.refusedValues.length > 1}<div class="mt-1 text-xs text-text-subtle" data-testid="bulk-refused-field">{@render fieldName(field)}:</div>{/if}
														<BulkRefusedValue {value} codePoints={codePoints ?? []} />
													{/each}
												{/if}
											{/if}
											{#if approving && (target.deselected || writes(target))}
												<div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
													{#if target.deselected}<span class="text-text-subtle">{view.t('bulk.deselect.taken_out')}</span>{/if}
													{#if ownerActs}
														<button type="button" class="{btnPlain} text-xs" disabled={busy} onclick={() => toggleSelected(target)}>{t(target.deselected ? 'bulk.deselect.on' : 'bulk.deselect.off')}</button>
													{/if}
												</div>
											{/if}
											{#if target.sentUnchanged && target.sentUnchanged.length > 0}
												<div class="text-xs text-text-subtle" data-testid="bulk-sent-unchanged">{@render sentence(bulkSentenceParts(t('bulk.preview.sent_unchanged'), 'fields', {}), target.sentUnchanged)}</div>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if foldedUnchanged > 0 && spreadKind === null}
						<button type="button" class="{btnPlain} mt-2" onclick={showUnchangedTargets}>{tf(shopify ? bulkOne('bulk.preview.show_unchanged', foldedUnchanged) : bulkOne('bulk.preview.show_unchanged_targets', foldedUnchanged), { n: String(foldedUnchanged) })}</button>
					{/if}
					{#if targets.length < run.total}
						<button type="button" class="{btnPlain} mt-2" onclick={showMore}>{tf('bulk.preview.show_all', { n: String(run.total) })}</button>
					{/if}
				</div>
			{/if}

			{#if mandate}
				<p class="text-sm border-t border-border pt-4">{t('bulk.owner_only_notice')}</p>
			{:else if !ownerActs}
				<!-- Whose session it is is not known yet: no act is offered. -->
			{:else if startKind === 'read'}
				<div class="space-y-3 border-t border-border pt-4">
					<p class="text-sm" data-testid="bulk-read-explain">{@render placed('bulk.start.read_explain')}</p>
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy} onclick={() => start()}>{t(startButton ?? 'bulk.start.read')}</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
				</div>
			{:else if startKind === 'list' && run.listFirstPage}
				<div class="space-y-3 border-t border-border pt-4">
					<!-- Split at the places of the host and the address, not at the host's name: the address may hold the
					     host too, and is a whole value in its own box (U-423). -->
					<p class="text-sm" data-testid="bulk-list-explain">{#each bulkTemplateParts(t('bulk.start.list_explain'), ['provider', 'address'], {}) as part, i (i)}{#if 'text' in part}{part.text}{:else if part.slot === 'address'}<BulkHost value={bulkVisibleText(run.listFirstPage)} testid="bulk-list-address" />{:else if host !== null}{@render hostBox()}{:else}{provider}{/if}{/each}</p>
					{#if listFilterText}{@render filterLineOf(listFilterText)}{/if}{#if listStatusText}<p class="text-sm">{listStatusText}</p>{/if}
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy} onclick={() => start()}>{t(startButton ?? 'bulk.start.list')}</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
				</div>
			{:else if startKind === 'judge_own_key'}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.judge_own_key')}</p>
			{:else if startKind === 'no_judge'}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.no_judge_model')}</p>
			{:else if startKind === 'judge' && run.judgeServedBy && run.judgeRule}
				<div class="space-y-3 border-t border-border pt-4">
					<p class="text-sm">{tf('bulk.start.judge_explain', { provider: bulkJudgeProviderName(run.judgeServedBy.provider), model: run.judgeServedBy.label })}</p>
					<div>
						<h3 class="text-xs font-medium text-text-subtle mb-1">{t('bulk.start.rule')}</h3>
						<p class="text-sm whitespace-pre-wrap rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2">{bulkVisibleText(run.judgeRule.rule)}</p>
						<!-- The agent wrote the rule, from the owner's words or from data it read: the owner checks it (U-335). -->
						<p class="text-sm text-text-muted mt-1" data-testid="bulk-rule-drafted">{t('bulk.start.rule_drafted')}</p>
					</div>
					<div>
						<h3 class="text-xs font-medium text-text-subtle mb-1">{t('bulk.start.fields')}</h3>
						<ul class="text-sm space-y-0.5">
							{#each Object.entries(run.judgeRule.schema.properties) as [field, shape] (field)}
								{@const shapeText = bulkFieldShapeText(shape, i18n)}
								<li data-testid="bulk-start-field">{@render fieldName(field)}{#if shapeText !== null}: <span class="text-text-subtle [overflow-wrap:anywhere]">{shapeText}{#each bulkFieldChoices(shape) ?? [] as choice, i (i)}{i === 0 ? ' ' : ', '}<bdi class="rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 font-mono text-text" data-testid="bulk-field-choice">"{bulkVisibleText(choice)}"</bdi>{/each}</span>{/if}</li>
							{/each}
						</ul>
					</div>
					{#if run.judgeRule.context && run.judgeRule.context.length > 0}
						<!-- The context C goes to the judge's provider too: shown before the start the hash binds (U-140). -->
						<div data-testid="bulk-start-context">
							<h3 class="text-xs font-medium text-text-subtle mb-1">{t('bulk.start.context_fields')}</h3>
							<ul class="text-sm space-y-0.5">
								{#each run.judgeRule.context as field (field)}
									<li>{@render fieldName(field)}</li>
								{/each}
							</ul>
							<p class="text-xs text-text-muted mt-1">{tf('bulk.start.context_explain', { provider: bulkJudgeProviderName(run.judgeServedBy.provider) })}</p>
						</div>
					{/if}
					<div class="text-sm space-y-1">
						<label class="flex flex-wrap items-center gap-2">
							{t('bulk.start.cap_prefix')}
							<input type="text" inputmode="decimal" class={inputClass} bind:value={capInput} aria-invalid={capInput !== '' && bulkCostCap(capInput) === null} />
							{t('bulk.start.cap_suffix')}
						</label>
						<p class="text-text-muted">{t('bulk.start.cap_explain')}</p>
						{#if capInput !== '' && bulkCostCap(capInput) === null}
							<p class="text-danger">{t('bulk.start.cap_invalid')}</p>
						{/if}
					</div>
					{#if host !== null && bulkTakesStartDomains(run)}
						{#key run.id}
							<BulkStartDomains storeHost={host} editable={true} bind:domains={startDomains} bind:valid={startDomainsValid} />
						{/key}
					{/if}
					{#if supersedable}
						<div class="space-y-2 text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">
							<p>{tf('bulk.start.supersede', { cost: formatCost(supersedable.costUsd) })}</p>
							<div class="flex flex-wrap gap-2">
								<button type="button" class={btnPrimary} disabled={busy || bulkCostCap(capInput) === null || !startDomainsValid} aria-describedby={startHint === null ? undefined : 'bulk-start-hint'} onclick={() => start(supersedable!.id)}>{t(startButton ?? 'bulk.start.supersede_yes')}</button>
								<button type="button" class={btnPlain} onclick={() => { supersedable = null; }}>{t('bulk.not_now')}</button>
							</div>
						</div>
					{:else}
						<div class="flex flex-wrap gap-2">
							<button type="button" class={btnPrimary} disabled={busy || bulkCostCap(capInput) === null || !startDomainsValid} aria-describedby={startHint === null ? undefined : 'bulk-start-hint'} onclick={() => start()}>{t(startButton ?? 'bulk.start.judge')}</button>
							<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
						</div>
					{/if}
					{#if startHint !== null}
						<p id="bulk-start-hint" class="text-sm text-text-muted" data-testid="bulk-start-hint">{t(startHint)}</p>
					{/if}
				</div>
			{:else if restartKind !== null}
				{#if !(restartKind === 'none' && bulkRestartNoneNote(run.haltKey) === null && !haltText?.before && !supportMail)}
				<div class="space-y-3 border-t border-border pt-4" data-testid="bulk-restart">
					{#if haltText?.before}
						<p class="text-sm">{@render hostText(haltText.before)}</p>
					{/if}
					{#if supportMail}
						<p class="text-sm"><a href={supportMail} class="{btnPlain} inline-block">{t('bulk.halt.support_mail')}</a></p>
					{/if}
					{#if restartKind === 'none'}
						{@const noneNote = bulkRestartNoneNote(run.haltKey)}
						{#if noneNote !== null}
							<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-restart-none">{t(noneNote)}</p>
						{/if}
					{:else if restartKind === 'judge_own_key'}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.judge_own_key')}</p>
					{:else if restartKind === 'no_judge'}
						{#if run.haltKey !== 'judgeModel'}
							<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.no_judge_model')}</p>
						{/if}
					{:else}
						{#if restartKind === 'judge_cap'}
							<div class="text-sm space-y-1">
								<label class="flex flex-wrap items-center gap-2">
									{t('bulk.start.cap_prefix')}
									<input type="text" inputmode="decimal" class={inputClass} bind:value={capInput} aria-invalid={capInput !== '' && bulkRestartCap(capInput, run.costCapUsd) === null} />
									{t('bulk.start.cap_suffix')}
								</label>
								<p class="text-text-muted">{t('bulk.restart.cap_whole')} {t('bulk.start.cap_explain')}</p>
								{#if capInput !== '' && bulkRestartCap(capInput, run.costCapUsd) === null}
									<p class="text-danger">{tf('bulk.restart.cap_low', { cap: bulkUsd(run.costCapUsd ?? 0) })}</p>
								{/if}
							</div>
						{/if}
						{#if (restartKind === 'judge' || restartKind === 'judge_cap') && host !== null && bulkTakesStartDomains(run)}
							<BulkStartDomains storeHost={host} editable={false} domains={run.startDomains ?? []} />
						{/if}
						<p class="text-sm text-text-muted">{t(restartKind === 'list' ? 'bulk.restart.kept_list' : 'bulk.restart.kept')}</p>
						{#if supersedable}
							<div class="space-y-2 text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">
								<p>{tf('bulk.start.supersede', { cost: formatCost(supersedable.costUsd) })}</p>
								<div class="flex flex-wrap gap-2">
									<button type="button" class={btnPrimary} disabled={busy || (restartKind === 'judge_cap' && bulkRestartCap(capInput, run.costCapUsd) === null)} onclick={() => restart(supersedable!.id)}>{t('bulk.start.supersede_yes')}</button>
									<button type="button" class={btnPlain} onclick={() => { supersedable = null; }}>{t('bulk.not_now')}</button>
								</div>
							</div>
						{:else}
							<div class="flex flex-wrap gap-2">
								<button type="button" class={btnPrimary} disabled={busy || (restartKind === 'judge_cap' && bulkRestartCap(capInput, run.costCapUsd) === null)} onclick={() => restart()}>{t(restartKind === 'list' ? 'bulk.restart.list' : restartKind === 'read' ? 'bulk.restart.read' : 'bulk.restart.judge')}</button>
								<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
							</div>
						{/if}
					{/if}
				</div>
				{/if}
			{:else if resumeKind !== null && resumeText}
				<div class="space-y-3 border-t border-border pt-4">
					<!-- After a start check that can never pass, nothing promises writing on: the halt's cause,
					     the reason, and the buttons stay. -->
					{#if resumeText.before && !resumeHopeless}
						<p class="text-sm">{@render hostText(resumeText.before)}</p>
					{/if}
					<!-- The support link stands under the sentence that names support, which comes before the check. -->
					{#if supportMail && !resumeHopeless}
						<p class="text-sm"><a href={supportMail} class="{btnPlain} inline-block">{t('bulk.halt.support_mail')}</a></p>
					{/if}
					{#if resumeKind === 'none'}
						<!-- An undo starts again from the page of the run it takes back: the words link to it where the run names it. -->
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-resume-none">{resumeWords!.none.before}{#if resumeWords!.none.link !== null}{#if run.sourceRunId !== null}<button type="button" class="underline text-accent hover:opacity-80" onclick={() => onOpen(run!.sourceRunId!)}>{resumeWords!.none.link}</button>{:else}{resumeWords!.none.link}{/if}{/if}{resumeWords!.none.after}</p>
						{#if resumeText.kept}
							<p class="text-sm text-text-muted" data-testid="bulk-resume-kept">{@render hostText(resumeText.kept)}</p>
						{/if}
					{:else if resumeKind === 'nothing'}
						<p class="text-sm">{@render hostText(resumeText.check ?? '')}</p>
					{:else if resumeHopeless}
						<p id="bulk-resume-hopeless" class="text-sm text-danger" tabindex="-1" bind:this={hopelessLine} data-testid="bulk-resume-hopeless">{hopelessReason}</p>
						<div class="flex flex-wrap gap-2">
							<button type="button" class={btnPrimary} disabled aria-describedby="bulk-resume-hopeless">{resumeKind === 'check' ? t('bulk.resume.check') : resumeWords!.button}</button>
							<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
						</div>
					{:else}
						{#if resumeText.soFar}
							<p class="text-sm">{@render hostText(resumeText.soFar)}</p>
						{/if}
						{#if resumeKind === 'max'}
							<div class="text-sm space-y-1">
								<label class="flex flex-wrap items-center gap-2">
									{t('bulk.probe.in_total')}
									<input type="number" class={inputClass} min={(run.maxTargets ?? 0) + 1} max={bulkWriting(run)} bind:value={maxTargets} aria-invalid={bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run)) === null} />
									{t('bulk.probe.targets')}
								</label>
								{#if bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run)) === null}
									<p class="text-danger">{tf('bulk.resume.max_more', { max: String(run.maxTargets ?? 0), all: String(bulkWriting(run)) })}</p>
								{/if}
							</div>
						{/if}
						{#if resumeText.check}
							<p class="text-sm">{@render hostText(resumeText.check)}</p>
						{/if}
						{#if resumeText.after}
							<p class="text-sm">{@render hostText(resumeText.after)}</p>
						{/if}
						{#if resumeText.kept}
							<p class="text-sm text-text-muted">{@render hostText(resumeText.kept)}</p>
						{/if}
						{#if resumeText.allows}
							<p class="text-sm">{@render hostText(resumeText.allows)}</p>
						{/if}
						{#if resumeKind !== 'check'}
							<p class="text-sm text-text-muted">{resumeWords!.window}</p>
						{/if}
						<div class="flex flex-wrap gap-2">
							<button type="button" class={btnPrimary} disabled={busy || (resumeKind === 'max' && bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run)) === null)} onclick={resume}>{resumeKind === 'check' ? t('bulk.resume.check') : resumeWords!.button}</button>
							<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
						</div>
					{/if}
				</div>
				{#if canUndo}
					{@render undoOffer()}
				{/if}
			{:else if run.phase === 'previewed' && run.kind === 'apply'}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.approve.title')}</h2>
					{#if skipped.nothing}
						<!-- Nothing left to write: no note on what a write does, no button that cannot act. -->
						<p id="bulk-approve-nothing" class="text-sm">{skipped.text}</p>
						<div class="flex flex-wrap gap-2">
							<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
						</div>
					{:else}
					{#if listFilterText}{@render filterLineOf(listFilterText)}{/if}{#if listStatusText}<p class="text-sm">{listStatusText}</p>{/if}
					{#if host !== null && bulkTakesStartDomains(run)}
						<BulkStartDomains storeHost={host} editable={false} domains={run.startDomains ?? []} />
					{/if}
					{#if run.writeForm === 'unmeasured'}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{unmeasuredNote}</p>
						<label class="flex gap-2 items-start text-sm">
							<input type="checkbox" bind:checked={unmeasuredOk} class="mt-1" />
							<span>{unmeasuredConfirmation}</span>
						</label>
					{/if}
					{#if hiddenCount}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-hidden-count">{hiddenCount}</p>
					{/if}
					{#if uncheckedCount}
						<p class="text-sm" data-testid="bulk-unchecked-count">{uncheckedCount}</p>
					{/if}
					{#if bulkIsShopifyHost(host)}
						<p class="text-sm">{t('bulk.approve.shopify_visible')}</p>
					{/if}
					{#if host !== null && !run.probeConfirmed}
						<!-- With one target to write, the first is the whole run: nothing is left to approve after it. -->
						<p class="text-sm">{t(bulkWriting(run) === 1 ? 'bulk.approve.only_one' : 'bulk.approve.one_first')}</p>
					{:else}
						<label class="flex items-center gap-2 text-sm">
							{t('bulk.approve.at_most')}
							<input type="number" class={inputClass} min="1" max={bulkWriting(run)} bind:value={maxTargets} />
							{t('bulk.approve.targets_write')}
						</label>
					{/if}
					{#if spreadKind !== null && shownTargets.length < targets.length}
						<!-- The approval is for the whole run, the table may show part of it (U-417): of every verdict
						     of the run, however the table folds the unchanged ones. -->
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-approve-filtered">{tf('bulk.approve.filtered', { n: String(shownTargets.length), m: String(targets.length) })} <button type="button" class="block sm:inline whitespace-nowrap underline text-accent hover:opacity-80" data-testid="bulk-approve-filtered-all" onclick={() => showAllAtApproval()}>{t('bulk.outliers.spread.show_all')}</button></p>
					{/if}
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} bind:this={approveButton}
							disabled={busy || hopelessReason !== null || (run.writeForm === 'unmeasured' && !unmeasuredOk)}
							aria-describedby={hopelessReason !== null ? 'bulk-approve-hopeless' : run.writeForm === 'unmeasured' && !unmeasuredOk ? 'bulk-approve-confirm-first' : undefined}
							onclick={() => approve(host !== null && !run!.probeConfirmed)}>
							{host !== null && !run.probeConfirmed ? t(bulkWriting(run) === 1 ? 'bulk.approve.write_only' : 'bulk.approve.write_one') : t('bulk.approve.approve')}
						</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
					{#if hopelessReason !== null}
						<p id="bulk-approve-hopeless" class="text-sm text-danger" tabindex="-1" bind:this={hopelessLine} data-testid="bulk-approve-hopeless">{hopelessReason}</p>
					{:else if run.writeForm === 'unmeasured' && !unmeasuredOk}
						<p id="bulk-approve-confirm-first" class="text-xs text-text-subtle">{t('bulk.approve.confirm_first')}</p>
					{/if}
					{/if}
				</div>
			{:else if atProbe && run.probe}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.probe.title')}</h2>
					<p class="text-sm" data-testid="bulk-probe-explain">{#if run.probe.fields.length > 0}{@render placed(run.probe.found === true ? 'bulk.probe.explain_found' : 'bulk.probe.explain', run.probe.fields)}{:else}{@render placed(run.probe.found === true ? 'bulk.probe.explain_found_whole' : 'bulk.probe.explain_whole')}{/if}</p>
					{#if hiddenCount}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2" data-testid="bulk-hidden-count">{hiddenCount}</p>
					{/if}
					{#if uncheckedCount}
						<p class="text-sm" data-testid="bulk-unchecked-count">{uncheckedCount}</p>
					{/if}
					{#if probeName?.adminUrl}
						<a class="text-sm underline hover:text-text" href={probeName.adminUrl} target="_blank" rel="noopener noreferrer" title={t('bulk.target.open_admin')} data-testid="bulk-probe-admin">{tf('bulk.target.product', { n: probeName.number ?? '' })}<span aria-hidden="true"> ↗</span></a>
					{/if}
					<label class="flex gap-2 items-start text-sm">
						<input type="checkbox" bind:checked={probeOk} class="mt-1" />
						<span data-testid="bulk-probe-confirm">{@render placed(run.probe.fields.length > 0 ? 'bulk.probe.confirm' : 'bulk.probe.confirm_whole')}{#if run.writeForm === 'measured'}{SENTENCE_GAP}{@render placed('bulk.probe.confirm_measured')}{/if}</span>
					</label>
					<label class="flex items-center gap-2 text-sm">
						{t('bulk.probe.in_total')}
						<input type="number" class={inputClass} min="1" max={bulkWriting(run)} bind:value={maxTargets} />
						{t('bulk.probe.targets')}
					</label>
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy || !probeOk || hopelessReason !== null}
							aria-describedby={hopelessReason !== null ? 'bulk-probe-hopeless' : undefined} onclick={confirmProbeAndResume}>{t('bulk.probe.continue')}</button>
						<button type="button" class={btnPlain} disabled={busy} onclick={planUndo}>{t('bulk.probe.undo_one')}</button>
					</div>
					{#if hopelessReason !== null}
						<p id="bulk-probe-hopeless" class="text-sm text-danger" tabindex="-1" bind:this={hopelessLine} data-testid="bulk-probe-hopeless">{hopelessReason}</p>
					{/if}
				</div>
			{:else if run.kind === 'undo' && run.phase === 'previewed'}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.undo.approve_title')}</h2>
					<!-- The targets that get a value back; the entries the source created are listed apart. -->
					<p class="text-sm">{tf(bulkOne('bulk.undo.approve_explain', run.changes.update + run.changes.create), { n: String(run.changes.update + run.changes.create) })}</p>
					{#each targets.filter((x) => (x.markupChanges?.length ?? 0) > 0) as target (target.seq)}
						<div class="text-sm" data-testid="bulk-undo-markup">
							{@render targetName(target)}
							{@render markupList(target, true)}
						</div>
					{/each}
					{#if run.changes.delete > 0}
						<div class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">
							<p>{tf('bulk.undo.creates', { k: String(run.changes.delete) })}</p>
							<ul class="list-disc pl-5 mt-1">
								{#each creates as c (c.seq)}<li>{@render targetName(c)}</li>{/each}
							</ul>
						</div>
					{/if}
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy || hopelessReason !== null || creates.length !== run.changes.delete}
							aria-describedby={hopelessReason !== null ? 'bulk-approve-hopeless' : undefined} onclick={approveUndo}>{t('bulk.undo.approve')}</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
					{#if hopelessReason !== null}
						<p id="bulk-approve-hopeless" class="text-sm text-danger" tabindex="-1" bind:this={hopelessLine} data-testid="bulk-approve-hopeless">{hopelessReason}</p>
					{/if}
				</div>
			{:else if canUndo}
				{@render undoOffer()}
			{/if}

			<!-- Discarding a run before its approval: the owner's alone, never red, since lynox
			     writes nothing by it (U-324). A mandate asks the owner. -->
			{#if ownerActs && (run.phase === 'planned' || run.phase === 'previewed')}
				<div class="mt-3" data-testid="bulk-discard">
					{#if confirmingDiscard}
						<div role="group" aria-labelledby="bulk-discard-title" class="space-y-2 rounded border border-border p-3">
							<h3 id="bulk-discard-title" class="text-sm font-medium">{t('bulk.discard.confirm_title')}</h3>
							<p class="text-sm">{t('bulk.discard.confirm_text')}</p>
							<div class="flex flex-wrap gap-2">
								<button type="button" class={btnPlain} disabled={busy} onclick={discard} data-testid="bulk-discard-confirm">{t('bulk.discard.button')}</button>
								<button type="button" class={btnPlain} onclick={() => { confirmingDiscard = false; }}>{t('bulk.discard.cancel')}</button>
							</div>
						</div>
					{:else}
						<button type="button" class={btnPlain} disabled={busy} onclick={() => { confirmingDiscard = true; }} data-testid="bulk-discard-open">{t('bulk.discard.button')}</button>
					{/if}
				</div>
			{/if}
			{#if actionError}
				<p class="text-sm text-danger">{actionError}</p>
			{/if}
		</section>
	{/if}
</div>
