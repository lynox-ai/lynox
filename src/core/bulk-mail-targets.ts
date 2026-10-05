/**
 * Whether a bulk run's target is a mail provider's API — the one question this module
 * answers, kept apart from every place that acts on the answer so it can be tested
 * without sending anything.
 *
 * Why bulk runs refuse these: a bulk run writes many targets once a human approved the
 * plan, with the stored credential of the host. A mail provider's settings are such
 * targets — an automatic reply, a forwarding rule — and so are calendar entries whose
 * change the provider announces by mail. Writing them makes the provider send mail on
 * its own, outside the chat in which every outgoing mail is confirmed one by one. A bulk
 * run is the wrong tool for that, so it does not do it.
 *
 * The list names the mail APIs a bulk run refuses: Gmail on every Google host that
 * serves it, the legacy Outlook REST hosts, and the mailbox and calendar resources of
 * Microsoft Graph. Graph also serves files, chats and directories, so there only the
 * resource right after its owner (`me`, `users/{id}`, `groups/{id}`) decides — a folder
 * that happens to be called `messages` in a drive is not a mailbox. Hosts and paths are
 * compared lower-cased and percent-decoded, and decoded before they are split, so an
 * encoded `/` is a separator like any other.
 */

/** Hosts whose whole API is mail and calendar. */
const MAIL_HOSTS: ReadonlySet<string> = new Set([
  // The legacy Outlook REST API: mail, and calendars whose changes send invitations.
  'outlook.office.com',
  'outlook.office365.com',
]);

/** Google hosts are `<label>.googleapis.com`; Gmail answers under these first labels
 *  (`gmail.mtls.googleapis.com` included) and under a `/gmail` path on any of them. */
const GOOGLE_GMAIL_LABELS: ReadonlySet<string> = new Set(['gmail', 'content-gmail']);
const GOOGLE_GMAIL_PREFIXES: readonly (readonly string[])[] = [['gmail'], ['upload', 'gmail'], ['batch', 'gmail']];

/** Microsoft Graph, in each of its national clouds. */
const GRAPH_HOSTS: ReadonlySet<string> = new Set([
  'graph.microsoft.com',
  'graph.microsoft.us',
  'dod-graph.microsoft.us',
  'microsoftgraph.chinacloudapi.cn',
]);
/** Graph resources, right after their owner, that are a mailbox or a calendar: messages,
 *  folders (inbox rules live under them), sending, the mailbox's settings (the automatic
 *  reply), calendar entries (an organiser's change mails the attendees) and a group's
 *  conversations (a post mails the group). */
const GRAPH_MAIL_RESOURCES: ReadonlySet<string> = new Set([
  'messages',
  'mailfolders',
  'sendmail',
  'mailboxsettings',
  'inferenceclassification',
  'events',
  'calendar',
  'calendars',
  'calendarview',
  'calendargroups',
  'threads',
  'conversations',
]);

function segmentsOf(pathname: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  return decoded.toLowerCase().split('/').filter((s) => s !== '');
}

/** The Graph resource a path addresses: the segment after `me`, or after `users/{id}` or
 *  `groups/{id}` — whichever owner comes first. Null when the path names no owner. */
function graphResource(segments: readonly string[]): string | null {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === 'me') return segments[i + 1] ?? null;
    if (segments[i] === 'users' || segments[i] === 'groups') return segments[i + 2] ?? null;
  }
  return null;
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
  if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) {
    if (GOOGLE_GMAIL_LABELS.has(host.split('.')[0]!)) return true;
    return GOOGLE_GMAIL_PREFIXES.some((prefix) => prefix.every((p, i) => segments[i] === p));
  }
  if (GRAPH_HOSTS.has(host)) {
    const resource = graphResource(segments);
    return resource !== null && GRAPH_MAIL_RESOURCES.has(resource);
  }
  return false;
}
