import type { ToolEntry, IAgent } from '../../types/index.js';
import type { KnowledgeKind, MemoryBlockEditMode } from '../../types/memory.js';
import { matchesSecretPattern, maskSecretPatterns } from '../../core/secret-store.js';
import { BlockEditError, BlockOverLimitError, checkKnowledgeText } from '../../core/knowledge-store.js';
import { getErrorMessage } from '../../core/utils.js';
import { appendCaptureTelemetry } from '../../core/capture-telemetry.js';
import type { UntrustedCause } from '../../core/untrusted-signals.js';
import { deriveTurnUntrusted, describeTurnUntrusted } from '../../core/untrusted-signals.js';
import { appendUntrustedCauseLog } from '../../core/untrusted-cause-log.js';
import { pv } from '../../core/prompt-value.js';
import { canSupersede } from '../../core/provenance.js';

/**
 * The reason clause every trust-gate outcome names, worded for the signal that ACTUALLY fired.
 *
 * The gate ORs a run-scoped signal with the conversation-sticky F5 latch (`untrusted-signals.ts`),
 * so a turn that ran no external tool at all still trips it once anything earlier in the thread
 * tainted the conversation. A fixed "this turn read external content" is then false — to the model,
 * and to the user it relays the reason to. These strings are prompt surface: they teach a rule
 * about the runtime, so a wrong one mis-teaches every later turn. Observed on prod 2026-08-10
 * (engine 2.13.0): the model quoted the fixed sentence to explain a queue on a turn whose only
 * tool call was `remember`.
 */
function untrustedReason(cause: UntrustedCause): string {
  return cause === 'conversation'
    ? 'this conversation read external content on an earlier turn'
    : 'this turn read external content';
}

/**
 * How to reach a trusted write, given the cause. Under the sticky latch there is no clean turn
 * left in THIS thread — telling the user to "tell me directly on a clean turn" sends them to an
 * unreachable state, so the conversation case names the one thing that does clear it (`reset`).
 */
function untrustedRemedy(cause: UntrustedCause): string {
  return cause === 'conversation' ? 'in a new chat' : 'directly on a clean turn';
}

/**
 * Durable Knowledge Substrate tools (DK.1). The always-on capture/read surface that
 * REPLACES the six legacy `memory_*` tools when `durable_memory_enabled` is on (registered
 * in engine.ts; the legacy tools are skipped). All three read/write via
 * `agent.toolContext.knowledgeStore` — a direct SQLite insert that NEVER publishes the
 * `channels.memoryStore` extraction minting channel (decoupling, req 2).
 *
 * Trust posture (from the /security-deep-dive gate, verified at source):
 *  - `remember` ROUTES an untrusted turn to `pending_review` (never drops/blocks — H4),
 *    and rejects secret-shaped text on the write path (H7).
 *  - `memory_block_edit` REFUSES on an untrusted turn (H5 — a singleton block can't be
 *    faithfully queued) and, on a trusted turn, mirrors `subjects_merge`:
 *    autonomous-refuse + interactive confirmation (a block loads into EVERY turn).
 *  - `recall` renders only `status='active'` (pending/rejected are never agent-readable).
 */

// ── remember (THE capture tool) ──

interface RememberInput {
  text: string;
  subject?: string | undefined;
  kind?: KnowledgeKind | undefined;
  pin?: boolean | undefined;
}

