// === What a Google grant actually permits, per product ===
//
// Pure and rune-free so it can be unit-tested; the store re-exports it. The
// mode/mismatch decision lives here for the same reason: it is a rule, and a
// rule that only exists inside a `$derived` is a rule nobody can test.

// Google's scope identifiers, spelled out because they are Google's values and
// cannot drift with our code. Matching is EXACT: the previous card derived
// Drive's label from `s.includes('/drive') && !s.includes('.readonly')`, which
// `drive.file` satisfies — so a Stage-1 grant of "files lynox creates" was
// rendered as "Drive — Read & Write" right next to the consent screen that
// says otherwise.
export const GOOGLE_SCOPE_IDS = {
	GMAIL_READONLY: 'https://www.googleapis.com/auth/gmail.readonly',
	GMAIL_SEND: 'https://www.googleapis.com/auth/gmail.send',
	GMAIL_MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
	GMAIL_COMPOSE: 'https://www.googleapis.com/auth/gmail.compose',
	GMAIL_METADATA: 'https://www.googleapis.com/auth/gmail.metadata',
	MAIL_GOOGLE_COM: 'https://mail.google.com/',
	SHEETS_READONLY: 'https://www.googleapis.com/auth/spreadsheets.readonly',
	SHEETS: 'https://www.googleapis.com/auth/spreadsheets',
	DRIVE_READONLY: 'https://www.googleapis.com/auth/drive.readonly',
	DRIVE_FILE: 'https://www.googleapis.com/auth/drive.file',
	DRIVE: 'https://www.googleapis.com/auth/drive',
	DRIVE_METADATA_READONLY: 'https://www.googleapis.com/auth/drive.metadata.readonly',
	CALENDAR_READONLY: 'https://www.googleapis.com/auth/calendar.readonly',
	CALENDAR_EVENTS: 'https://www.googleapis.com/auth/calendar.events',
	CALENDAR_FREEBUSY: 'https://www.googleapis.com/auth/calendar.freebusy',
	CALENDAR: 'https://www.googleapis.com/auth/calendar',
} as const;

const S = GOOGLE_SCOPE_IDS;

export interface ServiceGrant {
	/** The product name, shown verbatim. */
	name: string;
	/** i18n key for what the grant permits on that product. */
	labelKey: string;
}

/**
 * One line per Google product the grant actually covers.
 *
 * The rows are ordered strongest-first per product and the first match wins,
 * so a grant holding both `drive` and `drive.file` reads as full Drive rather
 * than as two contradictory lines.
 */
export function grantedServices(scopes: readonly string[]): ServiceGrant[] {
	const held = new Set(scopes);
	const rows: { name: string; scope: string; labelKey: string }[] = [
		{ name: 'Gmail', scope: S.MAIL_GOOGLE_COM, labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Gmail', scope: S.GMAIL_MODIFY, labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Gmail', scope: S.GMAIL_COMPOSE, labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Gmail', scope: S.GMAIL_SEND, labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Gmail', scope: S.GMAIL_READONLY, labelKey: 'integrations.scope_label_read' },
		{ name: 'Gmail', scope: S.GMAIL_METADATA, labelKey: 'integrations.scope_label_read' },
		{ name: 'Calendar', scope: S.CALENDAR, labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Calendar', scope: S.CALENDAR_EVENTS, labelKey: 'integrations.scope_label_calendar_events' },
		{ name: 'Calendar', scope: S.CALENDAR_READONLY, labelKey: 'integrations.scope_label_read' },
		{ name: 'Calendar', scope: S.CALENDAR_FREEBUSY, labelKey: 'integrations.scope_label_freebusy' },
		{ name: 'Drive', scope: S.DRIVE, labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Drive', scope: S.DRIVE_READONLY, labelKey: 'integrations.scope_label_read' },
		{ name: 'Drive', scope: S.DRIVE_METADATA_READONLY, labelKey: 'integrations.scope_label_read' },
		{ name: 'Drive', scope: S.DRIVE_FILE, labelKey: 'integrations.scope_label_drive_file' },
		{ name: 'Sheets', scope: S.SHEETS, labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Sheets', scope: S.SHEETS_READONLY, labelKey: 'integrations.scope_label_read' },
		{ name: 'Docs', scope: 'https://www.googleapis.com/auth/documents', labelKey: 'integrations.scope_label_readwrite' },
		{ name: 'Docs', scope: 'https://www.googleapis.com/auth/documents.readonly', labelKey: 'integrations.scope_label_read' },
	];
	const out: ServiceGrant[] = [];
	for (const row of rows) {
		if (!held.has(row.scope)) continue;
		if (out.some((s) => s.name === row.name)) continue;
		out.push({ name: row.name, labelKey: row.labelKey });
	}
	return out;
}

/** What the toggle offers. */
export type ScopeMode = 'standard' | 'full';
/**
 * What the server can OBSERVE. `legacy` is a grant taken before the named sets
 * existed; it is not selectable, and the card must not render it as a mismatch.
 */
export type ServerScopeMode = ScopeMode | 'legacy';

/**
 * Is the toggle asking for something the grant does not carry?
 *
 * A mismatch is an expression of INTENT: it exists only after the user moved
 * the toggle. Deriving it from the grant alone — which is what the removed
 * `detectScopeMode` did — made every legacy connection render a permanent
 * "re-authorize" prompt for a change nobody had asked for.
 */
export function scopeMismatch(args: {
  touched: boolean;
  authenticated: boolean;
  serverMode: ServerScopeMode | null | undefined;
  toggle: ScopeMode;
}): boolean {
  if (!args.touched) return false;
  if (!args.authenticated) return false;
  return args.serverMode !== args.toggle;
}

/**
 * Where the toggle parks when a status lands. `legacy` parks at `standard`
 * without claiming the grant IS standard — that distinction is what keeps it
 * out of `scopeMismatch`.
 */
export function toggleForServerMode(mode: ServerScopeMode | null | undefined): ScopeMode {
  return mode === 'full' ? 'full' : 'standard';
}
