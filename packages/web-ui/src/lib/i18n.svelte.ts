export type Locale = 'de' | 'en';

let current = $state<Locale>('de');

const translations: Record<string, Record<Locale, string>> = {
	// Nav
	'nav.chat': { de: 'Chat', en: 'Chat' },
	'nav.knowledge': { de: 'Knowledge', en: 'Knowledge' },
	'nav.history': { de: 'History', en: 'History' },
	'nav.settings': { de: 'Settings', en: 'Settings' },
	'nav.new_chat': { de: '+ Neuer Chat', en: '+ New Chat' },
	'nav.tasks': { de: 'Tasks', en: 'Tasks' },

	// Command Palette
	'cmd.placeholder': { de: 'Suche oder Aktion...', en: 'Search or action...' },
	'cmd.no_results': { de: 'Keine Ergebnisse', en: 'No results' },
	'cmd.new_chat': { de: 'Neuer Chat', en: 'New Chat' },
	'cmd.nav': { de: 'Navigation', en: 'Navigation' },
	'cmd.actions': { de: 'Aktionen', en: 'Actions' },

	// Context Panel
	'panel.pin': { de: 'Fixieren', en: 'Pin' },
	'panel.pinned': { de: 'Fixiert', en: 'Pinned' },
	'panel.result': { de: 'Ergebnis', en: 'Result' },

	// Nav (extended)
	'nav.contacts': { de: 'Kontakte', en: 'Contacts' },
	'nav.files': { de: 'Dateien', en: 'Files' },
	'nav.graph': { de: 'Graph', en: 'Graph' },

	// Knowledge Graph
	'kg.title': { de: 'Knowledge Graph', en: 'Knowledge Graph' },
	'kg.search': { de: 'Entities suchen...', en: 'Search entities...' },
	'kg.no_entities': { de: 'Keine Entities. Chatte mit lynox, um den Knowledge Graph aufzubauen.', en: 'No entities. Chat with lynox to build the knowledge graph.' },
	'kg.mentions': { de: 'Erwaehnungen', en: 'mentions' },
	'kg.relations': { de: 'Beziehungen', en: 'Relations' },
	'kg.aliases': { de: 'Aliase', en: 'Aliases' },
	'kg.first_seen': { de: 'Erstmals gesehen', en: 'First seen' },
	'kg.all': { de: 'Alle', en: 'All' },
	'kg.people': { de: 'Personen', en: 'People' },
	'kg.orgs': { de: 'Organisationen', en: 'Organizations' },
	'kg.projects': { de: 'Projekte', en: 'Projects' },

	// CRM
	'crm.title': { de: 'Kontakte', en: 'Contacts' },
	'crm.deals': { de: 'Deals', en: 'Deals' },
	'crm.no_contacts': { de: 'Keine Kontakte. Erwaehne Personen im Chat, um sie automatisch zu erfassen.', en: 'No contacts. Mention people in chat to track them automatically.' },
	'crm.no_deals': { de: 'Keine Deals. Erwaehne Deals im Chat, um sie automatisch zu erfassen.', en: 'No deals. Mention deals in chat to track them automatically.' },
	'crm.interactions': { de: 'Interaktionen', en: 'Interactions' },
	'crm.stage': { de: 'Phase', en: 'Stage' },
	'crm.value': { de: 'Wert', en: 'Value' },

	// Backups
	'backups.title': { de: 'Backups', en: 'Backups' },
	'backups.no_backups': { de: 'Keine Backups. Erstelle dein erstes Backup.', en: 'No backups. Create your first backup.' },
	'backups.create': { de: 'Backup erstellen', en: 'Create backup' },
	'backups.creating': { de: 'Erstelle Backup...', en: 'Creating backup...' },
	'backups.encrypted': { de: 'Verschluesselt', en: 'Encrypted' },
	'backups.files': { de: 'Dateien', en: 'files' },

	// API Store
	'apis.title': { de: 'API Profiles', en: 'API Profiles' },
	'apis.no_profiles': { de: 'Keine API-Profile registriert.', en: 'No API profiles registered.' },
	'apis.endpoints': { de: 'Endpoints', en: 'Endpoints' },

	// DataStore
	'data.title': { de: 'Daten', en: 'Data' },
	'data.no_collections': { de: 'Keine Tabellen. Der Agent erstellt sie automatisch.', en: 'No tables. The agent creates them automatically.' },
	'data.rows': { de: 'Zeilen', en: 'rows' },

	// Files
	'files.title': { de: 'Dateien', en: 'Files' },
	'files.no_files': { de: 'Keine Dateien in diesem Ordner.', en: 'No files in this folder.' },
	'files.empty_workspace': { de: 'Noch keine Dateien.', en: 'No files yet.' },
	'files.empty_workspace_hint': { de: 'Der Agent erstellt hier Dateien fuer dich — Berichte, Exporte, Recherchen.', en: 'The agent creates files here for you — reports, exports, research.' },
	'files.show_hidden': { de: 'Versteckte', en: 'Hidden' },

	// Status Bar
	'status.engine_ok': { de: 'Engine OK', en: 'Engine OK' },
	'status.engine_error': { de: 'Engine Fehler', en: 'Engine Error' },
	'status.tasks_active': { de: 'aktiv', en: 'active' },
	'status.entities': { de: 'Entities', en: 'Entities' },
	'status.today': { de: 'heute', en: 'today' },
	'status.runs': { de: 'Runs', en: 'runs' },

	'common.ok': { de: 'OK', en: 'OK' },

	// Chat errors
	'chat.error_start': { de: 'Run konnte nicht gestartet werden', en: 'Failed to start run' },
	'chat.error_connection': { de: 'Verbindung unterbrochen', en: 'Connection lost' },

	// Chat
	'chat.welcome': { de: 'Was kann ich fuer dich tun?', en: 'What can I help you with?' },
	'chat.placeholder': { de: 'Nachricht eingeben...', en: 'Type a message...' },
	'chat.send': { de: 'Senden', en: 'Send' },
	'chat.stop': { de: 'Stop', en: 'Stop' },
	'chat.thinking': { de: 'lynox denkt...', en: 'lynox is thinking...' },
	'chat.hint': { de: 'Enter zum Senden, Shift+Enter fuer Zeilenumbruch', en: 'Enter to send, Shift+Enter for new line' },
	'chat.hint_streaming': { de: 'Esc zum Abbrechen', en: 'Esc to cancel' },
	'chat.allow': { de: 'Erlauben', en: 'Allow' },
	'chat.deny': { de: 'Ablehnen', en: 'Deny' },
	'chat.voice_unsupported': { de: '[Spracheingabe nicht verfuegbar]', en: '[Voice input not available]' },
	'chat.analyze_files': { de: 'Analysiere diese Dateien.', en: 'Analyze these files.' },
	'chat.mic_unavailable': { de: '[Mikrofon nicht verfuegbar]', en: '[Microphone not available]' },
	'chat.attach_file': { de: 'Datei anhaengen (max. 10 MB)', en: 'Attach file (max 10 MB)' },
	'chat.voice_input': { de: 'Spracheingabe', en: 'Voice input' },
	'chat.thinking_label': { de: 'Thinking', en: 'Thinking' },
	'chat.expand_all': { de: 'Alle aufklappen', en: 'Expand all' },
	'chat.collapse_all': { de: 'Alle zuklappen', en: 'Collapse all' },

	// Onboarding (kept for web-ui setup hints)
	'onboard.welcome': { de: 'Willkommen bei lynox', en: 'Welcome to lynox' },
	'onboard.standalone_hint': { de: 'Richte deinen API Key ein, um loszulegen.', en: 'Set up your API key to get started.' },
	'onboard.go_to_keys': { de: 'API Key einrichten', en: 'Set up API Key' },
	'onboard.api_key_needed': { de: 'Um loszulegen, brauchst du einen Anthropic API Key.', en: 'To get started, you need an Anthropic API key.' },
	'onboard.api_key_label': { de: 'Anthropic API Key', en: 'Anthropic API Key' },
	'onboard.api_key_hint': { de: 'Erstelle einen Key auf', en: 'Create a key at' },
	'onboard.api_key_secure': { de: 'Dein Key wird verschluesselt gespeichert und nie an lynox-Server gesendet.', en: 'Your key is encrypted and never sent to lynox servers.' },
	'onboard.next': { de: 'Weiter', en: 'Continue' },
	'onboard.setting_up': { de: 'Wird eingerichtet...', en: 'Setting up...' },
	'onboard.almost_done': { de: 'Fast fertig', en: 'Almost done' },
	'onboard.optional_hint': { de: 'Optionale Erweiterungen — du kannst das auch spaeter in den Settings machen.', en: 'Optional add-ons — you can also set these up later in Settings.' },
	'onboard.search_label': { de: 'Web Search (Tavily)', en: 'Web Search (Tavily)' },
	'onboard.search_hint': { de: 'Ermoeglicht Web-Suche. Gratis auf', en: 'Enables web search. Free at' },
	'onboard.google_label': { de: 'Google Workspace', en: 'Google Workspace' },
	'onboard.google_connect': { de: 'Google verbinden (Gmail, Drive, Calendar)', en: 'Connect Google (Gmail, Drive, Calendar)' },
	'onboard.skip': { de: 'Ueberspringen', en: 'Skip' },
	'onboard.done': { de: 'Fertig', en: 'Done' },
	'onboard.saving': { de: 'Speichern...', en: 'Saving...' },
	'onboard.loading': { de: 'Laden...', en: 'Loading...' },

	// Settings
	'settings.title': { de: 'Settings', en: 'Settings' },
	'settings.config': { de: 'Konfiguration', en: 'Configuration' },
	'settings.config_desc': { de: 'Modell, Effort, Thinking Mode', en: 'Model, effort, thinking mode' },
	'settings.keys': { de: 'API Keys', en: 'API Keys' },
	'settings.keys_desc': { de: 'Anthropic API Key verwalten (BYOK)', en: 'Manage Anthropic API key (BYOK)' },
	'settings.integrations': { de: 'Integrationen', en: 'Integrations' },
	'settings.integrations_desc': { de: 'Google Workspace (Gmail, Drive, Calendar)', en: 'Google Workspace (Gmail, Drive, Calendar)' },
	'settings.tasks': { de: 'Scheduled Tasks', en: 'Scheduled Tasks' },
	'settings.tasks_desc': { de: 'Hintergrund-Aufgaben erstellen und verwalten', en: 'Create and manage background tasks' },
	'settings.save': { de: 'Speichern', en: 'Save' },
	'settings.saving': { de: 'Speichern...', en: 'Saving...' },
	'settings.saved': { de: 'Gespeichert', en: 'Saved' },
	'settings.delete': { de: 'Loeschen', en: 'Delete' },
	'settings.back': { de: 'Settings', en: 'Settings' },

	// Config
	'config.title': { de: 'Konfiguration', en: 'Configuration' },
	'config.model': { de: 'Modell', en: 'Model' },
	'config.model_haiku': { de: 'Haiku (schnell, guenstig)', en: 'Haiku (fast, affordable)' },
	'config.model_sonnet': { de: 'Sonnet (balanciert)', en: 'Sonnet (balanced)' },
	'config.model_opus': { de: 'Opus (staerkstes Modell)', en: 'Opus (most capable)' },
	'config.effort': { de: 'Effort Level', en: 'Effort Level' },
	'config.effort_low': { de: 'Niedrig', en: 'Low' },
	'config.effort_medium': { de: 'Mittel', en: 'Medium' },
	'config.effort_high': { de: 'Hoch', en: 'High' },
	'config.thinking': { de: 'Thinking Mode', en: 'Thinking Mode' },
	'config.thinking_disabled': { de: 'Deaktiviert', en: 'Disabled' },
	'config.thinking_adaptive': { de: 'Adaptiv (empfohlen)', en: 'Adaptive (recommended)' },
	'config.memory_extraction': { de: 'Memory Extraction', en: 'Memory Extraction' },
	'config.memory_extraction_desc': { de: 'Agent lernt automatisch aus Gespraechen', en: 'Agent learns automatically from conversations' },

	// Budget
	'config.budget': { de: 'Budget', en: 'Budget' },
	'config.daily_limit': { de: 'Tageslimit (USD)', en: 'Daily limit (USD)' },
	'config.daily_limit_desc': { de: 'Maximale API-Kosten pro Tag. Leer = kein Limit.', en: 'Max API cost per day. Empty = no limit.' },
	'config.monthly_limit': { de: 'Monatslimit (USD)', en: 'Monthly limit (USD)' },
	'config.monthly_limit_desc': { de: 'Maximale API-Kosten pro Monat. Leer = kein Limit.', en: 'Max API cost per month. Empty = no limit.' },

	// Backup
	'config.backup': { de: 'Backup', en: 'Backup' },
	'config.backup_schedule': { de: 'Backup-Intervall', en: 'Backup schedule' },
	'config.backup_schedule_desc': { de: 'Cron-Ausdruck fuer automatische Backups. Leer = deaktiviert.', en: 'Cron expression for auto-backups. Empty = disabled.' },
	'config.backup_encrypt': { de: 'Backups verschluesseln', en: 'Encrypt backups' },
	'config.backup_encrypt_desc': { de: 'AES-256-GCM Verschluesselung mit Vault Key', en: 'AES-256-GCM encryption with vault key' },
	'config.backup_retention': { de: 'Aufbewahrung (Tage)', en: 'Retention (days)' },

	// Knowledge
	'config.knowledge': { de: 'Wissensmanagement', en: 'Knowledge' },
	'config.memory_half_life': { de: 'Halbwertszeit (Tage)', en: 'Half-life (days)' },
	'config.memory_half_life_desc': { de: 'Wie lange Wissen relevant bleibt (Default: 90 Tage)', en: 'How long knowledge stays relevant (default: 90 days)' },
	'config.embedding_provider': { de: 'Embedding Provider', en: 'Embedding Provider' },
	'config.embedding_onnx': { de: 'ONNX (lokal, kostenlos)', en: 'ONNX (local, free)' },
	'config.embedding_voyage': { de: 'Voyage (Cloud, bessere Qualitaet)', en: 'Voyage (cloud, better quality)' },

	// Limits
	'config.limits': { de: 'Limits', en: 'Limits' },
	'config.http_rate_limit': { de: 'HTTP Requests / Stunde', en: 'HTTP requests / hour' },
	'config.http_rate_limit_desc': { de: 'Rate Limit fuer das HTTP Tool. Leer = kein Limit.', en: 'Rate limit for the HTTP tool. Empty = no limit.' },
	'config.search_provider': { de: 'Suchmaschine', en: 'Search provider' },

	// Bug Reporting
	'config.privacy': { de: 'Datenschutz', en: 'Privacy' },
	'config.sentry': { de: 'Anonyme Fehlerberichte', en: 'Anonymous error reports' },
	'config.sentry_desc': { de: 'Hilft Bugs schneller zu fixen. Gesendet: Fehlertyp, Stack Trace, Version. Nie gesendet: Nachrichten, Dateien, Wissen.', en: 'Helps fix bugs faster. Sent: error type, stack trace, version. Never sent: messages, files, knowledge.' },
	'config.sentry_enabled': { de: 'Aktiviert', en: 'Enabled' },
	'config.sentry_disabled': { de: 'Deaktiviert', en: 'Disabled' },

	// Updates
	'config.updates': { de: 'Updates', en: 'Updates' },
	'config.update_check': { de: 'Automatisch auf Updates pruefen', en: 'Automatically check for updates' },
	'config.update_check_desc': { de: 'Prueft beim Start ob eine neue Version verfuegbar ist.', en: 'Checks on startup if a new version is available.' },
	'config.version_current': { de: 'Aktuelle Version', en: 'Current version' },
	'config.version_latest': { de: 'Neueste Version', en: 'Latest version' },
	'config.version_checking': { de: 'Pruefe...', en: 'Checking...' },
	'config.version_up_to_date': { de: 'Aktuell', en: 'Up to date' },
	'config.version_update_available': { de: 'Update verfuegbar', en: 'Update available' },
	'config.check_now': { de: 'Jetzt pruefen', en: 'Check now' },

	// Keys
	'keys.title': { de: 'API Keys', en: 'API Keys' },
	'keys.no_keys': { de: 'Keine API Keys gespeichert. Fuege unten deinen Anthropic API Key hinzu.', en: 'No API keys stored. Add your Anthropic API key below.' },
	'keys.add_title': { de: 'Neuen Key hinzufuegen', en: 'Add new key' },
	'keys.name_label': { de: 'Name', en: 'Name' },
	'keys.value_label': { de: 'Wert', en: 'Value' },

	// Tasks
	'tasks.title': { de: 'Scheduled Tasks', en: 'Scheduled Tasks' },
	'tasks.no_tasks': { de: 'Keine Tasks. Erstelle einen, um Aufgaben automatisch ausfuehren zu lassen.', en: 'No tasks. Create one to run jobs on a schedule.' },
	'tasks.create_title': { de: 'Neuen Task erstellen', en: 'Create new task' },
	'tasks.description_placeholder': { de: 'Task-Beschreibung', en: 'Task description' },
	'tasks.cron_placeholder': { de: 'Cron (optional, z.B. 0 9 * * 1)', en: 'Cron (optional, e.g. 0 9 * * 1)' },
	'tasks.create': { de: 'Erstellen', en: 'Create' },
	'tasks.next_run': { de: 'Naechster Lauf', en: 'Next run' },
	'tasks.last_run': { de: 'Letzter Lauf', en: 'Last run' },
	'tasks.presets': { de: 'Vorlagen:', en: 'Presets:' },
	'tasks.preset_daily': { de: 'Taeglich 9 Uhr', en: 'Daily 9 AM' },
	'tasks.preset_weekly': { de: 'Jeden Montag', en: 'Every Monday' },
	'tasks.preset_hourly': { de: 'Stuendlich', en: 'Every hour' },

	// Integrations
	'integrations.title': { de: 'Integrationen', en: 'Integrations' },
	'integrations.google_workspace': { de: 'Google Workspace', en: 'Google Workspace' },
	'integrations.google_services': { de: 'Gmail, Drive, Calendar, Sheets', en: 'Gmail, Drive, Calendar, Sheets' },
	'integrations.connected': { de: 'Verbunden', en: 'Connected' },
	'integrations.not_connected': { de: 'Nicht verbunden', en: 'Not connected' },
	'integrations.not_configured': { de: 'Nicht konfiguriert', en: 'Not configured' },
	'integrations.oauth_not_configured': { de: 'Google OAuth ist nicht konfiguriert. Setze GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET in den Engine-Umgebungsvariablen.', en: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the engine environment variables.' },
	'integrations.permissions': { de: 'Berechtigungen', en: 'Permissions' },
	'integrations.disconnect': { de: 'Verbindung trennen', en: 'Disconnect' },
	'integrations.disconnecting': { de: 'Trennen...', en: 'Disconnecting...' },
	'integrations.device_flow_hint': { de: 'Oeffne den folgenden Link und gib den Code ein:', en: 'Open the following link and enter the code:' },
	'integrations.waiting_auth': { de: 'Warte auf Autorisierung...', en: 'Waiting for authorization...' },
	'integrations.connect_google': { de: 'Mit Google verbinden', en: 'Connect with Google' },
	'integrations.connecting': { de: 'Verbinden...', en: 'Connecting...' },
	'integrations.credentials_hint': { de: 'Erstelle OAuth-Credentials in der', en: 'Create OAuth credentials in the' },
	'integrations.credentials_saved': { de: 'Credentials gespeichert. Engine wird neu gestartet...', en: 'Credentials saved. Restarting engine...' },
	'integrations.save_credentials': { de: 'Credentials speichern', en: 'Save credentials' },

	// Telegram
	'integrations.telegram': { de: 'Telegram Bot', en: 'Telegram Bot' },
	'integrations.telegram_desc': { de: 'Aufgaben per Telegram-Chat senden', en: 'Send tasks via Telegram chat' },
	'integrations.telegram_token': { de: 'Bot Token', en: 'Bot Token' },
	'integrations.telegram_token_hint': { de: 'Erstelle einen Bot bei', en: 'Create a bot at' },
	'integrations.telegram_chat_id': { de: 'Chat ID', en: 'Chat ID' },
	'integrations.telegram_chat_id_hint': { de: 'Schicke dem Bot eine Nachricht, dann oeffne', en: 'Send the bot a message, then open' },
	'integrations.telegram_configured': { de: 'Konfiguriert', en: 'Configured' },
	'integrations.telegram_save': { de: 'Speichern', en: 'Save' },
	'integrations.telegram_saved': { de: 'Gespeichert. Engine wird neu gestartet — Bot aktiviert sich automatisch.', en: 'Saved. Engine restarting — bot will activate automatically.' },

	// Web Search
	'integrations.search': { de: 'Web Search', en: 'Web Search' },
	'integrations.search_desc': { de: 'Webrecherche fuer den Agent', en: 'Web research for the agent' },
	'integrations.search_key_hint': { de: 'Gratis-Key auf', en: 'Free key at' },
	'integrations.search_configured': { de: 'Konfiguriert', en: 'Configured' },
	'integrations.search_not_configured': { de: 'Nicht konfiguriert', en: 'Not configured' },
	'integrations.search_saved': { de: 'Key gespeichert. Engine wird neu gestartet...', en: 'Key saved. Restarting engine...' },
	'integrations.tavily_label': { de: 'Tavily API Key', en: 'Tavily API Key' },

	// Memory
	'memory.title': { de: 'Knowledge', en: 'Knowledge' },
	'memory.no_entries': { de: 'Keine Eintraege in', en: 'No entries in' },
	'memory.no_entries_hint': { de: 'Fuege oben einen Eintrag hinzu, oder chatte mit lynox — Wissen wird automatisch gespeichert.', en: 'Add an entry above, or chat with lynox — knowledge is stored automatically.' },
	'memory.ns.knowledge': { de: 'Fakten, Kontakte, Geschaeftswissen', en: 'Facts, contacts, business knowledge' },
	'memory.ns.methods': { de: 'Bewaeaehrte Vorgehensweisen und Workflows', en: 'Proven approaches and workflows' },
	'memory.ns.project-state': { de: 'Laufende Projekte und deren Status', en: 'Active projects and their status' },
	'memory.ns.learnings': { de: 'Erkenntnisse und Praeferenzen', en: 'Insights and preferences' },
	'memory.edit': { de: 'Bearbeiten', en: 'Edit' },
	'memory.cancel': { de: 'Abbrechen', en: 'Cancel' },
	'memory.add_entry': { de: 'Eintrag hinzufuegen', en: 'Add entry' },
	'memory.add_placeholder': { de: 'Neuer Eintrag...', en: 'New entry...' },
	'memory.add_button': { de: 'Hinzufuegen', en: 'Add' },
	'memory.delete_entries': { de: 'Eintraege loeschen', en: 'Delete entries' },
	'memory.delete_placeholder': { de: 'Suchmuster...', en: 'Search pattern...' },
	'memory.delete_confirm_prefix': { de: 'Eintraege mit', en: 'Delete entries matching' },
	'memory.delete_confirm_suffix': { de: 'loeschen?', en: '?' },
	'memory.delete_confirm_from': { de: 'aus', en: 'from' },

	// History
	'history.title': { de: 'Run History', en: 'Run History' },
	'history.runs': { de: 'Runs', en: 'Runs' },
	'history.total': { de: 'Total', en: 'Total' },
	'history.no_runs': { de: 'Noch keine Runs. Starte einen Chat, um deinen ersten Run zu erstellen.', en: 'No runs yet. Start a chat to create your first run.' },
	'history.tool_calls': { de: 'Tool Calls', en: 'Tool Calls' },
	'history.response': { de: 'Antwort', en: 'Response' },
	'history.load_more': { de: 'Mehr laden', en: 'Load more' },
	'history.files_written': { de: 'Erstellte Dateien', en: 'Files written' },
	'history.pipeline': { de: 'Pipeline', en: 'Pipeline' },
	'history.spawned': { de: 'Sub-Agent', en: 'Sub-agent' },

	// Error page
	'error.fallback': { de: 'Etwas ist schiefgelaufen.', en: 'Something went wrong.' },

	// Common
	'common.loading': { de: 'Laden...', en: 'Loading...' },
	'common.back_to_chat': { de: 'Zurueck zum Chat', en: 'Back to chat' },
	'common.error': { de: 'Etwas ist schiefgelaufen.', en: 'Something went wrong.' },
	'common.save_failed': { de: 'Speichern fehlgeschlagen. Bitte erneut versuchen.', en: 'Save failed. Please try again.' },
	'common.load_failed': { de: 'Laden fehlgeschlagen. Ist die Engine erreichbar?', en: 'Failed to load. Is the engine reachable?' },
	'common.copied': { de: 'Kopiert', en: 'Copied' },
	'common.copy': { de: 'Kopieren', en: 'Copy' },
};

export function setLocale(locale: Locale): void {
	current = locale;
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem('lynox-locale', locale);
	}
}

export function getLocale(): Locale {
	return current;
}

export function initLocale(): void {
	if (typeof localStorage !== 'undefined') {
		const saved = localStorage.getItem('lynox-locale');
		if (saved === 'en' || saved === 'de') {
			current = saved;
			return;
		}
	}
	if (typeof navigator !== 'undefined') {
		current = navigator.language.startsWith('de') ? 'de' : 'en';
	}
}

export function t(key: string): string {
	return translations[key]?.[current] ?? key;
}