export const rememberTool: ToolEntry<RememberInput> = {
  definition: {
    name: 'remember',
    description:
      'Record a durable business fact, decision, or standing preference so it persists across sessions. ' +
      'Link it to the client / company / project by name via `subject` so it resurfaces when that subject is in focus. ' +
      'Use when you LEARN something durable — NOT for one-off computation, deadlines (use task_create), or ' +
      'structured/quantitative data (use data_store_insert). Record it before you finish the turn.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The durable fact / decision / preference, in one clear sentence.' },
        subject: {
          type: 'string',
          description: 'The client, company, or project this is about, by name. Links the entry to that subject. Omit only for a global preference about the operator themselves.',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'rule', 'event'],
          description: 'fact (default): a business fact · preference: a durable preference · rule: a standing rule · event: something that happened.',
        },
        pin: {
          type: 'boolean',
          description: 'Pin into the always-loaded focus block for this subject. Reserve for the FEW facts you want present in every future turn about it.',
        },
      },
      required: ['text'],
    },
  },
  handler: async (input: RememberInput, agent: IAgent): Promise<string> => {
    const ks = agent.toolContext.knowledgeStore;
    if (!ks) return 'Durable memory is not enabled for this agent.';

    const text = input.text?.trim();
    if (!text) return 'Pass a non-empty `text` to remember.';
    // S8/S6 (length) + H7 (secret-SHAPED reject, never queue) both live in
    // `checkKnowledgeText`, shared with the turn-end capture path so the two write paths
    // cannot drift apart — they already had, once. Its reasons are user-visible returns of
    // this tool and are pinned in `tests/eval/probe-freshness.test.ts` on that surface.
    const check = checkKnowledgeText(text, agent.secretStore, input.subject);
    if (!check.ok) return check.reason;

    // H4: the source is untrusted if the run saw the content boundary marker OR any
    // external-content tool ran this turn (the capability denylist — the marker alone is
    // allowlist-by-omission: bash/curl output may not set it). F5: OR the CONVERSATION has
    // ingested untrusted content on any prior turn still in context (a deferred injected
    // "remember … next turn" writes on a clean-latch turn otherwise). Untrusted → pending_review.
    const sourceUntrusted = deriveTurnUntrusted(agent);
    // Record WHICH signal fired. The gate needs only the boolean; the review queue needs the
    // attribution, or the cost of the sticky (F5) half of the union stays unmeasurable.
    // Derived ONCE and reused by the cause-log, the SSE chip, and the model-visible return
    // string below, so the three can never disagree about why this write was queued.
    const untrustedCause = describeTurnUntrusted(agent);
    void appendUntrustedCauseLog(agent.toolContext.userConfig?.retrieval_shadow_log === true, {
      ts: Date.now(),
      site: 'remember',
      cause: untrustedCause,
      untrusted: sourceUntrusted,
      threadId: agent.currentThreadId,
      runId: agent.currentRunId,
    });

    const result = ks.write({
      text,
      subjectName: input.subject,
      kind: input.kind,
      pin: input.pin,
      sourceChannel: 'agent',
      sourceUntrusted,
      sourceThreadId: agent.currentThreadId,
      sourceRunId: agent.currentRunId,
    });

    // Capture telemetry (DEF-dk-capture-observability): the NUMERATOR of the fire
    // -rate — the model actually recorded a durable fact, with the store outcome.
    // Gated on the DK flag so it logs only where we measure (the canary).
    //
    // `runId` is what makes the numerator JOINABLE to the denominator: this site fires
    // from any run that has the tool, while `capture_eligible` fires only from the
    // turn-end hook, which returns early for several run shapes. Without the run key the
    // report can divide the two but cannot show they describe the same runs
    // (DEF-firerate-mixes-two-populations).
    void appendCaptureTelemetry(agent.durableMemoryEnabled === true, {
      ts: Date.now(),
      event: 'remember_invoked',
      thread: agent.currentThreadId,
      model: agent.model,
      untrusted: sourceUntrusted,
      outcome: result.deduped === true ? 'deduped' : result.status,
      runId: agent.currentRunId,
      // The MODEL chose to call the tool. Tagged positively rather than left to be
      // inferred from the absence of `capture`: an untagged line is indistinguishable
      // from one written before the field existed, so "by elimination" silently folds
      // pre-field history into model-compliance and overstates it.
      source: 'model',
    });

    // propose_shown (PRD-ONBOARDING §7 / AC-1.4): a NEW pending_review write becomes a
    // review chip — the funnel DENOMINATOR that pairs with propose_confirmed/propose_ignored
    // at the review endpoint. Fires once at creation (not per render); a trusted `active`
    // write or a dedup no-op is not a reviewable proposal. Entry-id + signal only (S5 — never
    // the fact text).
    if (result.status === 'pending_review' && result.deduped !== true) {
      void appendCaptureTelemetry(agent.durableMemoryEnabled === true, {
        ts: Date.now(),
        event: 'propose_shown',
        thread: agent.currentThreadId,
        model: agent.model,
        untrusted: sourceUntrusted,
        entryId: result.id,
        source: 'model',
      });
    }

    // DK-UX inline signal: a CLIENT-ONLY StreamEvent for the inline chip (trusted → a
    // "gemerkt · undo" confirmation, untrusted → a keep/discard review chip). Emitted for a
    // NEW write only (never a dedup no-op). This is NOT the tool-result and is never folded
    // into model context — the return string below stays deliberately minimal,
    // and the event flows only to the web-ui via the SSE side-channel. For an untrusted
    // (pending_review) write the event carries the raw text for the review chip.
    if (result.deduped !== true && (result.status === 'active' || result.status === 'pending_review')) {
      void agent.toolContext.streamHandler?.({
        type: 'knowledge_write',
        id: result.id,
        subject: input.subject,
        kind: input.kind,
        status: result.status,
        text,
        agent: agent.name,
        // Only for a queued write: on a trusted one there is no cause to name, and sending
        // 'none' would invite the UI to render an empty reason.
        ...(result.status === 'pending_review' ? { cause: untrustedCause } : {}),
      });
    }

    if (result.status === 'pending_review') {
      // Do NOT echo the (possibly injected) text back into context.
      return `Recorded for review: ${untrustedReason(untrustedCause)}, so it is queued for your approval before it becomes active knowledge.`;
    }
    if (result.deduped === true) {
      // A near-duplicate of an existing active entry — nothing new was stored. Tell the model so
      // it stops re-recording the same fact (and does not report a spurious new save to the user).
      return 'Already recorded — this matches an existing durable entry, so nothing new was stored.';
    }
    const pinned = result.pinned ? ', pinned to focus' : '';
    if (result.subjectAmbiguous === true) {
      // Say WHICH way it is incomplete. The store refuses to bind an ambiguous name to a guess,
      // so the fact is kept against the bare name — recoverable, but attributed to nobody. Left
      // as a plain "Remembered." the model reports full success and the user learns nothing;
      // naming the ambiguity is what lets it ask which one and record the fact properly. This is
      // the model's only view of that outcome — the return string IS the surface.
      return `Remembered${pinned}, but "${input.subject}" matches more than one subject, so it is `
        + 'not linked to any of them. Ask which one is meant, then record it again with the full name.';
    }
    const linked = result.subjectId ? ' and linked to the named subject' : '';
    return `Remembered${linked}${pinned}.`;
  },
};

