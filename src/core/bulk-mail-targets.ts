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
 * Microsoft Graph. Graph also serves files, chats and directories: a name that only means
 * a mailbox is refused wherever it stands, a name that also means something else only
 * right after its owner (`me`, `users/{id}`, `groups/{id}`). Hosts and paths are
 * compared lower-cased and percent-decoded, so a spelling of a resource is that resource.
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
const GOOGLE_GMAIL_PREFIXES: readonly (readonly string[])[] = [['gmail'], ['upload', 'gmail'], ['batch']];

/** Microsoft Graph, in each of its national clouds. */
const GRAPH_HOSTS: ReadonlySet<string> = new Set([
  'graph.microsoft.com',
  'graph.microsoft.us',
  'dod-graph.microsoft.us',
  'microsoftgraph.chinacloudapi.cn',
]);
/** Graph segment names that only ever mean a mailbox, refused wherever they stand:
 *  folders (inbox rules live under them), sending, the mailbox's settings (the automatic
 *  reply), its rules and its focused-inbox overrides — and `$batch`, which carries other
 *  requests in its body. */
const GRAPH_MAIL_ANYWHERE: ReadonlySet<string> = new Set([
  'mailfolders',
  'sendmail',
  'mailboxsettings',
  'messagerules',
  'inferenceclassification',
  '$batch',
]);
/** Graph names that are a mailbox or calendar only right after their owner — `messages`
 *  is also a Teams chat's, a drive may hold a folder called `events`: messages, calendar
 *  entries (an organiser's change mails the attendees) and a group's conversations. */
const GRAPH_MAIL_RESOURCES: ReadonlySet<string> = new Set([
  'messages',
  'events',
  'calendar',
  'calendars',
  'calendarview',
  'calendargroups',
  'threads',
  'conversations',
]);

/** A path segment: its name, and whether it carried an OData key (`users('id')`). */
interface Segment { name: string; keyed: boolean }

/**
 * Path segments, lower-cased and percent-decoded one by one — a malformed escape spoils only
 * its own segment — and split again after decoding, so an encoded `/` is a separator.
 * OData key syntax is cut off (`mailFolders('inbox')` is `mailfolders`, keyed).
 */
function segmentsOf(pathname: string): Segment[] {
  return pathname.split('/').flatMap((raw) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    return decoded.toLowerCase().split('/');
  }).filter((s) => s !== '').map((s) => ({ name: s.replace(/\(.*$/, ''), keyed: s.includes('(') }));
}

/** The Graph resource a path addresses: after the version, the owner is `me`, or `users` /
 *  `groups` followed by an id (or carrying it as `users('id')`), and type casts
 *  (`microsoft.graph.user`) are skipped. Null when the path does not start that way. */
function graphResource(segments: readonly Segment[]): string | null {
  let i = segments[0]?.name === 'v1.0' || segments[0]?.name === 'beta' ? 1 : 0;
  const owner = segments[i];
  if (owner === undefined) return null;
  if (owner.name === 'me') i += 1;
  else if (owner.name === 'users' || owner.name === 'groups') i += owner.keyed ? 1 : 2;
  else return null;
  while (segments[i]?.name.startsWith('microsoft.graph.')) i += 1;
  return segments[i]?.name ?? null;
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
    return GOOGLE_GMAIL_PREFIXES.some((prefix) => prefix.every((p, i) => segments[i]?.name === p));
  }
  if (GRAPH_HOSTS.has(host)) {
    if (segments.some((seg) => GRAPH_MAIL_ANYWHERE.has(seg.name))) return true;
    const resource = graphResource(segments);
    return resource !== null && GRAPH_MAIL_RESOURCES.has(resource);
  }
  return false;
}
