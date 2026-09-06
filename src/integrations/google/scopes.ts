// === Google's scope identifiers ===
//
// ⚠ A LEAF module: no imports, so anything that needs to NAME a scope can do so
// without pulling the integration in. `google-auth.ts` reaches `node:http`,
// `node:crypto` and the egress guard at module scope, and the mail path holds
// `GoogleAuth` as a TYPE only — importing the map from there to check one scope
// would drag all of that into the mail graph.
//
// Only Google's own values live here. The three CLASSIFICATION sets and the
// request bundle stay in `google-auth.ts`, because they carry decisions.

export const SCOPES = {
  OPENID: 'openid',
  USERINFO_EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
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
  CALENDAR_LIST_READONLY: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  DOCS_READONLY: 'https://www.googleapis.com/auth/documents.readonly',
  DOCS: 'https://www.googleapis.com/auth/documents',
} as const;
