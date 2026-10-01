/**
 * What a Google tool says when it is called before a connection exists.
 *
 * ## Why this is a constant and not an inline string
 *
 * Since the visibility decision (PRD Stage 1 §3.2) the four Google tools are
 * registered from boot, connected or not — a model that can see the tool can
 * tell the user the feature exists and how to switch it on, one that cannot see
 * it cannot. The consequence is that the tool WILL be called before a
 * connection exists, and what it answers is therefore not an error string: it
 * is a sentence the model reads and generalises from, in the same context
 * window it will act in. That makes it product copy, and product copy that four
 * call sites each spell their own way is four different lessons.
 *
 * Each clause earns its place:
 *
 * - **"not connected YET"** — a state the user can change, not a fault.
 *   "Not configured" teaches the model something is broken, and a model that
 *   believes the product is broken says so to the user.
 * - **naming where** — one action instead of a dead end, and it removes the
 *   need to guess. A guessed settings path is worse than none, because the user
 *   follows it.
 * - **"you cannot connect it yourself"** — forecloses reaching for `ask_secret`
 *   or `api_setup`. Those are walled anyway, but a refusal the model does not
 *   understand invites a retry, and an agent asking for Google credentials in
 *   lynox's own dialog is a phishing shape the platform deliberately prevents.
 * - **"do not retry in this turn"** — the tool cannot become available
 *   mid-turn, so a retry is pure budget.
 */
export const GOOGLE_NOT_CONNECTED =
  'Google is not connected for this instance yet. The user can connect it in '
  + 'Settings → Channels → Google. You cannot connect it yourself. Tell the user '
  + 'what you would do once it is connected, and do not retry this tool in this turn.';