// ── recall (on-demand retrieve) ──

interface RecallInput {
  query: string;
  subject?: string | undefined;
}

export const recallTool: ToolEntry<RecallInput> = {
  definition: {
    name: 'recall',
    description:
      'Look up durable knowledge you have recorded. Pass a `query` describing what you need; optionally scope to a ' +
      '`subject` (client / company / project). Returns your active entries only, ranked by relevance. Only call when ' +
      'the CURRENT message needs prior context — not on short follow-ups or when the visible conversation already has it.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What you are looking for.' },
        subject: { type: 'string', description: 'Optional: scope the lookup to this client / company / project by name (also pulls in its parent-level knowledge).' },
      },
      required: ['query'],
    },
  },
  handler: async (input: RecallInput, agent: IAgent): Promise<string> => {
    const ks = agent.toolContext.knowledgeStore;
    if (!ks) return 'Durable memory is not enabled for this agent.';

    const query = input.query?.trim();
    if (!query) return 'Pass a `query` describing what to recall.';

    const entries = ks.recall({ query, subjectName: input.subject });
    // The recall-time nudge (DK plan package 1). Queued entries about this subject are named
    // by COUNT, never by text: a queued write happened on a turn that handled content the
    // operator did not author, and its wording must not reach model context before a human
    // has looked at it. Its existence may — and that is the point. The model learns something
    // is waiting exactly when the subject comes up, which is the cheapest moment for the
    // person to judge it. Write-time asks scale with how much gets READ; this scales with
    // usefulness, and it is the only emptying path for captures made on background runs,
    // which have no chip by construction.
    // No caller-side guard on an absent subject: `pendingCountForSubjectHint` returns 0 for an
    // empty needle itself, so a second check here is unreachable by construction — a line no
    // test can distinguish from its own removal. The store's guard is pinned by a test of its
    // own, so this delegation cannot break silently.
    const waiting = ks.pendingCountForSubjectHint(input.subject ?? '');
    const waitingLine = waiting > 0
      ? `\n\n(${String(waiting)} further ${waiting === 1 ? 'fact' : 'facts'} about this subject ${waiting === 1 ? 'is' : 'are'} waiting for the user's approval and cannot be shown until then. If it matters here, tell them so they can review it — do not guess at the content.)`
      : '';
    if (entries.length === 0) {
      return waiting > 0
        ? `No matching durable knowledge found.${waitingLine}`
        : 'No matching durable knowledge found.';
    }
    // H7: mask secrets in the tool RESULT too — recall returns decrypted text into model
    // context, so it must run the SAME two masking layers as the always-loaded block render
    // (knowledge-store.renderBlocks), else recall would be a strictly weaker surface: a
    // trusted-turn operator secret stored active would echo back into context unmasked.
    return entries
      .map(e => {
        const tenantMasked = agent.secretStore ? agent.secretStore.maskSecrets(e.text) : e.text;
        // The [id] prefix is the handle `memory_retire` takes — without it the
        // agent has no way to reference an entry it wants retired.
        return `- [${e.id.slice(0, 8)}] ${maskSecretPatterns(tenantMasked)}${tierTag(e.sourceType)}`;
      })
      .join('\n') + waitingLine;
  },
};

