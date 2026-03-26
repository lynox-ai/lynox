// === Telegram i18n ===
// Simple string table for bot chrome (status, commands, follow-ups).
// Agent responses are already multilingual — this covers the UI wrapper.

import { TOOL_DISPLAY_NAMES } from '../../types/index.js';

export type Lang = 'de' | 'en';

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    // Status
    'status.thinking': 'Thinking\u2026',
    'status.working': 'Working\u2026',
    'status.done': 'Done',
    'status.error': 'Error',
    'status.stopped': 'Stopped',
    'status.tools_one': 'tool',
    'status.tools_many': 'tools',
    'status.earlier_one': 'earlier tool',
    'status.earlier_many': 'earlier tools',

    // Commands
    'cmd.start': '👋 <b>NODYN</b> — Your AI Business Assistant\n\nSend me any task and I\'ll work on it.\nUse /help for commands, /clear for a fresh start.',
    'cmd.start_new': '👋 <b>Welcome to NODYN</b>\n\nI\'m your AI business assistant. I learn about your business and work for you autonomously.\n\n<b>What I can do:</b>\n• Research, analysis, writing, planning\n• Manage contacts and deals (built-in CRM)\n• Send and draft emails (Gmail)\n• Schedule meetings (Calendar)\n• Run background tasks and reminders\n• Connect to external APIs\n\nJust tell me what you need — for example:\n• <i>"Research competitors in my industry"</i>\n• <i>"Draft an email to a client"</i>\n• <i>"Show me my open deals"</i>\n\nWhat can I help you with?',
    'cmd.help': '<b>NODYN Commands:</b>\n\n/google — Connect Google Workspace (Gmail, Sheets, Calendar)\n/clear — Fresh conversation (knowledge preserved)\n/stop — Abort current task\n/cost — Show costs\n/bug — Report a problem\n/help — This message\n\nJust chat naturally — send text, voice, photos, or files. No commands needed for most tasks.',
    'cmd.secret': '\uD83D\uDD12 <b>Secrets</b>\n\nSecrets (API keys, passwords) are sensitive data. For security, they are configured by your admin in the deployment settings \u2014 not via Telegram.\n\nIf you need access to a service, ask your admin to add the credentials.',
    'cmd.clear': '\uD83D\uDD04 Conversation cleared — starting fresh.\nYour long-term knowledge is preserved.',
    'cmd.bug_usage': '\uD83D\uDC1E <b>Report a Bug</b>\n\nUsage: <code>/bug Your description here</code>\n\nDescribe what went wrong and it will be sent to the development team.',
    'cmd.bug_sent': '\uD83D\uDC1E Bug report sent. Thank you!',
    'cmd.bug_failed': 'Could not send bug report. Please try again later.',
    'cmd.bug_disabled': 'Bug reporting is not configured.',
    'cmd.stop_none': 'No active task to stop.',
    'cmd.status_running': '\uD83D\uDFE1 A task is currently running. Send /stop to abort.',
    'cmd.status_idle': '\uD83D\uDCA4 Idle — send a message to start a task.',
    'cmd.google_no_creds': '\u26A0\uFE0F Google Workspace is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your server configuration.',
    'cmd.google_already': '\u2705 Google Workspace is already connected.',
    'cmd.google_prompt': '\uD83D\uDD17 <b>Connect Google Workspace</b>\n\n1. Open this link on your phone or computer:\n<a href="{url}">{url}</a>\n\n2. Sign in and enter this code:\n<code>{code}</code>\n\n3. Authorize access — I\'ll confirm here when it\'s done.\n\n<i>The code expires in 5 minutes.</i>',
    'cmd.google_success': '\u2705 <b>Google Workspace connected!</b>\n\nYou can now use Gmail, Sheets, Drive, Calendar, and Docs.\nTry: <i>"Check my emails"</i> or <i>"What meetings do I have this week?"</i>',
    'cmd.google_failed': '\u274C Google authorization failed or timed out. Try again with /google.',
    'cmd.google_status': '\uD83D\uDD17 <b>Google Workspace</b>\n\nStatus: {status}\n{details}',

    // Messages
    'msg.busy': '\u23F3 I\'m still working on your last request. I\'ll be ready for your next one shortly!',
    'msg.unauthorized': '\u26D4 Unauthorized.',
    'msg.voice_unavailable': '\uD83C\uDF99\uFE0F Voice transcription is not available.\nThis usually means the Docker image was built without whisper support.\nmacOS: brew install whisper-cpp ffmpeg',
    'msg.voice_transcribing': '\uD83C\uDF99\uFE0F Transcribing\u2026',
    'msg.voice_failed': 'Could not transcribe voice message.',
    'msg.file_error': 'Could not process the file.',
    'msg.file_too_large': '\uD83D\uDCC1 That file is too large (max 10 MB). Please compress or split it and try again.',
    'msg.image_error': 'Could not process the image.',
    'msg.timeout': '\u23F0 Task timed out — no activity for 5 minutes.',
    'msg.context_trimmed': '\uD83D\uDCA1 Older messages cleared from short-term memory. Key findings are preserved in your knowledge base.',
    'msg.followup_expired': 'These suggestions are no longer current. Just send me your next request!',

    // Follow-ups (fallback only — agent generates contextual labels dynamically)
    'followup.retry': 'Retry',
    'followup.explain': 'Explain',

    // Cost
    'cost.title': 'Cost Overview',
    'cost.session': 'This session',
    'cost.today': 'Today',

    // Sentry opt-in
    'sentry.prompt': '🛡️ <b>Help improve nodyn?</b>\n\nYou can send anonymized error reports so we can fix bugs faster.\n\n<b>What is sent:</b> error type, stack trace, nodyn version\n<b>What is never sent:</b> your messages, files, knowledge, or any personal data\n\nYou can disable this anytime in your server settings.',
    'sentry.yes': '✓ Yes, help improve',
    'sentry.no': 'No thanks',
    'sentry.thanks': '🛡️ Thank you! Anonymized error reports are now enabled. This helps us fix bugs faster.\n\n<i>Disable anytime by removing NODYN_SENTRY_DSN from your server config.</i>',
    'sentry.declined': '👌 No problem. You can enable this later via /bug or in your server settings.',

    // Support prompt
    'support.prompt': '💜 <b>nodyn is free and open.</b>\n\nIf it\'s saving you time, consider supporting the project so we can keep improving it.\n\nEvery contribution helps — no matter the amount.',
    'support.yes': '💜 Support nodyn',
    'support.no': 'Maybe later',
  },
  de: {
    // Status
    'status.thinking': 'Denke nach\u2026',
    'status.working': 'Arbeite\u2026',
    'status.done': 'Fertig',
    'status.error': 'Fehler',
    'status.stopped': 'Gestoppt',
    'status.tools_one': 'Tool',
    'status.tools_many': 'Tools',
    'status.earlier_one': 'vorheriges Tool',
    'status.earlier_many': 'vorherige Tools',

    // Commands
    'cmd.start': '👋 <b>NODYN</b> — Dein KI-Business-Assistent\n\nSchick mir eine Aufgabe und ich erledige sie.\n/help f\u00FCr Befehle, /clear f\u00FCr ein neues Gespr\u00E4ch.',
    'cmd.start_new': '👋 <b>Willkommen bei NODYN</b>\n\nIch bin dein KI-Business-Assistent. Ich lerne dein Business kennen und arbeite selbstständig für dich.\n\n<b>Was ich kann:</b>\n• Recherche, Analyse, Texte, Planung\n• Kontakte und Deals verwalten (CRM)\n• E-Mails senden und entwerfen (Gmail)\n• Termine planen (Kalender)\n• Aufgaben im Hintergrund erledigen\n• Externe APIs anbinden\n\nSag mir einfach, was du brauchst — zum Beispiel:\n• <i>\u201ERecherchiere meine Konkurrenz\u201C</i>\n• <i>\u201ESchreib eine E-Mail an einen Kunden\u201C</i>\n• <i>\u201EZeig mir meine offenen Deals\u201C</i>\n\nWomit kann ich dir helfen?',
    'cmd.help': '<b>NODYN Befehle:</b>\n\n/google — Google Workspace verbinden (Gmail, Sheets, Kalender)\n/clear — Neues Gespr\u00E4ch (Wissen bleibt erhalten)\n/stop — Aufgabe abbrechen\n/cost — Kosten anzeigen\n/bug — Problem melden\n/help — Diese Hilfe\n\nEinfach chatten — Text, Sprache, Fotos oder Dateien senden. F\u00FCr die meisten Aufgaben brauchst du keine Befehle.',
    'cmd.secret': '\uD83D\uDD12 <b>Secrets</b>\n\nSecrets (API-Keys, Passw\u00F6rter) sind sensible Daten. Aus Sicherheitsgr\u00FCnden werden sie vom Admin in den Deployment-Einstellungen konfiguriert \u2014 nicht \u00FCber Telegram.\n\nWenn du Zugang zu einem Service brauchst, bitte deinen Admin, die Zugangsdaten hinzuzuf\u00FCgen.',
    'cmd.clear': '\uD83D\uDD04 Gespr\u00E4ch gel\u00F6scht — wir starten frisch.\nDein gespeichertes Wissen bleibt erhalten.',
    'cmd.bug_usage': '\uD83D\uDC1E <b>Fehler melden</b>\n\nVerwendung: <code>/bug Deine Beschreibung hier</code>\n\nBeschreibe was schiefgelaufen ist und es wird ans Entwicklungsteam gesendet.',
    'cmd.bug_sent': '\uD83D\uDC1E Fehlerbericht gesendet. Danke!',
    'cmd.bug_failed': 'Fehlerbericht konnte nicht gesendet werden. Bitte sp\u00E4ter erneut versuchen.',
    'cmd.bug_disabled': 'Fehlermeldungen sind nicht konfiguriert.',
    'cmd.stop_none': 'Keine aktive Aufgabe zum Stoppen.',
    'cmd.status_running': '\uD83D\uDFE1 Eine Aufgabe l\u00E4uft gerade. Sende /stop zum Abbrechen.',
    'cmd.status_idle': '\uD83D\uDCA4 Bereit — schick mir eine Nachricht.',
    'cmd.google_no_creds': '\u26A0\uFE0F Google Workspace ist nicht konfiguriert. F\u00FCge GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET zur Server-Konfiguration hinzu.',
    'cmd.google_already': '\u2705 Google Workspace ist bereits verbunden.',
    'cmd.google_prompt': '\uD83D\uDD17 <b>Google Workspace verbinden</b>\n\n1. \u00D6ffne diesen Link auf deinem Handy oder Computer:\n<a href="{url}">{url}</a>\n\n2. Melde dich an und gib diesen Code ein:\n<code>{code}</code>\n\n3. Zugriff erlauben — ich best\u00E4tige hier, sobald es geklappt hat.\n\n<i>Der Code l\u00E4uft in 5 Minuten ab.</i>',
    'cmd.google_success': '\u2705 <b>Google Workspace verbunden!</b>\n\nDu kannst jetzt Gmail, Sheets, Drive, Calendar und Docs nutzen.\nProbier: <i>\u201ECheck meine Emails\u201C</i> oder <i>\u201EWelche Termine habe ich diese Woche?\u201C</i>',
    'cmd.google_failed': '\u274C Google-Autorisierung fehlgeschlagen oder abgelaufen. Versuch es nochmal mit /google.',
    'cmd.google_status': '\uD83D\uDD17 <b>Google Workspace</b>\n\nStatus: {status}\n{details}',

    // Messages
    'msg.busy': '\u23F3 Ich arbeite noch an deiner letzten Anfrage. Gleich bin ich wieder f\u00FCr dich da!',
    'msg.unauthorized': '\u26D4 Kein Zugang.',
    'msg.voice_unavailable': '\uD83C\uDF99\uFE0F Sprachtranskription ist nicht verf\u00FCgbar.\nDas Docker-Image wurde vermutlich ohne Whisper-Support gebaut.\nmacOS: brew install whisper-cpp ffmpeg',
    'msg.voice_transcribing': '\uD83C\uDF99\uFE0F Transkribiere\u2026',
    'msg.voice_failed': 'Sprachnachricht konnte nicht transkribiert werden.',
    'msg.file_error': 'Datei konnte nicht verarbeitet werden.',
    'msg.file_too_large': '\uD83D\uDCC1 Diese Datei ist zu gross (max. 10 MB). Bitte komprimiere oder teile sie und versuche es erneut.',
    'msg.image_error': 'Bild konnte nicht verarbeitet werden.',
    'msg.timeout': '\u23F0 Aufgabe abgelaufen — keine Aktivit\u00E4t seit 5 Minuten.',
    'msg.context_trimmed': '\uD83D\uDCA1 \u00C4ltere Nachrichten aus dem Kurzzeitged\u00E4chtnis entfernt. Wichtige Erkenntnisse bleiben in deiner Wissensdatenbank erhalten.',
    'msg.followup_expired': 'Diese Vorschl\u00E4ge sind nicht mehr aktuell. Schick mir einfach deine n\u00E4chste Anfrage!',

    // Follow-ups (fallback only — agent generates contextual labels dynamically)
    'followup.retry': 'Nochmal',
    'followup.explain': 'Erkl\u00E4ren',

    // Cost
    'cost.title': 'Kosten\u00FCbersicht',
    'cost.session': 'Diese Session',
    'cost.today': 'Heute',

    // Sentry opt-in
    'sentry.prompt': '\uD83D\uDEE1\uFE0F <b>nodyn verbessern helfen?</b>\n\nDu kannst anonymisierte Fehlerberichte senden, damit wir Bugs schneller fixen k\u00F6nnen.\n\n<b>Was gesendet wird:</b> Fehlertyp, Stack Trace, nodyn-Version\n<b>Was nie gesendet wird:</b> Deine Nachrichten, Dateien, Wissen oder pers\u00F6nliche Daten\n\nDu kannst das jederzeit in den Server-Einstellungen deaktivieren.',
    'sentry.yes': '\u2713 Ja, helfen',
    'sentry.no': 'Nein danke',
    'sentry.thanks': '\uD83D\uDEE1\uFE0F Danke! Anonymisierte Fehlerberichte sind jetzt aktiviert. Das hilft uns, Bugs schneller zu fixen.\n\n<i>Jederzeit deaktivieren: NODYN_SENTRY_DSN aus der Server-Konfiguration entfernen.</i>',
    'sentry.declined': '\uD83D\uDC4C Kein Problem. Du kannst das sp\u00E4ter \u00FCber /bug oder in den Server-Einstellungen aktivieren.',

    // Support prompt
    'support.prompt': '\uD83D\uDC9C <b>nodyn ist frei und offen.</b>\n\nWenn es dir Zeit spart, unterst\u00FCtze das Projekt, damit wir es weiter verbessern k\u00F6nnen.\n\nJeder Beitrag hilft — egal wie gross.',
    'support.yes': '\uD83D\uDC9C nodyn unterst\u00FCtzen',
    'support.no': 'Vielleicht sp\u00E4ter',
  },
};

