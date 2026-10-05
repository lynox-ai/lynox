/**
 * Whether a bulk run's target is a mail provider's API — the one question this module
 * answers, kept apart from every place that acts on the answer so it can be tested
 * without sending anything.
 *
 * Why bulk runs refuse these: a bulk run writes many targets once a human approved the
 * plan, with the stored credential of the host. A mail provider's settings are such
 * targets — an automatic reply, a forwarding rule — and so are Graph's calendar entries,
 * whose change Outlook announces to the attendees by mail. Writing them makes the
 * provider send mail on its own, outside the chat in which every outgoing mail is
 * confirmed one by one. A bulk run is the wrong tool for that, so it does not do it.
 *
 * The list names the mail APIs a bulk run refuses: Gmail on every Google host that
 * serves it, the legacy Outlook REST hosts, and the mailbox and calendar resources of
 * Microsoft Graph. Graph also serves files, chats and directories: a name that only means
 * a mailbox is refused wherever it stands, a name that also means something else only
 * right after its owner (`me`, `users/{id}`, `groups/{id}`). Other services' calendars,
 * shares and invitations are not in this list. Hosts and paths are
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
const GOOGLE_GMAIL_PREFIXES: readonly (readonly string[])[] = [['gmail'], ['upload', 'gmail'], ['batch', 'gmail']];

/** Microsoft Graph, in each of its national clouds. */
const GRAPH_HOSTS: ReadonlySet<string> = new Set([
  'graph.microsoft.com',
  'graph.microsoft.us',
  'dod-graph.microsoft.us',
  'microsoftgraph.chinacloudapi.cn',
]);
/** Graph segment names that only ever mean a mailbox, refused wherever they stand:
 *  folders (inbox rules live under them), sending, the mailbox's settings (the automatic
 *  reply) and its focused-inbox overrides — and `$batch`, which carries other requests in
 *  its body. */
const GRAPH_MAIL_ANYWHERE: ReadonlySet<string> = new Set([
  'mailfolders',
  'sendmail',
  'mailboxsettings',
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

/** A path segment: its name without an OData key or a `microsoft.graph.` namespace, and
 *  whether it carried either (`users('id')`; a cast or a qualified action). */
interface Segment { name: string; keyed: boolean; qualified: boolean }

/**
 * Path segments, lower-cased and percent-decoded one by one — a malformed escape spoils only
 * its own segment — and split again after decoding, so an encoded `/` is a separator.
 * OData key syntax is cut off (`mailFolders('inbox')` is `mailfolders`, keyed), and so is
 * the `microsoft.graph.` namespace (`microsoft.graph.sendMail` is `sendmail`, qualified).
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
  }).filter((s) => s !== '').map((s) => {
    const bare = s.replace(/\(.*$/, '');
    const qualified = bare.startsWith('microsoft.graph.');
    return { name: qualified ? bare.slice('microsoft.graph.'.length) : bare, keyed: s.includes('('), qualified };
  });
}

/** The resource after the owner starting at `i`: `me`, or `users` / `groups` and an id
 *  (or `users('id')`), with casts (`microsoft.graph.user`) skipped. Null when no owner. */
function resourceAfterOwner(segments: readonly Segment[], i: number): string | null {
  const owner = segments[i];
  if (owner === undefined) return null;
  if (owner.name === 'me') i += 1;
  else if (owner.name === 'users' || owner.name === 'groups') i += owner.keyed ? 1 : 2;
  else return null;
  while (segments[i]?.qualified === true && !GRAPH_MAIL_RESOURCES.has(segments[i]!.name)) i += 1;
  return segments[i]?.name ?? null;
}

/**
 * Whether a Graph path addresses a mailbox or calendar resource: the resource after the
 * first owner in the path. Graph puts the owner first, or right after the version; reading
 * the first one wherever it stands also catches a segment placed before it. It can mistake
 * a drive folder called `me` for an owner; that refuses a write it need not, never the reverse.
 */
function graphMailResource(segments: readonly Segment[]): boolean {
  const first = segments.findIndex((x) => x.name === 'me' || x.name === 'users' || x.name === 'groups');
  if (first < 0) return false;
  const resource = resourceAfterOwner(segments, first);
  return resource !== null && GRAPH_MAIL_RESOURCES.has(resource);
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
    return graphMailResource(segments);
  }
  return false;
}
