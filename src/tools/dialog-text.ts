/**
 * The engine's own sentences in a confirmation dialog, in each language a dialog can take.
 *
 * The language is decided once, where the question is posed, by the instance's notice
 * language (`noticeLanguage`, the rule the engine's other owner-facing texts follow), and
 * frozen into the text that is shown, stored and pushed. Only the shown text is translated:
 * the warning the audit and the `[BLOCKED` checks read stays English, so its readers do not
 * depend on the language. `[BLOCKED` itself is the same in every language; the reason after
 * it is translated.
 *
 * Values (paths, commands, hosts, names) are never translated: they are what the agent or
 * the person wrote.
 */

import type { NoticeLanguage } from '../core/notice-language.js';

/** The language a confirmation dialog is asked in. */
export type DialogLanguage = NoticeLanguage;

/** The guard's fixed sentence parts (`_detectDanger`). */
export interface GuardText {
  readonly runManually: string;
  readonly systemFiles: string;
  readonly readSensitive: string;
  readonly writeSensitive: string;
  readonly overwriteEmpty: string;
  readonly overwriteFileEmpty: string;
  readonly writeOutsideProject: string;
  readonly onlyWithinProject: string;
  readonly sensitiveDirectory: string;
  readonly moveIntoSensitive: string;
  readonly moveFilesIntoSensitive: string;
  readonly moveOutsideProject: string;
  readonly mailNeedsOk: string;
  readonly connectsMailbox: string;
  readonly sendsMail: string;
  readonly dataNeedsOk: string;
  readonly needOk: string;
  readonly destroysData: string;
  readonly modifiesExternal: string;
  readonly destructiveOperation: string;
  readonly writeNeedsOk: string;
  readonly suspiciousSpawn: (patterns: string) => string;
}

export const GUARD_TEXT: Readonly<Record<DialogLanguage, GuardText>> = {
  en: {
    runManually: 'this action needs to be run manually for safety',
    systemFiles: 'this path contains system or security files',
    readSensitive: 'read sensitive path',
    writeSensitive: 'write to sensitive path',
    overwriteEmpty: 'overwrite with empty content',
    overwriteFileEmpty: 'overwrite file with empty content',
    writeOutsideProject: 'write outside project directory',
    onlyWithinProject: 'I can only write files within the current project',
    sensitiveDirectory: 'operate in sensitive directory',
    moveIntoSensitive: 'move into sensitive path',
    moveFilesIntoSensitive: 'move files into sensitive path',
    moveOutsideProject: 'move destination outside project',
    mailNeedsOk: 'connecting/sending mail needs your OK',
    connectsMailbox: 'connects a mailbox',
    sendsMail: 'sends external mail',
    dataNeedsOk: 'destructive data operation needs your OK',
    needOk: 'I need your OK before doing this',
    destroysData: 'destroys stored data',
    modifiesExternal: 'modifies external data',
    destructiveOperation: 'destructive operation',
    writeNeedsOk: 'write operation, needs your OK',
    suspiciousSpawn: (patterns) => `spawn task contains suspicious patterns (${patterns}). Review needed.`,
  },
  de: {
    runManually: 'diese Aktion musst du aus Sicherheitsgründen selbst ausführen',
    systemFiles: 'dieser Pfad enthält System- oder Sicherheitsdateien',
    readSensitive: 'geschützten Pfad lesen',
    writeSensitive: 'in geschützten Pfad schreiben',
    overwriteEmpty: 'mit leerem Inhalt überschreiben',
    overwriteFileEmpty: 'Datei mit leerem Inhalt überschreiben',
    writeOutsideProject: 'ausserhalb des Projektordners schreiben',
    onlyWithinProject: 'ich kann nur Dateien im aktuellen Projekt schreiben',
    sensitiveDirectory: 'in geschütztem Ordner arbeiten',
    moveIntoSensitive: 'in geschützten Pfad verschieben',
    moveFilesIntoSensitive: 'Dateien in geschützten Pfad verschieben',
    moveOutsideProject: 'Ziel des Verschiebens liegt ausserhalb des Projekts',
    mailNeedsOk: 'Postfach verbinden oder Mail senden braucht dein OK',
    connectsMailbox: 'verbindet ein Postfach',
    sendsMail: 'sendet eine Mail nach aussen',
    dataNeedsOk: 'das Löschen gespeicherter Daten braucht dein OK',
    needOk: 'dafür brauche ich dein OK',
    destroysData: 'löscht gespeicherte Daten',
    modifiesExternal: 'ändert Daten ausserhalb von lynox',
    destructiveOperation: 'zerstörende Aktion',
    writeNeedsOk: 'schreibende Anfrage, braucht dein OK',
    suspiciousSpawn: (patterns) => `der Auftrag an die Teilaufgabe enthält verdächtige Muster (${patterns}). Bitte prüfen.`,
  },
};

