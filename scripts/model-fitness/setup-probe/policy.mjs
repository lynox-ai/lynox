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
 * @param {{ question: string }} p
 * @param {string[]} allowedHosts fixture hosts an outbound request may go to
 */
export function permissionAnswer(p, allowedHosts) {
  const q = String(p?.question ?? '');
  return allowedHosts.some(h => q.includes(h)) ? 'Allow' : 'Deny';
}
