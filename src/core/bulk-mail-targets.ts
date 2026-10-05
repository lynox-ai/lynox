/**
 * Whether a bulk run's target is a mail provider's API — the one question this module
 * answers, kept apart from every place that acts on the answer so it can be tested
 * without sending anything.
 *
 * Why bulk runs refuse these: a bulk run writes many targets once a human approved the
 * plan, with the stored credential of the host. A mail provider's settings are such
 * targets — an auto-reply, a forwarding rule, a filter — and writing them makes the
 * provider send mail on its own, outside the chat in which every outgoing mail is
 * confirmed one by one. A bulk run is the wrong tool for that, so it does not do it.
 *
 * What the list is, honestly: an enumeration of mail APIs over a set that is OPEN. It
 * holds the ones this engine itself talks to (Gmail) and the mailbox paths of Microsoft
 * Graph; another mail provider's API is not refused because it is a mail API, only if it
 * is named here. A list of what IS allowed is not possible — a bulk run's host is any
 * API the owner connected — so the list names what is not.
 *
 * Matching is by host, and for hosts that also serve other things, by path segment:
 * `graph.microsoft.com` serves calendars and files too, so only its mailbox paths are
 * refused. Host and segments are compared lower-cased and percent-decoded, so a spelling
 * of the same resource is the same resource.
 */

/** Hosts whose whole API is a mailbox. */
const MAIL_HOSTS: ReadonlySet<string> = new Set([
  'gmail.googleapis.com',
  // The legacy Outlook REST API: mail, and calendars whose changes send invitations.
  'outlook.office.com',
  'outlook.office365.com',
]);

/** Google's shared API host serves Gmail under these leading path segments. */
const GOOGLE_SHARED_HOSTS: ReadonlySet<string> = new Set(['www.googleapis.com', 'googleapis.com']);
const GOOGLE_GMAIL_PREFIXES: readonly (readonly string[])[] = [['gmail'], ['upload', 'gmail'], ['batch', 'gmail']];

/** Microsoft Graph, in each of its national clouds. */
const GRAPH_HOSTS: ReadonlySet<string> = new Set([
  'graph.microsoft.com',
  'graph.microsoft.us',
  'dod-graph.microsoft.us',
  'microsoftgraph.chinacloudapi.cn',
]);
/** Graph path segments that address a mailbox: its messages, folders, sending, its
 *  settings (the automatic reply lives in `mailboxSettings`) and its inbox rules (which
 *  can forward). Anywhere in the path: `/v1.0/me/…` and `/v1.0/users/{id}/…` alike. */
const GRAPH_MAIL_SEGMENTS: ReadonlySet<string> = new Set([
  'messages',
  'mailfolders',
  'sendmail',
  'mailboxsettings',
  'messagerules',
  'inferenceclassification',
]);

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s).toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  });
}

/**
 * True when `url` addresses a mail provider's API as listed above. A value that is not an
 * absolute URL is not a target this answers for and returns false — the run's own URL
 * check refuses it before this matters.
 */
export function isMailProviderTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (MAIL_HOSTS.has(host)) return true;
  const segments = segmentsOf(parsed.pathname);
  if (GOOGLE_SHARED_HOSTS.has(host)) {
    return GOOGLE_GMAIL_PREFIXES.some((prefix) => prefix.every((p, i) => segments[i] === p));
  }
  if (GRAPH_HOSTS.has(host)) return segments.some((s) => GRAPH_MAIL_SEGMENTS.has(s));
  return false;
}
