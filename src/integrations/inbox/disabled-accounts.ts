// === Accounts the inbox leaves out, and the runs that do not read them ===

/**
 * The mail accounts named in `LYNOX_INBOX_DISABLED_ACCOUNTS` (comma-separated account ids),
 * meant for sensitive mailboxes. The inbox does not classify them, and a run nobody watches
 * does not read them (PRD inbox-user-rules F6). Read on each call, so a test or a restart sees
 * the current value.
 */
export function inboxDisabledAccounts(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env['LYNOX_INBOX_DISABLED_ACCOUNTS'] ?? '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Whether nobody watches the run this agent is in. A worker run (a schedule, a trigger, a
 * workflow) is `autonomous` and keeps that for its children, but it HAS a `promptUser`: the
 * worker loop wires one that parks the question for later. So the callback alone does not
 * say that someone is there; the autonomy does, as for the spawn tool's headless check.
 */
export function nobodyWatches(agent: { readonly promptUser?: unknown; readonly autonomy?: string | undefined }): boolean {
  return agent.autonomy === 'autonomous' || typeof agent.promptUser !== 'function';
}

const NONE: ReadonlySet<string> = new Set<string>();

/** The accounts this agent's run must not read: the left-out ones when nobody watches. */
export function accountsNotReadBy(
  agent: { readonly promptUser?: unknown; readonly autonomy?: string | undefined },
  also: ReadonlySet<string> = NONE,
): ReadonlySet<string> {
  if (!nobodyWatches(agent)) return NONE;
  return new Set([...inboxDisabledAccounts(), ...also]);
}

/** Said by a mail tool asked for an account its run must not read. Fixed text. */
export function leftOutRefusal(tool: string): string {
  return `${tool}: this account is not read in a run nobody watches — the owner left it out of the inbox as a sensitive mailbox. Ask the user to look at it in a chat.`;
}
