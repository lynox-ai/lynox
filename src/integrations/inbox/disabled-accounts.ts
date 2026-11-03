// === Accounts the inbox leaves out ===

/**
 * The mail accounts named in `LYNOX_INBOX_DISABLED_ACCOUNTS` (comma-separated account ids),
 * meant for sensitive mailboxes. The inbox does not classify them, and a run nobody watches
 * does not read them, neither through `mail_triage` nor through `inbox_read` (PRD
 * inbox-user-rules F6). Read on each call, so a test or a restart sees the current value.
 */
export function inboxDisabledAccounts(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env['LYNOX_INBOX_DISABLED_ACCOUNTS'] ?? '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}
