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
    'cmd.start': '👋 <b>LYNOX</b> — Your AI Business Assistant\n\nSend me any task and I\'ll work on it.\nUse /help for commands, /clear for a fresh start.',
    'cmd.start_new': '👋 <b>Welcome to LYNOX</b>\n\nI\'m your AI business assistant. I learn about your business and work for you autonomously.\n\n<b>What I can do:</b>\n• Research, analysis, writing, planning\n• Manage contacts and deals (built-in CRM)\n• Send and draft emails (Gmail)\n• Schedule meetings (Calendar)\n• Run background tasks and reminders\n• Connect to external APIs\n\nJust tell me what you need — for example:\n• <i>"Research competitors in my industry"</i>\n• <i>"Draft an email to a client"</i>\n• <i>"Show me my open deals"</i>\n\nWhat can I help you with?',
    'cmd.help': '<b>LYNOX Commands:</b>\n\n/clear — Fresh conversation (knowledge preserved)\n/stop — Abort current task\n/status — Check if a task is running\n/help — This message\n\nJust chat naturally — send text, voice, photos, or files.\n\n<b>Setup &amp; Settings:</b> Use the Web UI at your lynox instance for integrations, API keys, cost overview, and configuration.',
    'cmd.use_webui': '🌐 Use the Web UI for this — go to Settings → Integrations in your lynox instance.',
    'cmd.clear': '\uD83D\uDD04 Conversation cleared — starting fresh.\nYour long-term knowledge is preserved.',
    'cmd.bug_usage': '\uD83D\uDC1E <b>Report a Bug</b>\n\nUsage: <code>/bug Your description here</code>\n\nDescribe what went wrong and it will be sent to the development team.',
    'cmd.bug_sent': '\uD83D\uDC1E Bug report sent. Thank you!',
    'cmd.bug_failed': 'Could not send bug report. Please try again later.',
    'cmd.bug_disabled': 'Bug reporting is not configured.',
    'cmd.stop_none': 'No active task to stop.',
    'cmd.status_running': '\uD83D\uDFE1 A task is currently running. Send /stop to abort.',
    'cmd.status_idle': '\uD83D\uDCA4 Idle — send a message to start a task.',
    'cmd.cost_webui': '💰 Use the Web UI to see your full cost overview — go to History in your lynox instance.',

    // Messages
    'msg.busy': '\u23F3 I\'m still working on your last request. I\'ll be ready for your next one shortly!',
    'msg.unauthorized': '\u26D4 Unauthorized.',
    'msg.voice_unavailable': '\uD83C\uDF99\uFE0F Voice transcription is not available.\nThis usually means the Docker image was built without whisper support.\nmacOS: brew install whisper-cpp ffmpeg',
    'msg.voice_transcribing': '\uD83C\uDF99\uFE0F Transcribing\u2026',
    'msg.voice_failed': 'Could not transcribe voice message.',
    'msg.voice_privacy': '\uD83D\uDD12 Voice messages are sent to Mistral (Paris, EU) for transcription. The provider stores no audio. For on-device transcription, use a self-hosted instance with whisper.cpp.',
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
    'cmd.start': '👋 <b>LYNOX</b> — Dein KI-Business-Assistent\n\nSchick mir eine Aufgabe und ich erledige sie.\n/help f\u00FCr Befehle, /clear f\u00FCr ein neues Gespr\u00E4ch.',
    'cmd.start_new': '👋 <b>Willkommen bei LYNOX</b>\n\nIch bin dein KI-Business-Assistent. Ich lerne dein Business kennen und arbeite selbstständig für dich.\n\n<b>Was ich kann:</b>\n• Recherche, Analyse, Texte, Planung\n• Kontakte und Deals verwalten (CRM)\n• E-Mails senden und entwerfen (Gmail)\n• Termine planen (Kalender)\n• Aufgaben im Hintergrund erledigen\n• Externe APIs anbinden\n\nSag mir einfach, was du brauchst — zum Beispiel:\n• <i>\u201ERecherchiere meine Konkurrenz\u201C</i>\n• <i>\u201ESchreib eine E-Mail an einen Kunden\u201C</i>\n• <i>\u201EZeig mir meine offenen Deals\u201C</i>\n\nWomit kann ich dir helfen?',
    'cmd.help': '<b>LYNOX Befehle:</b>\n\n/clear — Neues Gespr\u00E4ch (Wissen bleibt erhalten)\n/stop — Aufgabe abbrechen\n/status — Pr\u00FCfen ob eine Aufgabe l\u00E4uft\n/help — Diese Hilfe\n\nEinfach chatten — Text, Sprache, Fotos oder Dateien senden.\n\n<b>Setup &amp; Einstellungen:</b> Nutze die Web UI deiner lynox-Instanz f\u00FCr Integrationen, API Keys, Kosten\u00FCbersicht und Konfiguration.',
    'cmd.use_webui': '\uD83C\uDF10 Nutze die Web UI daf\u00FCr — gehe zu Settings \u2192 Integrationen in deiner lynox-Instanz.',
    'cmd.clear': '\uD83D\uDD04 Gespr\u00E4ch gel\u00F6scht — wir starten frisch.\nDein gespeichertes Wissen bleibt erhalten.',
    'cmd.bug_usage': '\uD83D\uDC1E <b>Fehler melden</b>\n\nVerwendung: <code>/bug Deine Beschreibung hier</code>\n\nBeschreibe was schiefgelaufen ist und es wird ans Entwicklungsteam gesendet.',
    'cmd.bug_sent': '\uD83D\uDC1E Fehlerbericht gesendet. Danke!',
    'cmd.bug_failed': 'Fehlerbericht konnte nicht gesendet werden. Bitte sp\u00E4ter erneut versuchen.',
    'cmd.bug_disabled': 'Fehlermeldungen sind nicht konfiguriert.',
    'cmd.stop_none': 'Keine aktive Aufgabe zum Stoppen.',
    'cmd.status_running': '\uD83D\uDFE1 Eine Aufgabe l\u00E4uft gerade. Sende /stop zum Abbrechen.',
    'cmd.status_idle': '\uD83D\uDCA4 Bereit — schick mir eine Nachricht.',
    'cmd.cost_webui': '\uD83D\uDCB0 Nutze die Web UI f\u00FCr die Kosten\u00FCbersicht — gehe zu History in deiner lynox-Instanz.',

    // Messages
    'msg.busy': '\u23F3 Ich arbeite noch an deiner letzten Anfrage. Gleich bin ich wieder f\u00FCr dich da!',
    'msg.unauthorized': '\u26D4 Kein Zugang.',
    'msg.voice_unavailable': '\uD83C\uDF99\uFE0F Sprachtranskription ist nicht verf\u00FCgbar.\nDas Docker-Image wurde vermutlich ohne Whisper-Support gebaut.\nmacOS: brew install whisper-cpp ffmpeg',
    'msg.voice_transcribing': '\uD83C\uDF99\uFE0F Transkribiere\u2026',
    'msg.voice_failed': 'Sprachnachricht konnte nicht transkribiert werden.',
    'msg.voice_privacy': '\uD83D\uDD12 Sprachnachrichten werden zur Transkription an Mistral (Paris, EU) gesendet. Der Anbieter speichert keine Audiodaten. F\u00FCr lokale Transkription nutze eine selbst gehostete Instanz mit whisper.cpp.',
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
