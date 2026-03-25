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
    'cmd.start': '👋 <b>NODYN</b> — Your AI Business Assistant\n\nSend me any task and I\'ll work on it.\n\n<b>Commands:</b>\n/stop — Abort current task\n/clear — Start a fresh conversation\n/cost — Show usage costs\n/secret — Secrets sicher konfigurieren\n/status — Show current status\n/help — Show this help',
    'cmd.start_new': '👋 <b>Welcome to NODYN</b>\n\nI\'m your AI business assistant. I can help you with research, analysis, writing, planning, and much more.\n\nJust tell me what you need — for example:\n• <i>"Research competitors in my industry"</i>\n• <i>"Draft an email to a client"</i>\n• <i>"Analyze this document"</i> (send as attachment)\n\nWhat can I help you with?',
    'cmd.help': '<b>NODYN Commands:</b>\n\n/stop — Abort the current running task\n/clear — Start a fresh conversation\n/cost — Show usage costs\n/secret — How to configure secrets safely\n/status — Check if a task is running\n/help — Show this help message\n\nJust send any text or voice message to start a task. You can also send files (documents, images) for analysis.',
    'cmd.secret': '\uD83D\uDD12 <b>Secrets</b>\n\nSecrets (API keys, passwords) are sensitive data. For security, they are configured by your admin in the deployment settings \u2014 not via Telegram.\n\nIf you need access to a service, ask your admin to add the credentials.',
    'cmd.clear': '\uD83D\uDD04 Conversation cleared — starting fresh.\nYour long-term knowledge is preserved.',
    'cmd.stop_none': 'No active task to stop.',
    'cmd.status_running': '\uD83D\uDFE1 A task is currently running. Send /stop to abort.',
    'cmd.status_idle': '\uD83D\uDCA4 Idle — send a message to start a task.',

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
    'cmd.start': '👋 <b>NODYN</b> — Dein KI-Business-Assistent\n\nSchick mir eine Aufgabe und ich erledige sie.\n\n<b>Befehle:</b>\n/stop — Aktuelle Aufgabe abbrechen\n/clear — Neues Gespräch starten\n/cost — Kosten anzeigen\n/secret — Secrets sicher konfigurieren\n/status — Status anzeigen\n/help — Diese Hilfe anzeigen',
    'cmd.start_new': '👋 <b>Willkommen bei NODYN</b>\n\nIch bin dein KI-Business-Assistent. Ich kann dir bei Recherche, Analyse, Texten, Planung und vielem mehr helfen.\n\nSag mir einfach, was du brauchst — zum Beispiel:\n• <i>\u201ERecherchiere meine Konkurrenz\u201C</i>\n• <i>\u201ESchreib eine E-Mail an einen Kunden\u201C</i>\n• <i>\u201EAnalysiere dieses Dokument\u201C</i> (als Anhang senden)\n\nWomit kann ich dir helfen?',
    'cmd.help': '<b>NODYN Befehle:</b>\n\n/stop — Laufende Aufgabe abbrechen\n/clear — Neues Gespr\u00E4ch starten\n/cost — Kosten anzeigen\n/secret — Secrets sicher konfigurieren\n/status — Pr\u00FCfen ob eine Aufgabe l\u00E4uft\n/help — Diese Hilfe anzeigen\n\nSchick einfach eine Text- oder Sprachnachricht um eine Aufgabe zu starten. Du kannst auch Dateien (Dokumente, Bilder) zur Analyse senden.',
    'cmd.secret': '\uD83D\uDD12 <b>Secrets</b>\n\nSecrets (API-Keys, Passw\u00F6rter) sind sensible Daten. Aus Sicherheitsgr\u00FCnden werden sie vom Admin in den Deployment-Einstellungen konfiguriert \u2014 nicht \u00FCber Telegram.\n\nWenn du Zugang zu einem Service brauchst, bitte deinen Admin, die Zugangsdaten hinzuzuf\u00FCgen.',
    'cmd.clear': '\uD83D\uDD04 Gespr\u00E4ch gel\u00F6scht — wir starten frisch.\nDein gespeichertes Wissen bleibt erhalten.',
    'cmd.stop_none': 'Keine aktive Aufgabe zum Stoppen.',
    'cmd.status_running': '\uD83D\uDFE1 Eine Aufgabe l\u00E4uft gerade. Sende /stop zum Abbrechen.',
    'cmd.status_idle': '\uD83D\uDCA4 Bereit — schick mir eine Nachricht.',

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
