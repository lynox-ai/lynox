import type { RunHistory } from './run-history.js';
import type { InboxItem, PlannedPipeline } from '../types/index.js';
import { wrapChannelMessage } from './data-boundary.js';

/**
 * A typed reference to an object a chat is opened ON — the payload of the
 * Slice-C context-injection seam (§4.6). A "💬 Bearbeiten" button passes
 * `{kind, id}`; the server resolves it to a context preamble it prepends to the
 * user's first message, so the agent has the object loaded without the user
 * pasting it. This is the reusable entry — any future "discuss this X"
 * affordance passes the same shape and the server owns how each `kind` renders.
 * `workflow` = a saved workflow to edit ("💬 Bearbeiten"); `run` = a (failed)
 * workflow run to diagnose + fix ("💬 Fixen"); `mail` = an inbox item to reply
 * to in chat ("💬 Im Chat beantworten") — the agent drafts + sends via the
 * mail_reply tool instead of a bespoke composer; `mail-batch` = N bulk-selected
 * inbox items to work through in one chat ("💬 N im Chat"), carrying the id
 * list instead of a single id.
 */
export type ChatContextRef =
  | { kind: 'workflow' | 'run' | 'mail'; id: string }
  | { kind: 'mail-batch'; ids: string[] };

/**
 * Every `kind` {@link resolveChatContext} accepts, as a runtime list.
 *
 * It exists for ONE reason, and the reason is mechanical rather than
 * descriptive: the untrusted-content sweep (`chat-context-untrusted-sweep.test.ts`)
 * drives *this* list, not a hand-written list of the kinds that happen to read
 * mail today. `satisfies Record<Kind, true>` makes the record fail to compile
 * when a new member joins {@link ChatContextRef} — so a future `mail-thread`
 * kind cannot be added without entering the sweep, and the sweep then decides
 * whether its output is wrapped. The alternative — a list in the test — is a
 * list somebody has to REMEMBER to extend, which is the failure mode this row
 * was filed for.
 *
 * It has to live here, in `src/`, and not in the test: `src/**\/*.test.ts` is in
 * no tsc project (the main tsconfig excludes it, `tsconfig.tests.json` re-excludes
 * it), so a `satisfies` weld inside a test file is checked by nothing.
 *
 * ⚠ The weld is the load-bearing part, and it is the part with NO runtime
 * signature: replace the two declarations below with a hand-written
 * `['workflow', 'run', 'mail', 'mail-batch'] as ReadonlyArray<…>` and everything
 * still compiles, every test still passes, and the self-extension property is
 * silently gone. That is why the record is EXPORTED and why the sweep pins the
 * `satisfies` clause as source text — the only observable a compile-time
 * mechanism has. Do not "simplify" this into a literal.
 */
export const CHAT_CONTEXT_KIND_SET = {
  workflow: true,
  run: true,
  mail: true,
  'mail-batch': true,
} as const satisfies Record<ChatContextRef['kind'], true>;

export const CHAT_CONTEXT_KINDS = Object.keys(
  CHAT_CONTEXT_KIND_SET,
) as ReadonlyArray<ChatContextRef['kind']>;

/**
 * Boundary sentinel the http-api seam appends AFTER a resolved preamble and
 * BEFORE the user's own text (`${preamble}\n${LOADED_CONTEXT_END}\n\n${userText}`).
 * Every preamble here OPENS with a `[Loaded …]` line; this closes the block. Two
 * jobs: it gives the model a clear end-of-loaded-context delimiter, and it lets
 * a downstream consumer strip the whole preamble on replay (the preamble is
 * engine framing, not the user's words — same store-as-sent / strip-at-render
 * contract as the `[Now:]` marker). The sentinel can't be forged on its own line
 * by the interpolated fields: the untrusted FREE-TEXT ones (mail from/subject/
 * body, workflow + step names, run error) all pass {@link oneLine}, which
 * collapses newlines, and the remaining fields (ids, status, mode) are
 * server-generated ids / enums with no newlines. Two consumers strip on it: the
 * server-side title derivation ({@link stripLoadedContext}, used by session
 * `generateThreadTitle`) and the web-ui bubble render (its own mirror of
 * `stripLoadedContext`, packages/web-ui/src/lib/utils/now-marker.ts).
 */
export const LOADED_CONTEXT_END = '[/loaded-context]';

