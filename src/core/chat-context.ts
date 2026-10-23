import type { RunHistory } from './run-history.js';
import type { InboxItem, PlannedPipeline } from '../types/index.js';
import { detectInjectionAcross, wrapChannelMessage, wrapUntrustedData } from './data-boundary.js';
import { CONTAINED_READ_REFUSAL, containThreadFrom, threadIsContained, type Containment } from './containment.js';
import type { ThreadStore } from './thread-store.js';
import { stripUntrustedSeparators } from './sanitize.js';
import { approvalQueueEnabled, type ApprovalEntry, type StoredAddress } from './approval-store.js';
import { plainAddresses, type ApprovalScope } from './approval-view.js';

/**
 * The chat a context is loaded into, and the stores that contain it: a run started from a
 * contained chat is loaded only after the reading chat is contained too
 * (`containment.ts › containThreadFrom`).
 */
export interface ChatContextReader {
  readonly threadId: string | undefined;
  readonly containment: Containment | null;
  readonly threadStore: Pick<ThreadStore, 'getThread' | 'updateThread'> | null;
}

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
 * list instead of a single id; `approval` = a mail a run filed for approval that
 * the owner moved to chat to change ("Im Chat ändern") — the agent sends the
 * changed version through the interactive confirm.
 */
export type ChatContextRef =
  | { kind: 'workflow' | 'run' | 'mail' | 'approval'; id: string }
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
 * list somebody has to REMEMBER to extend.
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
  approval: true,
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
 * server-generated ids / enums with no newlines. The one exception is the
 * `approval` kind's draft text, which keeps its lines: there a line that reads as
 * the sentinel is escaped instead (`draftText`). Two consumers strip on it: the
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
const MAX_DRAFT_BODY_CHARS = 20_000;
const MAX_RECIPIENTS = 50;

/**
 * The narrow read surface an `approval` context needs: the entry, and whose entries the reading
 * session may load. `scope` is the request principal's ({@link ApprovalScope}); null loads none.
 */
export interface ChatApprovalReader {
  get(id: string): ApprovalEntry | null;
  readonly scope: ApprovalScope | null;
  /**
   * Whether a mail account is connected here and its uids name the same mail across a restart —
   * an IMAP mailbox. Gmail and Microsoft 365 number their mails per running instance, from 1, so
   * after a restart a stored uid can name another mail without any error; a reply is pointed at
   * its original by uid only where this holds.
   */
  accountUidsStable(accountId: string): boolean;
}

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
/**
 * Name the sender-authored fields that are ABSENT, for the engine's own framing
 * line — never as a value inside the untrusted block.
 *
 * The distinction is not cosmetic. A placeholder inside the block ("(no
 * subject)") is a statement the engine makes in a place a sender can write to,
 * and a sender who sets their subject to that exact string produces a
 * byte-identical result. Outside the block the assertion is unforgeable, and the
 * block then holds only what the sender actually wrote — which is what a
 * boundary is for. Returns '' when nothing is missing, so the common case adds
 * no tokens.
 */
