export type Locale = 'de' | 'en';

let current: Locale = 'de';

const translations: Record<string, Record<Locale, string>> = {
	// Nav
	'nav.chat': { de: 'Chat', en: 'Chat' },
	'nav.knowledge': { de: 'Knowledge', en: 'Knowledge' },
	'nav.history': { de: 'History', en: 'History' },
	'nav.settings': { de: 'Settings', en: 'Settings' },
	'nav.new_chat': { de: '+ Neuer Chat', en: '+ New Chat' },

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
	'chat.attach_file': { de: 'Datei anhaengen', en: 'Attach file' },
	'chat.voice_input': { de: 'Spracheingabe', en: 'Voice input' },
	'chat.thinking_label': { de: 'Thinking', en: 'Thinking' },

	// Onboarding (kept for web-ui setup hints)
	'onboard.welcome': { de: 'Willkommen bei lynox', en: 'Welcome to lynox' },
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

	// Config
	'config.title': { de: 'Konfiguration', en: 'Configuration' },
	'config.model': { de: 'Modell', en: 'Model' },
	'config.model_haiku': { de: 'Haiku (schnell, guenstig)', en: 'Haiku (fast, affordable)' },
	'config.model_sonnet': { de: 'Sonnet (balanciert)', en: 'Sonnet (balanced)' },
	'config.model_opus': { de: 'Opus (staerkstes Modell)', en: 'Opus (most capable)' },
	'config.effort': { de: 'Effort Level', en: 'Effort Level' },
	'config.thinking': { de: 'Thinking Mode', en: 'Thinking Mode' },
	'config.thinking_disabled': { de: 'Deaktiviert', en: 'Disabled' },
	'config.thinking_adaptive': { de: 'Adaptiv (empfohlen)', en: 'Adaptive (recommended)' },
	'config.memory_extraction': { de: 'Memory Extraction', en: 'Memory Extraction' },
	'config.memory_extraction_desc': { de: 'Agent lernt automatisch aus Gespraechen', en: 'Agent learns automatically from conversations' },

	// Keys
	'keys.title': { de: 'API Keys', en: 'API Keys' },
	'keys.no_keys': { de: 'Keine API Keys gespeichert.', en: 'No API keys stored.' },
	'keys.add_title': { de: 'Neuen Key hinzufuegen', en: 'Add new key' },
	'keys.name_label': { de: 'Name', en: 'Name' },
	'keys.value_label': { de: 'Wert', en: 'Value' },

	// Tasks
	'tasks.title': { de: 'Scheduled Tasks', en: 'Scheduled Tasks' },
	'tasks.no_tasks': { de: 'Keine Tasks.', en: 'No tasks.' },
	'tasks.create_title': { de: 'Neuen Task erstellen', en: 'Create new task' },
	'tasks.description_placeholder': { de: 'Task-Beschreibung', en: 'Task description' },
	'tasks.cron_placeholder': { de: 'Cron (optional, z.B. 0 9 * * 1)', en: 'Cron (optional, e.g. 0 9 * * 1)' },
	'tasks.create': { de: 'Erstellen', en: 'Create' },

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
	'integrations.telegram_saved': { de: 'Gespeichert. Bot wird beim naechsten Engine-Start aktiv.', en: 'Saved. Bot will be active on next engine start.' },

	// Web Search
	'integrations.search': { de: 'Web Search', en: 'Web Search' },
	'integrations.search_desc': { de: 'Webrecherche fuer den Agent', en: 'Web research for the agent' },
	'integrations.search_key_hint': { de: 'Gratis-Key auf', en: 'Free key at' },
	'integrations.search_configured': { de: 'Konfiguriert', en: 'Configured' },
	'integrations.search_not_configured': { de: 'Nicht konfiguriert', en: 'Not configured' },
	'integrations.search_saved': { de: 'Key gespeichert. Engine wird neu gestartet...', en: 'Key saved. Restarting engine...' },

	// Memory
	'memory.title': { de: 'Knowledge', en: 'Knowledge' },
	'memory.no_entries': { de: 'Keine Eintraege in', en: 'No entries in' },
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
	'history.no_runs': { de: 'Noch keine Runs.', en: 'No runs yet.' },
	'history.tool_calls': { de: 'Tool Calls', en: 'Tool Calls' },
	'history.response': { de: 'Antwort', en: 'Response' },

	// Error page
	'error.fallback': { de: 'Etwas ist schiefgelaufen.', en: 'Something went wrong.' },

	// Common
	'common.loading': { de: 'Laden...', en: 'Loading...' },
	'common.back_to_chat': { de: 'Zurueck zum Chat', en: 'Back to chat' },
	'common.error': { de: 'Etwas ist schiefgelaufen.', en: 'Something went wrong.' },
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