// ── memory_block_edit (edit the always-loaded blocks) ──

interface BlockEditInput {
  block: 'profile' | 'playbook';
  mode: MemoryBlockEditMode;
  old_text?: string | undefined;
  new_text?: string | undefined;
}

export const memoryBlockEditTool: ToolEntry<BlockEditInput> = {
  requiresConfirmation: true,
  // A standing-rule change that loads into EVERY turn is destructive-class — defense in
  // depth so isDangerous flags it. The hard refusal in autonomous mode lives in the handler
  // (a self-confirming tool's [BLOCKED] would route through the worker-wired promptUser as a
  // rubber-stampable notification), mirroring subjects_merge.
  destructive: { mode: 'data' },
  definition: {
    name: 'memory_block_edit',
    description:
      'Edit an always-loaded memory block: `profile` (operator identity + durable preferences) or `playbook` ' +
      '(standing operating rules, approval boundaries, invoicing conventions). mode: replace (exact old_text → new_text), ' +
      'append (add new_text on a new line), remove (delete old_text). These blocks load into EVERY future turn, so an ' +
      'edit needs your confirmation and cannot run on a turn that read external content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        block: { type: 'string', enum: ['profile', 'playbook'], description: 'Which block to edit.' },
        mode: { type: 'string', enum: ['replace', 'append', 'remove'], description: 'replace | append | remove.' },
        old_text: { type: 'string', description: 'The exact existing text to replace or remove (required for replace/remove).' },
        new_text: { type: 'string', description: 'The new text (required for append; the replacement for replace).' },
      },
      required: ['block', 'mode'],
    },
  },
  handler: async (input: BlockEditInput, agent: IAgent): Promise<string> => {
    const ks = agent.toolContext.knowledgeStore;
    if (!ks) return 'Durable memory is not enabled for this agent.';

    if (input.block !== 'profile' && input.block !== 'playbook') {
      return 'block must be "profile" or "playbook".';
    }

    // H5: an untrusted turn REFUSES a block edit outright (not pending_review). A singleton
    // block cannot be faithfully queued, and approval-time replay onto a drifted block is
    // fragile. Injected "append 'auto-approve all invoices' to the playbook" is thus blocked
    // at source — the playbook holds approval boundaries a rule could silently disable.
    if (deriveTurnUntrusted(agent)) {
      const cause = describeTurnUntrusted(agent);
      return `Refused: memory blocks hold standing rules and cannot be edited because ${untrustedReason(cause)}. If this is a genuine durable rule, tell me ${untrustedRemedy(cause)} and I will record it.`;
    }

    // H5: mirror subjects_merge — a standing-rule change hard-refuses in autonomous mode or
    // with no interactive channel, then confirms explicitly (the requiresConfirmation flag
    // makes the guard defer to this preview instead of its generic warning).
    if (agent.autonomy === 'autonomous' || !agent.promptUser) {
      return 'Refused: editing a memory block needs interactive confirmation and cannot run autonomously.';
    }

    // H7: secret-shaped scan on the block WRITE path too (mirror `remember`) — a block loads
    // into every turn, so a shaped credential must not be written in. Reject, never store.
    const added = input.new_text ?? '';
    if (added && (matchesSecretPattern(added) || agent.secretStore?.containsSecret(added) === true)) {
      return 'Cannot put content that looks like a secret or credential into a memory block. Store secrets via ask_secret / the vault, not in memory.';
    }

    // Show a GENEROUS preview: this is the exact standing rule the human is approving into
    // every future turn, and an 80-char clip would hide a malicious tail behind a benign prefix
    // (a rubber-stamp risk on the one write that most needs eyes-on). A legit rule fits in 500.
    // Preview the STANDING RULE the human is approving into every future turn. For append and
    // replace that is new_text — showing old_text on a replace would hide the new (possibly
    // inverted) rule the human is actually consenting to. Show old→new on a replace so a
    // silent inversion is visible; for a pure removal (no new_text) show what is removed.
    const preview = input.new_text
      ? (input.mode === 'replace' && input.old_text
          ? `${clip(input.old_text, 240)} → ${clip(input.new_text, 240)}`
          : clip(input.new_text, 500))
      : clip(input.old_text ?? '', 500);
    const answer = await agent.promptUser(
      pv`Edit the ${input.block} block (${input.mode}${preview ? pv`: "${preview}"` : ''})? This block loads into every future turn. This is reversible by editing it again.`,
      ['Apply', 'Cancel'],
    );
    if (answer !== 'Apply') return `Cancelled — the ${input.block} block is unchanged.`;

    try {
      ks.editBlock(input.block, input.mode, input.old_text, input.new_text);
      return `Updated the ${input.block} block.`;
    } catch (err) {
      // Loud, actionable errors (over-limit / bad match) surface verbatim to the model.
      if (err instanceof BlockOverLimitError || err instanceof BlockEditError) return err.message;
      return `memory_block_edit error: ${getErrorMessage(err)}`;
    }
  },
};