/**
 * The German for every label of the guard's command and path rules, keyed by the English
 * label. A test holds every label of the guard to an entry here.
 */
export const RULE_LABELS_DE: Readonly<Record<string, string>> = {
  'AWS CLI': 'AWS CLI',
  'Azure CLI': 'Azure CLI',
  'Google Cloud CLI': 'Google Cloud CLI',
  'HTTP data submission via curl': 'Daten per curl senden (HTTP)',
  'HTTP mutation via curl': 'schreibende HTTP-Anfrage per curl',
  'HTTP mutation via wget': 'schreibende HTTP-Anfrage per wget',
  'SQL DELETE without WHERE (full table wipe)': 'SQL DELETE ohne WHERE (leert die ganze Tabelle)',
  'SQL DROP (irreversible data destruction)': 'SQL DROP (löscht Daten unwiderruflich)',
  'SQL TRUNCATE (irreversible data destruction)': 'SQL TRUNCATE (löscht Daten unwiderruflich)',
  'access lynox engine database (use the built-in tools instead)': 'Zugriff auf die Datenbank von lynox (nutze stattdessen die eingebauten Werkzeuge)',
  'access lynox secret store (secrets)': 'Zugriff auf den Geheimnisspeicher von lynox (Geheimnisse)',
  'ansible (modifies remote systems)': 'ansible (ändert entfernte Systeme)',
  'ansible (remote configuration)': 'ansible (Konfiguration entfernter Systeme)',
  'base64 decode piped to shell': 'base64-Dekodierung an Shell weitergeleitet',
  'bash -c (explicit subshell)': 'bash -c (eigene Subshell)',
  'bash built-in networking (/dev/tcp)': 'Netzwerkzugriff über bash (/dev/tcp)',
  'bun code execution': 'Code-Ausführung mit bun',
  'change ownership': 'Eigentümer ändern',
  'change permissions': 'Berechtigungen ändern',
  'chroot escape': 'Ausbruch aus chroot',
  'container execution': 'Ausführung in Container',
  'covert channel (openssl s_client)': 'verdeckter Kanal (openssl s_client)',
  'create symlink': 'symbolischen Link anlegen',
  'database CLI': 'Datenbank-CLI',
  'database dump/restore (data exfiltration risk)': 'Datenbank exportieren/wiederherstellen (Gefahr des Datenabflusses)',
  'delete branch': 'Branch löschen',
  'deno code execution': 'Code-Ausführung mit deno',
  'deploy platform CLI': 'CLI einer Deploy-Plattform',
  'destructive API call (HTTP DELETE)': 'zerstörender API-Aufruf (HTTP DELETE)',
  'discard stashed changes': 'gestashte Änderungen verwerfen',
  'discard uncommitted changes': 'nicht committete Änderungen verwerfen',
  'disk dump': 'Abbild eines Datenträgers',
  'docker cleanup': 'docker aufräumen',
  'docker compose': 'docker compose',
  'docker compose (service lifecycle)': 'docker compose (Dienste starten/stoppen)',
  'docker push': 'docker push',
  'docker push (publishes image)': 'docker push (veröffentlicht ein Image)',
  'dump all variables (secrets)': 'alle Variablen ausgeben (Geheimnisse)',
  'dump environment (secrets)': 'Umgebung ausgeben (Geheimnisse)',
  'dump exported vars (secrets)': 'exportierte Variablen ausgeben (Geheimnisse)',
  'echo piped to shell': 'echo an Shell weitergeleitet',
  'echo secret variable': 'geheime Variable ausgeben',
  'elevated privileges': 'erhöhte Rechte',
  'eval (arbitrary code execution)': 'eval (beliebiger Code)',
  'execute npm package (arbitrary code)': 'npm-Paket ausführen (beliebiger Code)',
  'file exfiltration (curl upload)': 'Datei nach aussen senden (curl-Upload)',
  'file upload via curl form (data exfiltration)': 'Datei-Upload per curl-Formular (Datenabfluss)',
  'force push': 'force push',
  'force push main': 'force push auf main',
  'format disk': 'Datenträger formatieren',
  'git cherry-pick': 'git cherry-pick',
  'git cherry-pick (modifies branch history)': 'git cherry-pick (ändert die Branch-Historie)',
  'git clean (deletes untracked files)': 'git clean (löscht nicht erfasste Dateien)',
  'git commit (requires explicit user request)': 'git commit (nur auf ausdrücklichen Wunsch)',
  'git merge': 'git merge',
  'git merge (modifies branch history)': 'git merge (ändert die Branch-Historie)',
  'git push (requires explicit user request)': 'git push (nur auf ausdrücklichen Wunsch)',
  'git rebase': 'git rebase',
  'git rebase (rewrites history)': 'git rebase (schreibt die Historie um)',
  'git restore (discard changes)': 'git restore (verwirft Änderungen)',
  'git revert': 'git revert',
  'git revert (creates revert commit)': 'git revert (legt einen Revert-Commit an)',
  'glob into lynox data dir (secrets)': 'Platzhalter in den Datenordner von lynox (Geheimnisse)',
  'hard reset': 'hard reset',
  'helm (Kubernetes packages)': 'helm (Kubernetes-Pakete)',
  'helm mutation (production impact)': 'Änderung mit helm (wirkt auf Produktion)',
  'hex decode piped to shell': 'Hex-Dekodierung an Shell weitergeleitet',
  'in-place file edit via bash (use write_file instead)': 'Datei direkt per bash ändern (nutze stattdessen write_file)',
  'infrastructure change (production impact)': 'Änderung an der Infrastruktur (wirkt auf Produktion)',
  'input piped to an interpreter': 'Eingabe an einen Interpreter weitergeleitet',
  'input redirected to an interpreter': 'Eingabe an einen Interpreter umgeleitet',
  'install Go package': 'Go-Paket installieren',
  'install Python package': 'Python-Paket installieren',
  'install Ruby gem': 'Ruby-Gem installieren',
  'install Rust crate': 'Rust-Crate installieren',
  'kill all processes by name': 'alle Prozesse mit diesem Namen beenden',
  'kill process': 'Prozess beenden',
  'kill processes by name': 'Prozesse nach Namen beenden',
  'kubectl (Kubernetes)': 'kubectl (Kubernetes)',
  'kubectl mutation (production impact)': 'Änderung mit kubectl (wirkt auf Produktion)',
  'local HTTP server (data exfiltration)': 'lokaler HTTP-Server (Datenabfluss)',
  'messaging platform CLI': 'CLI einer Messaging-Plattform',
  'modify cron jobs': 'Cron-Jobs ändern',
  'modify firewall rules': 'Firewall-Regeln ändern',
  'modify users/groups': 'Benutzer/Gruppen ändern',
  'mount filesystem': 'Dateisystem einbinden',
  'namespace escape': 'Ausbruch aus dem Namespace',
  'node code execution': 'Code-Ausführung mit node',
  'outbound netcat connection': 'ausgehende netcat-Verbindung',
  'package publish': 'Paket veröffentlichen',
  'package publish (irreversible)': 'Paket veröffentlichen (nicht umkehrbar)',
  'path traversal in lynox data dir (secrets)': 'Pfadsprung in den Datenordner von lynox (Geheimnisse)',
  'payment mutation (financial impact)': 'Änderung bei Zahlungen (finanzielle Folgen)',
  'payment platform CLI': 'CLI einer Zahlungsplattform',
  'perl code execution': 'Code-Ausführung mit perl',
  'php code execution': 'Code-Ausführung mit php',
  'pipe to shell': 'an Shell weitergeleitet',
  'print environment (secrets)': 'Umgebung ausgeben (Geheimnisse)',
  'printf hex escape piped to shell': 'printf-Hex-Escape an Shell weitergeleitet',
  'pulumi (infrastructure)': 'pulumi (Infrastruktur)',
  'python code execution': 'Code-Ausführung mit python',
  'read proc filesystem': 'proc-Dateisystem lesen',
  'read process environment (secrets)': 'Umgebung eines Prozesses lesen (Geheimnisse)',
  'read secrets file': 'Datei mit Geheimnissen lesen',
  'remote file copy': 'Datei auf/von entferntem System kopieren',
  'remote file transfer': 'Dateiübertragung mit entferntem System',
  'remote shell access': 'Shell-Zugriff auf entferntes System',
  'remote sync': 'Abgleich mit entferntem System',
  'remove files': 'Dateien löschen',
  'reverse shell enabler (ncat/socat)': 'ermöglicht eine Reverse Shell (ncat/socat)',
  'rm -rf /': 'rm -rf /',
  'ruby code execution': 'Code-Ausführung mit ruby',
  'send email': 'Mail senden',
  'service management': 'Dienste verwalten',
  'service management (macOS)': 'Dienste verwalten (macOS)',
  'shell -c (inline script)': 'shell -c (Skript in der Zeile)',
  'stage all files (review before committing)': 'alle Dateien vormerken (vor dem Commit prüfen)',
  'system control': 'Systemsteuerung',
  'terraform/tofu (infrastructure)': 'terraform/tofu (Infrastruktur)',
  'webhook notification': 'Webhook-Benachrichtigung',
  'write file via bash (use write_file instead)': 'Datei per bash schreiben (nutze stattdessen write_file)',
  'write into the lynox data dir': 'in den Datenordner von lynox schreiben',
  'write to device': 'auf ein Gerät schreiben',
  'HTTP request with an option the guard cannot read (shell expansion)': 'HTTP-Anfrage mit einer Option, die lynox nicht lesen kann (Shell-Erweiterung)',
};