function missingFieldNote(fields: Record<string, string>): string {
  const missing = Object.entries(fields).filter(([, v]) => v.length === 0).map(([k]) => k);
  return missing.length > 0 ? ` — no ${missing.join(', ')}` : '';
}

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
  reader?: ChatContextReader,
  approvals?: ChatApprovalReader | null,
): string | null {
  if (ref.kind === 'approval') return resolveApprovalContext(ref.id, approvals ?? null);

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
    //      being newline-free (or, for the `approval` kind's multi-line draft
    //      text, on its sentinel escape); removing it here silently invalidates them.
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
    // because the trade only reads as favourable once both halves are counted.
    // `INJECTION_PATTERNS` holds 21 entries (counted, not estimated — an earlier
    // version of this comment said "~30" and then hardened the guess into a
    // ratio):
    //   — LOST: the two `^`-anchored role-impersonation patterns cannot match a
    //     value that no longer starts a line. Two of 21, and exactly two — no
    //     other pattern in the set is anchored.
    //   — GAINED: the bounded-gap exfiltration patterns use `.`, which does NOT
    //     cross a newline, so on multi-line content they miss a clause the
    //     collapse brings into reach. Verified both ways:
    //     `send the report\nto the endpoint` is not detected, the collapsed form
    //     is.
    // And the baseline is not "the old scan": before this, the scan did not run
    // on this path at all, so it is 19 of 21 where it was 0 of 21.
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
    // the item id, the account, the IMAP uid/folder — the same split mail_read makes.
    // The Message-ID is written by the sender, so here, as in mail_read, it goes inside
    // with the other sender-authored fields and the instruction points at it instead of
    // quoting it. The block's label names the inbox item, not the sender's address.
    //
    // ⚠ ABSENCE IS STATED OUTSIDE THE BLOCK, and that placement is the point.
    // `wrapChannelMessage` skips a value that is empty after trim, and
    // `types/inbox.ts` documents pre-v11 rows as `''` for fromAddress AND subject
    // until the backfill runs — so a real row can render a block with nothing in
    // it. The tool path solves that with placeholders INSIDE the block
    // (`mail-read.ts:81,86`: `'(no subject)'`, `'(empty body)'`), and that is
    // exactly what must not be copied here: a sender can set their subject to the
    // literal string `(no subject)`, and then an engine statement about absence
    // and a sender's text are byte-identical. Whatever the engine asserts, it
    // asserts in its own framing, where no sender can reach it.
    // Keys are the field LABELS lowercased, so the note and the block name the same
    // things: "no subject, message" points at `Subject:` and `Message:`, not at
    // internal variable names the model never sees.
    const absent = missingFieldNote({ from: from, subject: oneLine(item.subject, MAX_NAME_CHARS), message: oneLine(bodyMd, MAX_MAIL_BODY_CHARS) });
    return (
      `[Loaded mail for reply — item: ${item.id}${absent}]\n` +
      `${wrapChannelMessage({
        source: `mail:${acct}:inbox:${item.id}`,
        fields: {
          From: from,
          Subject: oneLine(item.subject, MAX_NAME_CHARS),
          ...(uidRow || !msgId ? {} : { 'Message-ID': msgId }),
          Message: oneLine(bodyMd, MAX_MAIL_BODY_CHARS),
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
    // single field. A pattern split
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
      const subject = oneLine(item.subject, MAX_NAME_CHARS);
      const snippet = oneLine(item.snippet ?? '', MAX_MAIL_SNIPPET_CHARS);
      lines.push(
        // Absence rides on the locator line — engine framing, same reason as the
        // single 'mail' kind: a placeholder inside the block is forgeable.
        `${lines.length + 1}. ${locator}${missingFieldNote({ from, subject, snippet })}\n` +
        wrapChannelMessage({
          source: `mail:${acct}:inbox:${item.id}`,
          fields: {
            From: from,
            Subject: subject,
            ...(uidRow || !msgId ? {} : { 'Message-ID': msgId }),
            Snippet: snippet,
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
  // A run started from a contained chat: the reading chat is contained before anything of the
  // run is loaded, and without a reader (or when that fails) only the refusal is.
  const origin = runHistory.getPipelineRunOrigin(run.id);
  if (origin && threadIsContained(reader?.containment ?? null, origin)) {
    try {
      if (!reader) throw new Error('no reading chat');
      containThreadFrom(reader, origin, reader.threadId);
    } catch {
      return `[Loaded workflow run — id: ${run.id}]\n${CONTAINED_READ_REFUSAL}`;
    }
  }
  const stepResults = runHistory.getPipelineStepResults(run.id);
  const trace = stepResults
    .map(s => `  [${s.status}] ${oneLine(s.step_id, MAX_STEP_ID_CHARS)}${s.error ? ` — ${oneLine(s.error, MAX_ERR_CHARS)}` : ''}`)
    .join('\n');
  const hasFailure = run.status === 'failed' || stepResults.some(s => s.status === 'failed' || s.error);
  // Only point at the editable workflow if it still exists — a run can outlive a
  // deleted workflow, and naming a gone id would dead-end the fix.
  const wfExists = !!run.workflow_id && runHistory.getPlannedPipeline(run.workflow_id) !== undefined;
  // A contained chat may not call diagnose_workflow_run or update_workflow_steps: pointing at
  // them would send the model into two refusals.
  const readerContained = reader?.threadId !== undefined && reader.threadId !== '' && threadIsContained(reader.containment, reader.threadId);
  return (
    `[Loaded workflow run — id: ${run.id}]\n` +
    `Workflow: "${oneLine(run.manifest_name, MAX_NAME_CHARS)}"${run.workflow_id ? ` (id: ${run.workflow_id})` : ''}\n` +
    `Status: ${run.status}${run.error ? `\nError: ${oneLine(run.error, MAX_ERR_CHARS)}` : ''}\n` +
    (trace ? `Steps:\n${trace}\n` : '') +
    (hasFailure
      ? readerContained
        ? `\nThis chat has read data through a store connection, so it can only read and explain this run here; changing the workflow is not available in it.`
        : `\nDiagnose with diagnose_workflow_run (run_id "${run.id}")` +
          (wfExists ? `, fix with update_workflow_steps (workflow_id "${run.workflow_id}"), then re-run with run_workflow.` : '.')
      : '')
  );
}

/** Whether a scope may load an entry: the owner every one, a mandate only those filed under its
 *  own grant — matched by grant id, never by tag, so an owner's entry (no grant) is none of its. */
function approvalInScope(entry: ApprovalEntry, scope: ApprovalScope): boolean {
  if (scope.viewer === 'owner') return true;
  return entry.mandateId !== null && entry.mandateId === scope.mandateId;
}

/** Recipients as one line, at most {@link MAX_RECIPIENTS} of them, and how many were left out:
 *  that count is the engine's statement, so it goes into the framing, not beside the addresses. */
function addressLine(list: ReadonlyArray<StoredAddress>): { line: string; left: number } {
  const line = list.slice(0, MAX_RECIPIENTS).map((a) => {
    const address = oneLine(a.address, MAX_NAME_CHARS);
    return a.name !== undefined && a.name.trim() !== '' ? `${oneLine(a.name, MAX_NAME_CHARS)} <${address}>` : address;
  }).join(', ');
  return { line, left: Math.max(0, list.length - MAX_RECIPIENTS) };
}

/** A sender-written line that reads as the loaded context's end, with its bracket escaped. */
const FORGED_CONTEXT_END = /^([ \t]*)\[(\/loaded-context\])/gm;

/**
 * A draft's text as the chat gets it: its lines kept, CR and CRLF made `\n`, the other
 * separators and control characters made spaces ({@link stripUntrustedSeparators}) — U+2028,
 * U+2029 and NEL included, so `\n` is the only line break left. A line that would read as the
 * end of the loaded context has its bracket escaped: `wrapUntrustedData` already deadens its own
 * closing tag, but not this sentinel, and both the title and the chat bubble cut the preamble at
 * the first such line. That escape, not a one-line value, is what keeps this kind's preamble
 * whole. Cut at {@link MAX_DRAFT_BODY_CHARS} code points, never inside one; the caller says so
 * outside the block.
 */
function draftText(text: string): { text: string; length: number; cut: boolean } {
  const lines = stripUntrustedSeparators(text.replace(/\r\n?/g, '\n')).replace(FORGED_CONTEXT_END, '$1&#91;$2');
  const points = Array.from(lines);
  const cut = points.length > MAX_DRAFT_BODY_CHARS;
  return { text: cut ? points.slice(0, MAX_DRAFT_BODY_CHARS).join('') : lines, length: points.length, cut };
}

/** The day of a stored ISO date, or '' when it is none. */
function isoDay(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : '';
}

/**
 * The draft of an approval entry the owner moved to chat, or null. It loads only while the queue
 * is on, only for a scope that may read the entry, and only once the entry was moved to chat —
 * a waiting entry is still the card's to send, and loading it here as well would let the chat and
 * the card both send it. It loads as often as it is asked: opening the chat again is the way back
 * when the first turn did not go through.
 *
 * The draft was written by a model, often after it read foreign content, so every field of it
 * is inside an untrusted block — two of them: the header fields, and the text on its own. The
 * text keeps its lines, so in a block with the fields a line of it could pass for a field (a
 * `Bcc:` the draft does not have); in a block of its own no line of it can. The preamble is built
 * field by field from an allowlist: the draft (sending account, recipients, subject, text, a
 * requested follow-up), for a reply the mail it answers, and where the entry came from. Who
 * filed, set up or decided it — tags, mandate addresses, display names — is not on the list, so a
 * column added to the entry later does not reach the chat.
 *
 * A reply is pointed at the original by the account it was read through (`readAccountId`), its
 * uid and its folder — a uid names a mail only within one mailbox, and with smart reply-from the
 * sending account is another one. Only an IMAP account's uids hold across a restart, so only an
 * entry read through a connected IMAP account is pointed at by uid. Every other one — filed before
 * that account was stored, read through an account no longer connected or one whose provider
 * numbers its mails afresh per run — has the original looked up again by search, from what the
 * block shows of it; and so does a reply whose uid the provider no longer resolves.
 */
/** `<folder>:<uid>` as the reply was filed with, or null when it does not read. The folder may
 *  hold a colon; the uid cannot. */
function folderUidOf(v: string): { folder: string; uid: number } | null {
  const at = v.lastIndexOf(':');
  if (at <= 0) return null;
  const uid = Number(v.slice(at + 1));
  return Number.isInteger(uid) && uid >= 0 ? { folder: v.slice(0, at), uid } : null;
}

/**
 * How the chat finds the original of a moved reply: by the account it was read through, its uid
 * and folder when that account is connected and its uids hold across a restart, and the folder is
 * shown whole; else by search. Every value the sentence uses
 * that came from a mail or a model — sender, subject, date, folder — it names by its field in the
 * header block and never repeats. The folder is among them: some providers keep the folder a call
 * named rather than one they looked up.
 */
function replyRoute(
  r: { readAccountId?: string | undefined; originalFolderUid: string },
  shown: { sender: boolean; subject: boolean; date: boolean; folder: boolean },
  acct: string,
  accountUidsStable: (id: string) => boolean,
): string {
  const at = folderUidOf(r.originalFolderUid);
  const search = (() => {
    const by = [
      ...(shown.sender ? ['from set to its sender'] : []),
      ...(shown.subject ? ['subject set to its subject'] : []),
    ];
    if (by.length === 0) return `Neither its sender nor its subject can be searched for: ask the user which mail this replies to. `;
    const also = [
      ...(shown.folder ? ['folder set to its folder'] : []),
      ...(shown.date ? ['since set to the day before its date'] : []),
    ];
    return `Find the original with mail_search, using what the first block shows under "In reply to": ${[...by, ...also].join(', ')} — ` +
      `first in account "${acct}", then with account omitted, which searches every account. ` +
      (shown.date
        ? `If it finds several, take the earliest dated on or after the original's date; if that does not single one out, ask the user. `
        : `If it finds several, ask the user which one. `) +
      `If it finds none, ask the user. ` +
      // Without its folder the search looks in the inbox, where a later mail of the same thread
      // matches the same sender and subject.
      (at !== null && !shown.folder
        ? `Its folder cannot be named here, so what it finds may be a later mail of the same thread: before replying, show the user the sender, subject and date of the mail found and ask whether it is the one. `
        : '') +
      `Then reply with mail_reply using the account and uid of the mail it found` +
      `${shown.folder ? ' and that folder' : ''}. `;
  })();
  const read = r.readAccountId;
  if (read !== undefined && read !== '' && at !== null && shown.folder && accountUidsStable(read)) {
    return `To send a changed reply, call mail_reply with account: "${oneLine(read, MAX_NAME_CHARS)}", uid: ${String(at.uid)}` +
      `, folder: the folder shown under "In reply to" in the first block. ` +
      `If mail_reply cannot find that mail, search for it instead. ${search}`;
  }
  return `To send a changed reply: ${search}`;
}