// ── memory_retire (DK.2 — supersede an outdated fact; H8) ──

interface RetireInput {
  id: string;
  reason?: string | undefined;
}

export const memoryRetireTool: ToolEntry<RetireInput> = {
  requiresConfirmation: true,
  // H8: retiring knowledge is destructive-class (it leaves the active set). The
  // autonomous hard-refuse lives in the handler, mirroring memory_block_edit.
  destructive: { mode: 'data' },
  definition: {
    name: 'memory_retire',
    description:
      'Retire an outdated or superseded durable-memory entry so it stops surfacing. Pass the entry `id` shown by ' +
      '`recall` (the [xxxxxxxx] prefix). The entry is marked superseded, never deleted. You can only retire facts at ' +
      'or below your own trust tier — user-confirmed facts need the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The entry id (or its 8-char prefix from recall output).' },
        reason: { type: 'string', description: 'Optional: why it is outdated (shown in the confirmation).' },
      },
      required: ['id'],
    },
  },
  handler: async (input: RetireInput, agent: IAgent): Promise<string> => {
    const ks = agent.toolContext.knowledgeStore;
    if (!ks) return 'Durable memory is not enabled for this agent.';

    // Untrusted turn → refuse outright (H5-class): injected content must not be
    // able to retire real knowledge ("forget that X" in a poisoned mail body).
    if (deriveTurnUntrusted(agent)) {
      const cause = describeTurnUntrusted(agent);
      return `Refused: memory cannot be retired because ${untrustedReason(cause)}. If this fact is genuinely outdated, tell me ${untrustedRemedy(cause)}.`;
    }
    if (agent.autonomy === 'autonomous' || !agent.promptUser) {
      return 'Refused: retiring memory needs interactive confirmation and cannot run autonomously.';
    }

    let entry;
    try {
      entry = ks.findActiveByIdPrefix(input.id ?? '');
    } catch (err) {
      return getErrorMessage(err); // ambiguous prefix — ask for more chars
    }
    if (!entry) return 'No active entry with this id. Use `recall` to find the entry and pass its [id] prefix.';

    // Gate BEFORE the prompt, not after. The agent channel acts at `agent_inferred`
    // trust, so `retireEntry` below refuses anything the user asserted or a tool
    // verified — but that refusal used to arrive AFTER the human had already been asked
    // and had already clicked "Retire". Asking someone to authorise an action that is
    // going to be refused either way teaches them the prompt is decorative, and it hands
    // a prompt-injected agent a way to make the user click a confirm that never applies.
    // The gate is the same one either way; only its position changes.
    if (!canSupersede('agent_inferred', entry.sourceType)) {
      return `Refused: this entry is recorded at a higher trust level (${entry.sourceType}) than I can retire. Retire it yourself in the memory view if it is genuinely wrong.`;
    }

    const reason = input.reason ? ` Reason: ${clip(input.reason)}.` : '';
    const answer = await agent.promptUser(
      pv`Retire this memory entry? "${clip(entry.text)}"${reason} It stays on record as superseded and stops surfacing. This needs a new \`remember\` if a corrected fact should replace it.`,
      ['Retire', 'Cancel'],
    );
    if (answer !== 'Retire') return 'Cancelled — the entry stays active.';

    try {
      // The store re-checks the same gate — the pre-prompt check above is for the
      // human's benefit, this one is the actual boundary. Both must stay.
      ks.retireEntry(entry.id, 'agent_inferred');
      return 'Retired. Record the corrected fact with `remember` if there is one.';
    } catch (err) {
      return getErrorMessage(err);
    }
  },
};