/** A rule's label in `language`; English as written. */
export function ruleLabel(label: string, language: DialogLanguage): string {
  if (language === 'en') return label;
  return Object.hasOwn(RULE_LABELS_DE, label) ? RULE_LABELS_DE[label]! : label;
}

/**
 * The action a built-in tool's own check names (Google Workspace writes, an unattended
 * `api_setup` delete), as words. An action without words is shown as a value.
 */
export const ACTION_WORDS: Readonly<Record<string, Readonly<Record<string, Readonly<Record<DialogLanguage, string>>>>>> = {
  google_calendar: {
    create_event: { en: 'create event', de: 'Termin anlegen' },
    update_event: { en: 'change event', de: 'Termin ändern' },
    delete_event: { en: 'delete event', de: 'Termin löschen' },
  },
  google_docs: {
    create: { en: 'create document', de: 'Dokument anlegen' },
    append: { en: 'add to document', de: 'an Dokument anhängen' },
    replace: { en: 'replace text in document', de: 'Text im Dokument ersetzen' },
  },
  google_drive: {
    upload: { en: 'upload file', de: 'Datei hochladen' },
    create_doc: { en: 'create document', de: 'Dokument anlegen' },
    move: { en: 'move file', de: 'Datei verschieben' },
    share: { en: 'share file', de: 'Datei freigeben' },
  },
  google_sheets: {
    write: { en: 'write cells', de: 'Zellen schreiben' },
    append: { en: 'add rows', de: 'Zeilen anhängen' },
    format: { en: 'format cells', de: 'Zellen formatieren' },
  },
  api_setup: {
    delete: { en: 'delete profile', de: 'Profil löschen' },
  },
};

/** The words for `action` of `tool` in `language`, or null when it has none. */
export function actionWords(tool: string, action: string, language: DialogLanguage): string | null {
  const actions = Object.hasOwn(ACTION_WORDS, tool) ? ACTION_WORDS[tool]! : undefined;
  if (!actions || !Object.hasOwn(actions, action)) return null;
  return actions[action]![language];
}
