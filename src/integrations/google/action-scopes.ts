// === One rule: gate each action on the scope THAT action calls with ===
//
// Before this, each Google tool carried a `WRITE_ACTIONS` set and checked a
// single write scope. Read actions were gated by nothing at all, which was
// invisible while the default consent set granted every read scope. It stops
// being invisible on the managed broker set (`calendar.events`,
// `calendar.freebusy`, `drive.file`): a `google_sheets read` there is
// authorised by no granted scope, so it ran unbraked into Google's 403 and put
// an unspecified upstream error string on the prompt surface.
//
// The fix is deliberately NOT "add two read gates". Two gates would have to be
// re-derived on every tool and would miss the fifth one somebody adds. Each
// tool instead declares a `Record<Action, readonly string[]>` — so the compiler
// refuses a new action without a scope decision — and the check below is the
// only place that turns that declaration into a refusal.
//
// ⚠ These lists are what LYNOX requires, which is at most what Google accepts
// and sometimes deliberately less. `files.update` accepts `drive.file`, but
// `google_drive move` takes an arbitrary `file_id` that `drive.file` does not
// cover, so it keeps requiring full `drive` — a narrowing decided in the PRD,
// not an oversight to be "fixed" by widening the list.

import type { GoogleAuth } from './google-auth.js';

/**
 * `null` when the grant authorises the action, otherwise the refusal the model
 * reads.
 *
 * The refusal names the missing permission AND a remedy that exists for THIS
 * tenant. That second half is why the function takes `auth` rather than just a
 * scope list: on a brokered connection the old wording ("Grant access in
 * Settings → Channels → Google") pointed at a control the brokered card does
 * not render, so it read as "you forgot to tick a box" for a permission the
 * tenant cannot tick.
 */
export function refuseUnlessScoped(
  auth: GoogleAuth,
  accepted: readonly string[],
  whatTheActionDoes: string,
): string | null {
  if (accepted.some((scope) => auth.hasScope(scope))) return null;
  return `Error: ${whatTheActionDoes} requires one of these Google permissions: ${accepted.join(', ')}. ${grantRemedy(auth)}`;
}

/**
 * Where this tenant can actually widen its grant.
 *
 * The brokered branch keys on the credential having no client pair of its own,
 * which is the same fact the status route reports as `client_source === null`
 * — "the absence IS the mode". It is deliberately NOT keyed on the
 * control-plane identity: a managed tenant that brought its OWN Google client
 * has that identity too, and would get the wrong sentence.
 */
function grantRemedy(auth: GoogleAuth): string {
  if (auth.hasOwnClientPair()) {
    return 'Grant access in Settings → Channels → Google.';
  }
  return "This connection uses lynox's shared Google client, which asks only for calendar and Drive-file access. To grant more, connect your own Google Cloud client under Settings → Channels → Google → Advanced.";
}
