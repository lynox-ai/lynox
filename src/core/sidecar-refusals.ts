/**
 * What the engine records and says when it leaves out or refuses a whole-workspace operation in
 * shell sidecar mode (PRD D6, D7). The refusal itself is decided by the MODE, never the tier;
 * only the way out depends on the reader (ux, 2026-10-27). On a managed instance the workspace is handled by lynox support and
 * the account page. Without a tier there is no support path to name, and the files are managed
 * outside lynox, by whoever set the socket.
 */
import { readEnvAlias } from './env.js';

const PRIVACY_POLICY_URL = 'https://lynox.ai/privacy';
const OUTSIDE = 'On this instance you manage the workspace files outside lynox.';

const managed = (): boolean => !!readEnvAlias('LYNOX_BILLING_TIER');

/** The record a backup or a migration export carries when it left the workspace out (walkers 1, 2). */
export const OMITTED_SIDECAR = 'omitted-sidecar';

/** `DELETE /api/data` (D6). */
export function eraseRefusal(): string {
  const head = 'On this instance lynox does not delete everything item by item.';
  return managed()
    ? `${head} You remove everything by deleting the instance. To do that, cancel your subscription on your account page. When the instance is deleted after that is stated in the privacy policy (${PRIVACY_POLICY_URL}); to have it done right away, write to support@lynox.ai.`
    : `${head} ${OUTSIDE} Remove them where you manage them.`;
}

/** A backup restore whose manifest carries workspace entries (D7, walker 4). */
export function restoreRefusal(): string {
  const head = 'This backup contains files from the workspace. On this instance lynox does not restore them from a backup; nothing was changed. You can restore the rest from a backup without the workspace.';
  return managed() ? `${head} For the files, write to support@lynox.ai.` : `${head} ${OUTSIDE}`;
}

/** A migration import whose bundle carries a workspace (D7, walker 3). */
export function importRefusal(): string {
  const head = 'This import contains files from the workspace. On this instance lynox does not take them over in an import; nothing was changed.';
  return managed()
    ? `${head} Import without the workspace; for the files, write to support@lynox.ai.`
    : `${head} Import without the workspace. ${OUTSIDE}`;
}