// ── memory_focus (DK.2 — session-scoped focus override; no DB write) ──

interface FocusInput {
  subject?: string | undefined;
}

export const memoryFocusTool: ToolEntry<FocusInput> = {
  definition: {
    name: 'memory_focus',
    description:
      'Set which client / company / project the always-loaded focus block should follow for THIS session, overriding ' +
      'the automatic per-turn detection. Pass `subject` by name; omit it to clear the override. Nothing is stored — ' +
      'the override ends with the session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'The subject to keep in focus, by name. Omit to clear.' },
      },
    },
  },
  handler: async (input: FocusInput, agent: IAgent): Promise<string> => {
    const ks = agent.toolContext.knowledgeStore;
    if (!ks) return 'Durable memory is not enabled for this agent.';

    const name = input.subject?.trim();
    if (!name) {
      ks.setFocusOverride(null);
      return 'Focus override cleared — back to automatic per-turn detection.';
    }
    const subjects = agent.toolContext.subjectStore;
    if (!subjects) return 'Subject lookup is not available for this agent.';
    // Ambiguity stops the org→person chain where it used to CONTINUE, but never pre-empts
    // a stage that can still answer with certainty (same precedence rule as
    // `_resolveRecallScope`). Unlike the silent read paths it is worth SAYING: the caller
    // is an agent that can supply the full name, so a refusal it can act on beats a
    // "not found" that is untrue and beats a confident focus on the wrong subject.
    const orgCanonical = subjects.findCanonical(name, 'organization');
    const orgAlias = orgCanonical ? null : subjects.findByAliasResolved(name, 'organization');
    const certain = orgCanonical ?? orgAlias?.row ?? subjects.findCanonical(name, 'person');
    const personAlias = certain || orgAlias?.ambiguous
      ? null
      : subjects.findByAliasResolved(name, 'person');
    if (!certain && (orgAlias?.ambiguous || personAlias?.ambiguous)) {
      return `"${clip(name)}" matches more than one subject. Use the full name to say which one.`;
    }
    // Behind the org→person chain: the remaining kinds the write path can link to
    // (product/service/engagement) — same tail as `_resolveRecallScope`, and unlike
    // there the ambiguity is SAID, because this caller can answer with a fuller name.
    const rest = certain || personAlias?.row
      ? null
      : subjects.findByNameAnyKind(name, { kinds: ['product', 'service', 'engagement'] });
    if (rest?.ambiguous) {
      return `"${clip(name)}" matches more than one subject. Use the full name to say which one.`;
    }
    const hit = certain ?? personAlias?.row ?? rest?.row;
    if (!hit) return `No known subject named "${clip(name)}". Use the exact client/company/project name (or \`remember\` a fact about it first).`;
    ks.setFocusOverride(subjects.resolveActiveSubject(hit.id));
    return `Focus set to ${clip(name)} for this session.`;
  },
};