function resolveApprovalContext(id: string, approvals: ChatApprovalReader | null): string | null {
  if (!approvalQueueEnabled() || approvals === null || approvals.scope === null) return null;
  const entry = approvals.get(id);
  if (entry === null || !approvalInScope(entry, approvals.scope)) return null;
  if (entry.status !== 'rejected' || entry.decidedReason !== 'moved_to_chat') return null;
  const filing = entry.filing;
  if (filing === null) return null;
  const p = filing.payload;
  const acct = oneLine(p.accountId, MAX_NAME_CHARS);
  const subject = oneLine(p.subject, MAX_NAME_CHARS);
  const body = draftText(p.bodyText);
  const to = addressLine(p.to);
  const cc = addressLine(p.cc);
  const bcc = filing.kind === 'mail_send' ? addressLine(filing.payload.bcc) : { line: '', left: 0 };
  const original = filing.kind === 'mail_reply' ? filing.payload.original : null;
  const followup = filing.kind === 'mail_send' ? filing.payload.trackFollowup : null;
  const source = entry.origin === null ? 'unknown' : entry.origin.source;
  const afterUntrusted = entry.origin?.afterUntrusted === true ? ' · filed after the run read content it did not write' : '';
  const leftCounts = ([['To', to.left], ['Cc', cc.left], ['Bcc', bcc.left]] as const).filter(([, k]) => k > 0);
  const left = leftCounts.map(([label, k]) => ` · ${label}: ${String(k)} more not shown`).join('');
  const cutNote = body.cut ? ` · message cut at ${String(MAX_DRAFT_BODY_CHARS)} of ${String(body.length)} characters` : '';
  const absent = missingFieldNote({ to: to.line, subject, message: body.text.trim() });
  // The original's subject is only searchable whole: a cut one is not shown, and not searched by.
  const origSubject = original === null ? '' : oneLine(original.subject, MAX_NAME_CHARS);
  const origSubjectWhole = original !== null && !origSubject.endsWith('…') && origSubject !== '';
  const origSender = original === null ? '' : oneLine(plainAddresses(original.from)[0] ?? '', MAX_NAME_CHARS);
  const origDate = original === null ? '' : isoDay(original.date);
  const origAt = filing.kind === 'mail_reply' ? folderUidOf(filing.payload.originalFolderUid) : null;
  // A folder the block cannot show as it is — cut, or with its spacing collapsed — is treated like
  // a cut subject: not shown, not searched in, and no uid pointed at in it. IMAP uids hold per
  // folder, and a folder named a little differently may exist too.
  const origFolderLine = origAt === null ? '' : oneLine(origAt.folder, MAX_FOLDER_CHARS);
  const origFolder = origAt !== null && origFolderLine === origAt.folder ? origFolderLine : '';
  // One scan over both blocks, handed to each, so a hit in either is announced in both; the
  // header block publishes the event. The one-line fields are read raw and as the block shows
  // them: the one-line form turns control characters into spaces, and a pattern split by one of
  // them only matches once it is a space. The folder is shown only as stored, so raw covers it.
  const injection = detectInjectionAcross([
    p.fromAddress, to.line, cc.line, bcc.line, p.subject, followup?.reason ?? '',
    original?.from ?? '', original?.subject ?? '', origAt?.folder ?? '', body.text,
    oneLine(p.fromAddress, MAX_NAME_CHARS), subject, followup === null ? '' : oneLine(followup.reason, MAX_NAME_CHARS),
    origSender, origSubject,
  ]);
  const head = `[Loaded draft moved from the approval queue — entry: ${entry.id} · ${filing.kind} · from a ${source} run${afterUntrusted}${left}${cutNote}${absent}]\n`;
  const fields = wrapChannelMessage({
    source: `approval:${entry.id}`,
    injection,
    fields: {
      From: oneLine(p.fromAddress, MAX_NAME_CHARS),
      To: to.line,
      Cc: cc.line,
      Bcc: bcc.line,
      Subject: subject,
      ...(followup !== null ? { 'Follow-up reason': oneLine(followup.reason, MAX_NAME_CHARS) } : {}),
      ...(original !== null ? {
        'In reply to, sender': origSender,
        'In reply to, subject': origSubjectWhole ? origSubject : '',
        'In reply to, date': origDate,
        'In reply to, folder': origFolder,
      } : {}),
    },
  });
  const message = wrapUntrustedData(body.text.trim() === '' ? '' : `Message: ${body.text}`, `approval:${entry.id}:message`, { injection, publishEvent: false });
  let send: string;
  if (filing.kind === 'mail_reply') {
    // The date is the original's UTC day, a mail server's SINCE goes by its own: a day earlier
    // keeps a mail from near midnight in the search.
    send = replyRoute(filing.payload, {
      sender: origSender !== '', subject: origSubjectWhole, date: origDate !== '', folder: origFolder !== '',
    }, acct, (a) => approvals.accountUidsStable(a)) +
      `Pass to and cc as in the draft unless the user changes them. `;
  } else {
    send = `To send a changed version, call mail_send from account "${acct}" with to, cc and bcc as in the draft unless the user changes them. ` +
      (followup !== null
        ? `The draft asked for a follow-up reminder in ${String(followup.reminder_in_days)} days` +
          `${followup.type !== undefined ? ` (type ${followup.type})` : ''} with the reason in the first block: pass it as track_followup unless the user changes it. `
        : '');
  }
  return (
    `${head}${fields}\n${message}\n\n` +
    `The draft's recipients are exactly those in the first block; the second block is only the message text. ` +
    `This draft was not sent from the approval queue. It may have been sent from a chat since it was moved — before sending, ask the user whether it already went out. ` +
    (leftCounts.length > 0 ? `Not every recipient is shown: ask the user how to handle the recipients not shown. ` : '') +
    (body.cut ? `Its message is cut here: ask the user before sending a shortened version. ` : '') +
    send +
    `Ask what to change, show the changed mail, and confirm the send with the user.`
  );
}