/**
 * Matches a leading loaded-context block — `[Loaded …]` opener through the
 * {@link LOADED_CONTEXT_END} sentinel + its `\n\n` separator. Anchored on BOTH
 * markers so a user who merely types `[Loaded …]` is untouched. This is the
 * canonical (core) matcher; the web-ui carries a byte-identical copy it can't
 * import across the package boundary (guarded by the sentinel-value assertion in
 * the boundary test). Single lazy quantifier + literal tail ⇒ linear, no ReDoS.
 */
const LOADED_CONTEXT_AT_START = /^\[Loaded [\s\S]*?\n\[\/loaded-context\]\n\n/;

/**
 * Strip a leading loaded-context preamble from a composed message. Used
 * server-side where the composed text is consumed as if it were the user's own
 * words — the thread title, which is derived from the first message. Returns the
 * text unchanged when there is no preamble.
 */
export function stripLoadedContext(text: string): string {
  return text.replace(LOADED_CONTEXT_AT_START, '');
}

/**
 * Close a resolved preamble with the boundary sentinel + the separator before
 * the user's own text. This is the SINGLE source of the loaded-context framing:
 * the http-api seam calls it to build the prefix it prepends to the user's first
 * message, and the boundary test calls the same function — so a change to the
 * framing (e.g. dropping the sentinel) breaks the test instead of silently
 * re-opening the leak. Pair with the web-ui `stripLoadedContext` matcher.
 */
export function closeLoadedContext(preamble: string): string {
  return `${preamble}\n${LOADED_CONTEXT_END}\n\n`;
}

/**
 * The narrow read surface `resolveChatContext` needs to render a `mail`
 * context — structurally satisfied by `InboxStateDb` (which sits on the shared
 * mail-state.db connection, so it can also read the mail-owned
 * `processed_mail_messages` uid map via `getUidByMessageId`). Kept as an
 * interface so core/ stays decoupled from the inbox integration's concrete DB.
 */
export interface ChatInboxReader {
  getItem(id: string): InboxItem | null;
  getItemBody(id: string): { bodyMd: string } | null;
  /** Resolve the IMAP uid+folder for a stored message-id, or null if unknown
   *  (old/moved mail) — the caller then instructs a mail_search fallback. */
  getUidByMessageId(accountId: string, messageId: string): { uid: number; folder: string } | null;
}

const MAX_STEP_TASK_CHARS = 280;
const MAX_NAME_CHARS = 200;
const MAX_STEP_ID_CHARS = 80;
const MAX_ERR_CHARS = 500;
const MAX_MAIL_BODY_CHARS = 800;
const MAX_MAIL_SNIPPET_CHARS = 200;
const MAX_FOLDER_CHARS = 80;
const MAX_BATCH_ITEMS = 20;

/**
 * Collapse control characters (incl. newlines/tabs) to spaces and clamp the
 * length. The preamble interpolates user/agent-authored fields (the workflow
 * name, step ids, step tasks) into a multi-line block that OPENS with a
 * trusted-looking `[Loaded …]` marker; without this, a crafted name/task
 * carrying an embedded line break + a fake `[System: …]` line could inject
 * pseudo-system text that reads as a server directive. Provenance of these
 * fields is not guaranteed user-authored (a prior agent run, an import, or a
 * sync can write them), so sanitise always. The character class covers: all
 * whitespace (`\s`, incl. the Unicode line/paragraph separators U+2028/U+2029
 * + NBSP), the C0 control range + DEL (`\x00-\x1f`, `\x7f`), AND the C1 control
 * range `\x80-\x9f` — which contains U+0085 (NEL, Next Line), a line-break char
 * that `\s` and the C0 class both MISS (release-harden 2026-06-24). A plain
 * `[\r\n]` class misses all of the above.
 */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Resolve a context reference to a preamble string, or null when it can't be
 * loaded (no run history, unknown id, or a non-template one-shot run that isn't
 * an editable saved workflow). Best-effort by design: the caller prepends a
 * non-null result to the task and otherwise just runs the chat normally, so a
 * stale/foreign id degrades to a plain chat rather than an error. Single-tenant
 * container ⇒ every id resolved here is the tenant's own.
 */
/**
 * How the loaded workflow's grant came to be, rendered into the text the MODEL
 * reads before editing it. The grant tuple alone cannot say whether a human ever
 * looked at it, and an agent about to change a contract-governed workflow is
 * exactly who needs to know that: `authorship` means the engine inferred consent
 * from the fact that the user built the steps, not that anyone reviewed what the
 * workflow may reach.
 *
 * An absent origin renders as `contract-governed` alone — it is a legacy or
 * imported contract, and claiming either provenance for it would be a guess.
 */
function contractNote(contract: { origin?: string | undefined } | undefined): string {
  if (!contract) return '';
  if (contract.origin === 'authorship') return ' · contract-governed (confirmed by authorship, not reviewed)';
  if (contract.origin === 'reviewed') return ' · contract-governed (reviewed)';
  return ' · contract-governed';
}

export function resolveChatContext(
  runHistory: RunHistory | null,
  ref: ChatContextRef,
  inboxState?: ChatInboxReader | null,
): string | null {
  if (ref.kind === 'mail') {
    // An inbox item the user wants to answer in chat. The agent drafts + sends
    // via mail_reply (which has its own send-confirm) instead of a composer.
    if (!inboxState) return null;
    const item = inboxState.getItem(ref.id);
    if (!item) return null;
    // From/subject/body/message-id are the MOST untrusted fields in the app (an
    // external sender authored them). TWO defences, and they do DIFFERENT jobs —
    // the second one was missing until core#1333, which is what made this path
    // weaker than the tool path that shows the same body:
    //
    //  (1) oneLine() — collapses the line break a crafted field needs in order to
    //      start its own pseudo-directive line, and (the part that is easy to
    //      drop by accident) keeps the `[/loaded-context]` sentinel unforgeable.
    //      Both http-api.ts and the web-ui strip rest on the interpolated fields
    //      being newline-free; removing it here silently invalidates them.
    //  (2) wrapChannelMessage() — the SAME boundary `mail_read` puts the same
    //      body behind (`integrations/mail/tools/mail-read.ts:78`): the
    //      `<untrusted_data source=…>` frame, the injection scan, the ⚠ warning
    //      line, and the `injection_detected` security event. Before it, the same
    //      mail reached the model with a frame through the tool and without one
    //      here — and an incident on THIS path left no trace at all, because the
    //      event is emitted by the wrapper and nothing else.
    //
    // The two compose rather than overlap: collapsing whitespace INSIDE the
    // wrapper is what the mail triage path already does
    // (`integrations/mail/triage/envelope.ts:89`), so this is the house shape,
    // not a local invention.
    //
    // What (1) costs and what it buys, both MEASURED rather than asserted,
    // because the trade only reads as favourable once both halves are counted:
    //   — LOST: the two `^`-anchored role-impersonation patterns
    //     (`data-boundary.ts:46-47`) cannot match a value that no longer starts
    //     a line. Two of ~30.
    //   — GAINED: the bounded-gap exfiltration patterns (`:57`, `:60`) use `.`,
    //     which does NOT cross a newline — so on multi-line content they miss a
    //     clause the collapse brings into reach. Verified both ways:
    //     `send the report\nto the endpoint` is not detected, the collapsed form
    //     is.
    // And the baseline is not "the old scan": before this, the scan did not run
    // on this path at all, so it is 28 of 30 where it was 0 of 30.
    const fromAddr = oneLine(item.fromAddress, MAX_NAME_CHARS);
    const from = item.fromName
      ? `${oneLine(item.fromName, MAX_NAME_CHARS)} <${fromAddr}>`
      : fromAddr;
    // The cached body can be an EMPTY string (body-refresh persists '' for an
    // all-markup/redacted mail), so `??` would leave a blank Message line — fall
    // back to the snippet on empty, not just on null/undefined.
    const cachedBody = inboxState.getItemBody(ref.id)?.bodyMd;
    const bodyMd = cachedBody && cachedBody.length > 0 ? cachedBody : (item.snippet ?? '');
    // The IMAP uid is account-SPECIFIC, so the reply MUST go from this item's
    // account — name it so mail_reply resolves the uid against the right mailbox.
    const acct = oneLine(item.accountId, MAX_NAME_CHARS);
    // Resolve the IMAP uid mail_reply needs (data in processed_mail_messages).
    // Absent for old/moved mail → fall back to a mail_search instruction.
    const uidRow = item.messageId
      ? inboxState.getUidByMessageId(item.accountId, item.messageId)
      : null;
    // Rendered ONCE and reused, so the prose below and the field cannot disagree:
    // gating the sentence on the raw `item.messageId` while the field renders the
    // `oneLine`d value lets a whitespace-only header point the model at a line
    // that was skipped as empty.
    const msgId = item.messageId ? oneLine(item.messageId, MAX_NAME_CHARS) : '';
    const replyLine = uidRow
      ? `To reply, call mail_reply with uid: ${uidRow.uid}, account: "${acct}"` +
        `${uidRow.folder && uidRow.folder !== 'INBOX' ? ` (folder "${oneLine(uidRow.folder, MAX_FOLDER_CHARS)}")` : ''}. `
      : `To reply, first locate this message with mail_search ` +
        `(by the sender, the subject${msgId ? `, or the Message-ID shown above` : ''}) ` +
        `on account "${acct}", then mail_reply with its uid and account: "${acct}". `;
    // What stays OUTSIDE the boundary is engine-generated operational metadata —
    // the item id, the account, the IMAP uid/folder — the split `mail-read.ts:91-93`
    // states for the tool path ("Operational metadata only — engine-generated (UID,
    // folder, dates, attachment manifest) … stays in the trusted framing above the
    // wrapped envelope").
    //
    // ⚠ The Message-ID is where this path DIVERGES from mail-read, deliberately and
    // visibly, because a silent divergence from a cited authority is worse than
    // either choice: `mail-read.ts:96` pushes `Message-ID:` into that trusted array.
    // The header is written by the SENDER, so by mail-read's OWN stated rule
    // (engine-generated) it does not belong there — the placement contradicts the
    // comment three lines above it. Here it goes inside with the other
    // sender-authored fields and the instruction points at it instead of quoting
    // it. mail-read is not changed from here; see DEF-mail-read-message-id-trusted.
    //
    // Empty values use the same placeholders as the tool path (`mail-read.ts:83,87`)
    // rather than being dropped: `wrapChannelMessage` skips a value that is empty
    // after trim, and `InboxItem` documents pre-v11 rows as `''` for fromAddress AND
    // subject (`types/inbox.ts:77-82`) — so without them a real row renders an EMPTY
    // `<untrusted_data>` block and the model is told nothing at all about the mail.
    return (
      `[Loaded mail for reply — item: ${item.id}]\n` +
      `${wrapChannelMessage({
        source: `mail:${acct}:${fromAddr}`,
        fields: {
          From: from || '(unknown sender)',
          Subject: oneLine(item.subject, MAX_NAME_CHARS) || '(no subject)',
          ...(uidRow || !msgId ? {} : { 'Message-ID': msgId }),
          Message: oneLine(bodyMd, MAX_MAIL_BODY_CHARS) || '(empty body)',
        },
      })}\n\n` +
      replyLine +
      `Draft a reply, confirm the send with the user, then send it.`
    );
  }

  if (ref.kind === 'mail-batch') {
    // N inbox items the user bulk-selected to work through in one chat (the
    // "💬 N im Chat" bulk affordance). Same untrusted-content rules as the
    // single 'mail' kind — every sender-authored field passes through oneLine()
    // AND lands inside a per-item `<untrusted_data>` block. The item count is
    // capped so a huge selection can't blow up the preamble.
    //
    // ONE wrapper per item, not one for the whole list, and not one per field:
    // that is the shape `integrations/mail/triage/envelope.ts:84-95` already uses
    // for the same job (a numbered list of envelopes). What it buys is the right
    // provenance — the `source` attribute names THIS item's sender, so an alert
    // says which mailbox and which sender — and one scan per item instead of one
    // per field.
    //
    // ⚠ What it does NOT buy, stated because an earlier version of this comment
    // claimed it and `wrapChannelMessage`'s own docstring still did: the scan does
    // NOT catch a pattern that straddles two FIELDS of one mail. It renders
    // `label: value` lines, so a subject ending `…ignore all previous` and a body
    // starting `instructions…` are separated by `\nMessage: ` — and the override
    // pattern's `\s+` cannot cross that. Measured both ways: the labelled shape is
    // not detected, the unlabelled join is, and the pattern does fire within a
    // single field. The gap is the same on every channel-wrap caller
    // (mail-read, envelope, the inbox classifier) — see
    // DEF-wrapchannelmessage-labels-defeat-cross-field-scan. A pattern split
    // across two SENDERS' items is a different matter and is not a coherent
    // threat: two independent senders would have to coordinate.
    if (!inboxState) return null;
    const lines: string[] = [];
    for (const id of ref.ids.slice(0, MAX_BATCH_ITEMS)) {
      const item = inboxState.getItem(id);
      if (!item) continue;
      const fromAddr = oneLine(item.fromAddress, MAX_NAME_CHARS);
      const from = item.fromName
        ? `${oneLine(item.fromName, MAX_NAME_CHARS)} <${fromAddr}>`
        : fromAddr;
      const acct = oneLine(item.accountId, MAX_NAME_CHARS);
      const uidRow = item.messageId
        ? inboxState.getUidByMessageId(item.accountId, item.messageId)
        : null;
      const msgId = item.messageId ? oneLine(item.messageId, MAX_NAME_CHARS) : '';
      // Operational header — engine-generated, NOT sender-controlled, so it stays
      // in the trusted framing above the wrapped block. Same split as
      // `envelope.ts:83`, which calls it "Operational header — agent framing, NOT
      // user-controlled".
      const locator = uidRow
        ? `account "${acct}", uid ${uidRow.uid}` +
          `${uidRow.folder && uidRow.folder !== 'INBOX' ? ` (folder "${oneLine(uidRow.folder, MAX_FOLDER_CHARS)}")` : ''}`
        : `account "${acct}" — locate via mail_search` +
          `${msgId ? ` (by the Message-ID below)` : ''}`;
      lines.push(
        `${lines.length + 1}. ${locator}\n` +
        wrapChannelMessage({
          source: `mail:${acct}:${fromAddr}`,
          fields: {
            From: from || '(unknown sender)',
            Subject: oneLine(item.subject, MAX_NAME_CHARS) || '(no subject)',
            ...(uidRow || !msgId ? {} : { 'Message-ID': msgId }),
            Snippet: oneLine(item.snippet ?? '', MAX_MAIL_SNIPPET_CHARS) || '(no preview)',
          },
        }),
      );
    }
    if (lines.length === 0) return null;
    const more = ref.ids.length > MAX_BATCH_ITEMS
      ? ` (first ${MAX_BATCH_ITEMS} of ${ref.ids.length})`
      : '';
    return (
      `[Loaded ${lines.length} mails for batch triage${more}]\n` +
      lines.join('\n') +
      `\n\nWork through these with the user one at a time: for each, draft a ` +
      `reply (mail_reply with the listed account + uid) and confirm the send, ` +
      `or note if it only needs acknowledging. Use mail_search for any without a uid.`
    );
  }

  if (!runHistory) return null;

  if (ref.kind === 'workflow') {
    const row = runHistory.getPlannedPipeline(ref.id);
    if (!row) return null;
    let wf: PlannedPipeline;
    try {
      wf = JSON.parse(row.manifest_json) as PlannedPipeline;
    } catch {
      return null;
    }
    if (wf.template !== true) return null; // only saved workflows are editable
    const steps = (wf.steps ?? [])
      .map((s, i) => `  ${i + 1}. [${oneLine(s.id, MAX_STEP_ID_CHARS)}] ${oneLine(s.task ?? '', MAX_STEP_TASK_CHARS)}`)
      .join('\n');
    return (
      `[Loaded saved workflow for editing — id: ${wf.id}]\n` +
      `Name: "${oneLine(wf.name, MAX_NAME_CHARS)}"\n` +
      `Mode: ${wf.mode ?? 'autonomous'}${contractNote(wf.capabilityContract)}\n` +
      `Steps:\n${steps}\n\n` +
      `To change it, call update_workflow_steps with workflow_id "${wf.id}". ` +
      `Confirm destructive edits with the user first.`
    );
  }


  // ref.kind === 'run' — a (failed) workflow run to diagnose + fix in chat.
  const run = runHistory.getPipelineRun(ref.id);
  if (!run) return null;
  const stepResults = runHistory.getPipelineStepResults(run.id);
  const trace = stepResults
    .map(s => `  [${s.status}] ${oneLine(s.step_id, MAX_STEP_ID_CHARS)}${s.error ? ` — ${oneLine(s.error, MAX_ERR_CHARS)}` : ''}`)
    .join('\n');
  const hasFailure = run.status === 'failed' || stepResults.some(s => s.status === 'failed' || s.error);
  // Only point at the editable workflow if it still exists — a run can outlive a
  // deleted workflow, and naming a gone id would dead-end the fix.
  const wfExists = !!run.workflow_id && runHistory.getPlannedPipeline(run.workflow_id) !== undefined;
  return (
    `[Loaded workflow run — id: ${run.id}]\n` +
    `Workflow: "${oneLine(run.manifest_name, MAX_NAME_CHARS)}"${run.workflow_id ? ` (id: ${run.workflow_id})` : ''}\n` +
    `Status: ${run.status}${run.error ? `\nError: ${oneLine(run.error, MAX_ERR_CHARS)}` : ''}\n` +
    (trace ? `Steps:\n${trace}\n` : '') +
    (hasFailure
      ? `\nDiagnose with diagnose_workflow_run (run_id "${run.id}")` +
        (wfExists ? `, fix with update_workflow_steps (workflow_id "${run.workflow_id}"), then re-run with run_workflow.` : '.')
      : '')
  );
}
