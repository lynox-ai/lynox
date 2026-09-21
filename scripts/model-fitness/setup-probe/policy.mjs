/**
 * policy — how the probe answers the engine's own permission prompts.
 *
 * The engine asks before gated actions (outbound data, destructive data operations,
 * shell danger checks). The probe plays a careful operator: it allows exactly the
 * outbound request to a fixture it started (the shop API), and denies everything else.
 * Allowing every prompt would let the model under test run gated tools unattended and
 * would answer, on the operator's behalf, questions a real operator must be asked.
 */

/** An engine permission prompt (as opposed to a question from the model). */
export function isPermissionPrompt(p) {
  const o = (p?.options ?? []).map(String);
  return o.includes('Allow') && o.includes('Deny');
}

/**
 * The HTTP tool asks in two shapes (src/tools/builtin/http.ts): the outbound-consent
 * prompt `⚠ http_request: <METHOD> to <host> — Allow outbound data?`, and the GET
 * exfiltration warning `⚠ http_request: <warning> — Allow?`. Only the first can be
 * allowed, and only for a fixture host; a prompt of another tool that merely MENTIONS a
 * fixture host (a shell command with a URL in it, say) is not an outbound request to it.
 */
const OUTBOUND = /^⚠ http_request: [A-Z]+ to (\S+) — Allow outbound data\?$/;
const EXFIL_WARNING = /^⚠ http_request: .+ — Allow\?$/;

/** What the probe answers a question from the model that is not about the task's gate. */
export const CARRY_ON = 'Mach bitte so weiter, wie ich es beschrieben habe.';

/**
 * @param {{ question: string }} p
 * @param {string[]} allowedHosts fixture hosts an outbound request may go to (exact)
 */
export function permissionAnswer(p, allowedHosts) {
  const q = String(p?.question ?? '').trim();
  const m = q.match(OUTBOUND);
  if (m) return allowedHosts.includes(m[1]) ? 'Allow' : 'Deny';
  if (EXFIL_WARNING.test(q)) return 'Deny';
  // An HTTP-tool prompt in neither known shape means the engine under test words them
  // differently. Denying it could deny the fixture request itself and read as a model
  // failure on every run — stop as an instrument error instead.
  if (q.startsWith('⚠ http_request:')) throw new Error(`instrument: unrecognised http_request prompt: ${q.slice(0, 120)}`);
  return 'Deny';
}
