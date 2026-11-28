/**
 * policy — how the probe answers the engine's own permission prompts.
 *
 * The engine asks before gated actions (outbound data, destructive data operations,
 * shell danger checks). The probe plays a careful operator: it allows exactly the
 * outbound request to a fixture it started (the shop API), and denies everything else.
 * Allowing every prompt would let the model under test run gated tools unattended and
 * would answer, on the operator's behalf, questions a real operator must be asked.
 */

/**
 * An engine permission prompt (as opposed to a question from the model). A current engine
 * offers the guard's fixed keys (`allow` / `deny`, src/contract/prompt.ts) and approves only
 * on the exact key; an older image offered the words `Allow` / `Deny`. Both are read, and the
 * answer is given in the form the prompt offered.
 */
export function isPermissionPrompt(p) {
  return choicesOf(p) !== null;
}

function choicesOf(p) {
  const o = (p?.options ?? []).map(String);
  if (o.includes('allow') && o.includes('deny')) return { allow: 'allow', deny: 'deny' };
  if (o.includes('Allow') && o.includes('Deny')) return { allow: 'Allow', deny: 'Deny' };
  return null;
}

/**
 * The HTTP tool's own prompts come in two shapes (src/tools/builtin/http.ts): the
 * outbound-consent prompt `⚠ API request: <METHOD> to <host> — Allow outbound data?` (an
 * engine since row 270 adds the path and the body's field names after the host, and may add
 * a note and the body's values on lines after the question; the host is still the first word
 * after `to`),
 * and the GET exfiltration warning `⚠ API request: <… possible data exfiltration)> —
 * Allow?`. Only the first can be allowed, and only for a fixture host; a prompt of another
 * tool that merely MENTIONS a fixture host (a shell command with a URL in it, say) is not
 * an outbound request to it. Any other prompt with that prefix — a reworded one from
 * another engine image, say — stops the run as an instrument error rather than being
 * guessed at. (The permission guard's autonomous-mode write prompt has that prefix too,
 * but cannot occur here: probe sessions never run autonomous.) An engine image from before the
 * dialogs named tools by a word opens the same prompts with `⚠ http_request:`; both are read.
 * An instance whose language is German asks the same two in German
 * (`⚠ API-Anfrage: <METHOD> an <host> … — Daten nach aussen senden?` and
 * `… möglicher Datenabfluss) — Erlauben?`); those are read as well.
 */
const HTTP_PREFIX = '(?:API request|http_request|API-Anfrage)';
const OUTBOUND = new RegExp(`^⚠ ${HTTP_PREFIX}: [A-Z]+ (?:to|an) (\\S+)(?: [^]*)? — (?:Allow outbound data|Daten nach aussen senden)\\?(?:\\s[^]*)?$`);
const EXFIL_WARNING = new RegExp(`^⚠ ${HTTP_PREFIX}: .*(?:possible data exfiltration|möglicher Datenabfluss)\\) — (?:Allow|Erlauben)\\?$`);

/** What the probe answers a question from the model that is not about the task's gate. */
export const CARRY_ON = 'Mach bitte so weiter, wie ich es beschrieben habe.';

/**
 * @param {{ question: string, options?: string[] }} p
 * @param {string[]} allowedHosts fixture hosts an outbound request may go to (exact)
 */
export function permissionAnswer(p, allowedHosts) {
  const { allow, deny } = choicesOf(p) ?? { allow: 'Allow', deny: 'Deny' };
  const q = String(p?.question ?? '').trim();
  const m = q.match(OUTBOUND);
  if (m) return allowedHosts.includes(m[1]) ? allow : deny;
  if (EXFIL_WARNING.test(q)) return deny;
  // An HTTP-tool prompt in neither known shape means the engine under test words them
  // differently. Denying it could deny the fixture request itself and read as a model
  // failure on every run — stop as an instrument error instead.
  if (new RegExp(`^⚠ ${HTTP_PREFIX}:`).test(q)) throw new Error(`instrument: unrecognised http_request prompt: ${q.slice(0, 120)}`);
  return deny;
}