// ---------------------------------------------------------------------------
// Tool display labels — German translations for TOOL_DISPLAY_NAMES
// English labels live in types/modes.ts (shared with CLI)
// ---------------------------------------------------------------------------

const TOOL_LABELS_DE: Record<string, string> = {
  bash: 'Befehl ausf\u00FChren',
  read_file: 'Datei lesen',
  write_file: 'Datei schreiben',
  batch_files: 'Dateien verarbeiten',
  http_request: 'Anfrage senden',
  web_research: 'Web durchsuchen',
  spawn_agent: 'Delegieren',
  ask_user: 'R\u00FCckfrage',
  run_pipeline: 'Workflow ausf\u00FChren',
  plan_task: 'Planen',
  task_create: 'Aufgabe erstellen',
  task_update: 'Aufgabe aktualisieren',
  task_list: 'Aufgaben anzeigen',
  memory_store: 'Merken',
  memory_recall: 'Erinnern',
  memory_delete: 'Vergessen',
  memory_update: 'Wissen aktualisieren',
  memory_list: 'Wissen durchsehen',
  memory_promote: 'Wissen aufwerten',
  data_store_create: 'Tabelle einrichten',
  data_store_insert: 'Daten hinzuf\u00FCgen',
  data_store_query: 'Daten durchsuchen',
  data_store_list: 'Tabellen anzeigen',
  data_store_delete: 'Daten l\u00F6schen',
  capture_process: 'Workflow speichern',
  promote_process: 'In Workflow umwandeln',
  google_gmail: 'Gmail',
  google_sheets: 'Google Sheets',
  google_drive: 'Google Drive',
  google_calendar: 'Google Calendar',
  google_docs: 'Google Docs',
};

/** Map internal tool name to a business-friendly display label. */
export function friendlyToolName(name: string, lang: Lang = 'en'): string {
  if (lang === 'de') {
    return TOOL_LABELS_DE[name] ?? TOOL_DISPLAY_NAMES[name] ?? name;
  }
  return TOOL_DISPLAY_NAMES[name] ?? name;
}

/** Translate a key to the given language. Falls back to English. */
export function t(key: string, lang: Lang = 'en'): string {
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
}

/** Detect language from Telegram's language_code. */
export function detectLang(languageCode: string | undefined): Lang {
  if (!languageCode) return 'en';
  const code = languageCode.toLowerCase();
  if (code === 'de' || code.startsWith('de-')) return 'de';
  return 'en';
}
