import type { RunHistory } from './run-history.js';
import type { InboxItem, PlannedPipeline } from '../types/index.js';

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
    // From/subject/body are the MOST untrusted fields in the app (an external
    // sender authored them) — always oneLine() to neutralise injected
    // pseudo-system lines, same as the workflow/run fields.
    const from = item.fromName
      ? `${oneLine(item.fromName, MAX_NAME_CHARS)} <${oneLine(item.fromAddress, MAX_NAME_CHARS)}>`
      : oneLine(item.fromAddress, MAX_NAME_CHARS);
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
    const replyLine = uidRow
      ? `To reply, call mail_reply with uid: ${uidRow.uid}, account: "${acct}"` +
        `${uidRow.folder && uidRow.folder !== 'INBOX' ? ` (folder "${oneLine(uidRow.folder, MAX_FOLDER_CHARS)}")` : ''}. `
      : `To reply, first locate this message with mail_search ` +
        `(by sender/subject${item.messageId ? ` or message-id "${oneLine(item.messageId, MAX_NAME_CHARS)}"` : ''}) ` +
        `on account "${acct}", then mail_reply with its uid and account: "${acct}". `;
    return (
      `[Loaded mail for reply — item: ${item.id}]\n` +
      `From: ${from}\n` +
      `Subject: "${oneLine(item.subject, MAX_NAME_CHARS)}"\n` +
      `Message:\n${oneLine(bodyMd, MAX_MAIL_BODY_CHARS)}\n\n` +
      replyLine +
      `Draft a reply, confirm the send with the user, then send it.`
    );
  }

  if (ref.kind === 'mail-batch') {
    // N inbox items the user bulk-selected to work through in one chat (the
    // "💬 N im Chat" bulk affordance). Same untrusted-content rules as the
    // single 'mail' kind — every sender-authored field passes through oneLine()
    // so a crafted From/Subject/snippet can't inject a pseudo-system line. The
    // item count is capped so a huge selection can't blow up the preamble.
    if (!inboxState) return null;
    const lines: string[] = [];
    for (const id of ref.ids.slice(0, MAX_BATCH_ITEMS)) {
      const item = inboxState.getItem(id);
      if (!item) continue;
      const from = item.fromName
        ? `${oneLine(item.fromName, MAX_NAME_CHARS)} <${oneLine(item.fromAddress, MAX_NAME_CHARS)}>`
        : oneLine(item.fromAddress, MAX_NAME_CHARS);
      const acct = oneLine(item.accountId, MAX_NAME_CHARS);
      const uidRow = item.messageId
        ? inboxState.getUidByMessageId(item.accountId, item.messageId)
        : null;
      const locator = uidRow
        ? `account "${acct}", uid ${uidRow.uid}` +
          `${uidRow.folder && uidRow.folder !== 'INBOX' ? ` (folder "${oneLine(uidRow.folder, MAX_FOLDER_CHARS)}")` : ''}`
        : `account "${acct}" — locate via mail_search` +
          `${item.messageId ? ` (message-id "${oneLine(item.messageId, MAX_NAME_CHARS)}")` : ''}`;
      lines.push(
        `${lines.length + 1}. From: ${from} — Subject: "${oneLine(item.subject, MAX_NAME_CHARS)}" — ${locator}\n` +
        `   ${oneLine(item.snippet ?? '', MAX_MAIL_SNIPPET_CHARS)}`,
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
      `Mode: ${wf.mode ?? 'autonomous'}${wf.capabilityContract ? ' · contract-governed' : ''}\n` +
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