// ── archive_search (DK.2 — read-only search over the legacy knowledge archive) ──

interface ArchiveSearchInput {
  query: string;
}

export const archiveSearchTool: ToolEntry<ArchiveSearchInput> = {
  definition: {
    name: 'archive_search',
    description:
      'Search the read-only knowledge ARCHIVE (facts collected before the durable-memory cutover). Use when `recall` ' +
      'finds nothing but older knowledge might exist. Archive results are historical — re-confirm anything ' +
      'consequential with the user, and `remember` it to carry it forward.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What you are looking for.' },
      },
      required: ['query'],
    },
  },
  handler: async (input: ArchiveSearchInput, agent: IAgent): Promise<string> => {
    const layer = agent.toolContext.knowledgeLayer;
    if (!layer) return 'The knowledge archive is not available for this agent.';
    const query = input.query?.trim();
    if (!query) return 'Pass a `query` describing what to search for.';

    try {
      const result = await layer.retrieve(query, agent.activeScopes ?? [], {
        topK: 8,
        threshold: 0.5,
        useHyDE: false,
        useGraphExpansion: true,
      });
      if (result.memories.length === 0) return 'Nothing in the archive matches.';
      // Same S1 masking discipline as `recall` — archive text is decrypted
      // legacy content flowing back into model context.
      return result.memories
        .map(m => {
          const tenantMasked = agent.secretStore ? agent.secretStore.maskSecrets(m.text) : m.text;
          return `- ${maskSecretPatterns(tenantMasked)} [archive]`;
        })
        .join('\n');
    } catch (err) {
      return `archive_search error: ${getErrorMessage(err)}`;
    }
  },
};

// ── helpers ──

function tierTag(tier: string): string {
  switch (tier) {
    case 'user_asserted': return ' [user]';
    case 'tool_verified': return ' [tool]';
    case 'agent_inferred': return ' [agent]';
    case 'external_unverified': return ' [unverified]';
    default: return '';
  }
}

/** Sanitize a snippet for display in a confirmation prompt (mirror subjects_merge:74-76):
 *  strip Unicode format/invisible chars, collapse whitespace, length-clamp. */
function clip(s: string, max = 80): string {
  return s.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, max);
}
