/**
 * The engine's own sentences in a confirmation dialog, in each language a dialog can take.
 *
 * The language is decided once, where the question is posed, by the instance's notice
 * language (`noticeLanguage`, the rule the engine's other owner-facing texts follow), and
 * frozen into the text that is shown, stored and pushed. Only the shown text is translated:
 * the warning the audit and the `[BLOCKED` checks read stays English, so its readers do not
 * depend on the language. The shown marker is said in the language too (`[GESPERRT` in German);
 * nothing reads it from the shown text.
 *
 * Values (paths, commands, hosts, names) are never translated: they are what the agent or
 * the person wrote.
 */

import type { ConsentKey } from '../contract/prompt.js';
import type { NoticeLanguage } from '../core/notice-language.js';
import type { SendRoleKind, SendSlot } from '../core/profile-secret-view.js';
import { pv } from '../core/prompt-value.js';
import type { PromptText } from '../types/agent.js';

/** The language a confirmation dialog is asked in. */
export type DialogLanguage = NoticeLanguage;

/** The guard's fixed sentence parts (`_detectDanger`). */
export interface GuardText {
  /** The marker of an action lynox does not run: it stays in square brackets in every language. */
  readonly blocked: string;
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
    blocked: 'BLOCKED',
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
    blocked: 'GESPERRT',
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
  'HTTP request with an option the guard cannot read (shell expansion)': 'HTTP-Anfrage mit einer Option, die lynox nicht prüfen kann (Shell-Erweiterung)',
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
    delete: { en: 'delete connection', de: 'Verbindung löschen' },
  },
};

/** The words for `action` of `tool` in `language`, or null when it has none. */
export function actionWords(tool: string, action: string, language: DialogLanguage): string | null {
  const actions = Object.hasOwn(ACTION_WORDS, tool) ? ACTION_WORDS[tool]! : undefined;
  if (!actions || !Object.hasOwn(actions, action)) return null;
  return actions[action]![language];
}

/** The two warnings of `http_request`'s GET exfiltration check, in German, keyed by the English. */
const EXFIL_WARNINGS_DE: Readonly<Record<string, string>> = {
  'suspiciously long query string (>500 chars, possible data exfiltration)': 'auffällig lange Query (über 500 Zeichen, möglicher Datenabfluss)',
  'base64-like data in URL parameters (possible data exfiltration)': 'base64-artige Daten in URL-Parametern (möglicher Datenabfluss)',
};

/** An exfiltration warning of `http_request` in `language`; English as written. */
export function exfilWarning(warning: string, language: DialogLanguage): string {
  if (language === 'en') return warning;
  return Object.hasOwn(EXFIL_WARNINGS_DE, warning) ? EXFIL_WARNINGS_DE[warning]! : warning;
}

/**
 * `http_request`'s own questions. Every `${…}` a template here interpolates is a value, as in
 * any `pv`; a nested `PromptText` keeps its own segments.
 */
export interface HttpDialog {
  readonly exfil: (word: PromptText, warning: string) => PromptText;
  readonly outbound: (word: PromptText, method: string, host: string, path: string, fields: string, tail: PromptText) => PromptText;
  readonly queryTooLarge: (bytes: number) => PromptText;
  readonly querySecret: PromptText;
  readonly headers: (names: string, block: PromptText) => PromptText;
  readonly bodySecret: PromptText;
  readonly bodyTooLarge: (bytes: number) => PromptText;
  readonly noteOnce: PromptText;
  readonly noteTwins: (twins: string) => PromptText;
  readonly noteEffect: PromptText;
  readonly noteDelete: PromptText;
  readonly noteConnected: PromptText;
  readonly noteSession: PromptText;
  readonly sentNote: (method: string, names: string) => PromptText;
}

export const HTTP_DIALOG: Readonly<Record<DialogLanguage, HttpDialog>> = {
  en: {
    exfil: (word, warning) => pv`⚠ ${word}: ${warning} — Allow?`,
    outbound: (word, method, host, path, fields, tail) => pv`⚠ ${word}: ${method} to ${host} ${path} (${fields}) — Allow outbound data?${tail}`,
    queryTooLarge: (bytes) => pv` The query (${bytes} bytes) is too large to show; the path above names its keys, cut short where it is long.`,
    querySecret: pv` A stored secret is sent in this query; it is shown masked (***).`,
    headers: (names, block) => pv` It sets the headers ${names}.${block}`,
    bodySecret: pv` The body holds a stored secret and is not shown.`,
    bodyTooLarge: (bytes) => pv` The body (${bytes} bytes) is too large to show; its field names are listed.`,
    noteOnce: pv` Allowing sends this request once, now; it will ask again next time.`,
    noteTwins: (twins) => pv` This step makes the same request ${twins} times; allowing sends all ${twins} now, and it will ask again next time.`,
    noteEffect: pv` This sends or issues something and is asked every time.`,
    noteDelete: pv` A DELETE is asked every time.`,
    noteConnected: pv` A write to a connected account is asked every time.`,
    noteSession: pv` In this session every write is asked.`,
    sentNote: (method, names) => pv` It is sent as a ${method} that also names ${names}; a server may run any of these.`,
  },
  de: {
    exfil: (word, warning) => pv`⚠ ${word}: ${warning} — Erlauben?`,
    outbound: (word, method, host, path, fields, tail) => pv`⚠ ${word}: ${method} an ${host} ${path} (${fields}) — Daten nach aussen senden?${tail}`,
    queryTooLarge: (bytes) => pv` Die Query (${bytes} Bytes) ist zu gross zum Anzeigen; der Pfad oben nennt ihre Schlüssel, lange gekürzt.`,
    querySecret: pv` In dieser Query steht ein gespeichertes Geheimnis; es ist maskiert (***).`,
    headers: (names, block) => pv` Sie setzt die Header ${names}.${block}`,
    bodySecret: pv` Der Body enthält ein gespeichertes Geheimnis und wird nicht angezeigt.`,
    bodyTooLarge: (bytes) => pv` Der Body (${bytes} Bytes) ist zu gross zum Anzeigen; seine Feldnamen sind aufgeführt.`,
    noteOnce: pv` Erlauben sendet diese Anfrage einmal, jetzt; beim nächsten Mal fragt lynox wieder.`,
    noteTwins: (twins) => pv` Dieser Schritt macht dieselbe Anfrage ${twins}-mal; Erlauben sendet jetzt alle ${twins}, beim nächsten Mal fragt lynox wieder.`,
    noteEffect: pv` Das sendet oder veranlasst etwas, darum fragt lynox jedes Mal.`,
    noteDelete: pv` Bei DELETE fragt lynox jedes Mal.`,
    noteConnected: pv` Beim Schreiben in ein verbundenes Konto fragt lynox jedes Mal.`,
    noteSession: pv` In dieser Sitzung fragt lynox bei jedem Schreiben.`,
    sentNote: (method, names) => pv` Sie geht als ${method} hinaus und nennt dabei auch ${names}; ein Server kann jede davon ausführen.`,
  },
};

/** `spawn_agent`'s deep-tier consent, in each language. */
export interface SpawnDialog {
  readonly children: (count: number) => string;
  readonly tierUnknownBand: string;
  readonly tierDeep: string;
  readonly tailDowngrade: string;
  readonly tailPinned: string;
  readonly sentence: (word: string, children: string, tier: string, costUsd: string, providers: string, tail: string) => string;
}

export const SPAWN_DIALOG: Readonly<Record<DialogLanguage, SpawnDialog>> = {
  en: {
    children: (count) => count === 1 ? 'One child would run' : `${count} children would run`,
    tierUnknownBand: 'a model gated as DEEP (or an unregistered custom model whose cost band the engine cannot prove)',
    tierDeep: 'the DEEP tier (a stronger reasoning model, more capable but more expensive)',
    tailDowngrade: 'Allow only if the work genuinely needs deep; otherwise choose "Run on balanced".',
    tailPinned: 'A model profile pins a specific endpoint and cannot be substituted down — allow only if you want this run on that model.',
    sentence: (word, children, tier, costUsd, providers, tail) => `⚠ ${word}: ${children} on ${tier}. Estimated cost ~$${costUsd} against this session. Provider: ${providers}. ${tail}`,
  },
  de: {
    children: (count) => count === 1 ? 'Eine Teilaufgabe würde' : `${count} Teilaufgaben würden`,
    tierUnknownBand: 'einem Modell der Stufe Tief (oder einem nicht registrierten eigenen Modell, dessen Kostenrahmen lynox nicht belegen kann)',
    tierDeep: 'der Stufe Tief (ein stärkeres Denkmodell, leistungsfähiger, aber teurer)',
    tailDowngrade: 'Erlaube das nur, wenn die Arbeit wirklich die Stufe Tief braucht; sonst wähle „Mit Ausgewogen ausführen“.',
    tailPinned: 'Ein Modellprofil legt einen bestimmten Endpunkt fest und lässt sich nicht herabstufen. Erlaube das nur, wenn dieser Lauf auf diesem Modell laufen soll.',
    sentence: (word, children, tier, costUsd, providers, tail) => `⚠ ${word}: ${children} auf ${tier} laufen. Geschätzte Kosten ~$${costUsd} für diese Sitzung. Anbieter: ${providers}. ${tail}`,
  },
};

/** The question before a tool call uses a stored secret for the first time. */
export interface SecretDialog {
  readonly inInput: (tool: PromptText, names: string, shown: string) => PromptText;
  readonly plain: (tool: PromptText, names: string) => PromptText;
}

export const SECRET_DIALOG: Readonly<Record<DialogLanguage, SecretDialog>> = {
  en: {
    inInput: (tool, names, shown) => pv`${tool} wants to use secret(s) ${names} in: ${shown} — Allow?`,
    plain: (tool, names) => pv`${tool} wants to use secret(s): ${names}. Allow?`,
  },
  de: {
    inInput: (tool, names, shown) => pv`${tool} möchte diese Geheimnisse verwenden: ${names}, in: ${shown} — Erlauben?`,
    plain: (tool, names) => pv`${tool} möchte diese Geheimnisse verwenden: ${names}. Erlauben?`,
  },
};

/**
 * The question before a vault secret may go to more addresses than it is bound to. `name`, `bound`
 * and `added` are values (the vault name and the addresses); `bound` empty: the secret is bound to
 * no address yet. Customer-visible copy; the English is the text the business owner approved.
 */
export interface BindingDialog {
  readonly question: (name: string, bound: readonly string[], added: readonly string[]) => PromptText;
}

export const BINDING_DIALOG: Readonly<Record<DialogLanguage, BindingDialog>> = {
  en: {
    question: (name, bound, added) => bound.length === 0
      ? pv`${name} is stored in your vault and is not yet limited to any address.\n\nThis connection would send it to: ${added.join(', ')}.\n\nAllow ${name} to be sent there? From then on it goes only to the addresses you have allowed.`
      : pv`${name} is sent only to: ${bound.join(', ')}.\n\nThis connection would also send it to: ${added.join(', ')}.\n\nAllow ${name} to be sent there as well?`,
  },
  de: {
    question: (name, bound, added) => bound.length === 0
      ? pv`${name} liegt in deinem Vault und ist noch an keine Adresse gebunden.\n\nDiese Verbindung würde den Wert senden an: ${added.join(', ')}.\n\nDarf ${name} dorthin gesendet werden? Danach geht der Wert nur noch an die Adressen, die du erlaubt hast.`
      : pv`${name} wird nur gesendet an: ${bound.join(', ')}.\n\nDiese Verbindung würde den Wert auch senden an: ${added.join(', ')}.\n\nDarf ${name} auch dorthin gesendet werden?`,
  },
};

/** Why `api_setup` could not name a provider's sign-in address, in each language. */
export interface PresetNote {
  readonly unknownProvider: (known: string) => string;
  readonly noProviders: string;
  readonly badPreset: (id: string, detail: string) => string;
  readonly missingParam: (id: string, describe: string, name: string) => string;
  readonly refusedParam: (id: string, describe: string, name: string) => string;
}

export const PRESET_NOTE: Readonly<Record<DialogLanguage, PresetNote>> = {
  en: {
    unknownProvider: (known) => `No authorization address could be derived: this connection names a provider this engine does not have built in, so there is nothing here to disclose or accept. It knows: ${known}.`,
    noProviders: 'No authorization address could be derived: this engine has no built-in providers yet, so there is nothing here to disclose or accept.',
    badPreset: (id, detail) => `No authorization address could be derived: the built-in provider "${id}" is defined wrongly in this engine — ${detail}. Nothing on this connection fixes that; report it.`,
    missingParam: (id, describe, name) => `No authorization address could be derived: the provider "${id}" needs ${describe} (auth.oauth.preset_params.${name}), which this connection does not supply. Set it with api_setup update — the host is disclosed then.`,
    refusedParam: (id, describe, name) => `No authorization address could be derived: the value this connection supplies for ${describe} (auth.oauth.preset_params.${name}) is not one the provider "${id}" accepts. Correct it with api_setup update — the host is disclosed then.`,
  },
  de: {
    unknownProvider: (known) => `Es liess sich keine Anmeldeadresse ableiten: Diese Verbindung nennt einen Anbieter, den lynox nicht eingebaut hat, daher gibt es hier nichts offenzulegen oder anzunehmen. Eingebaut sind: ${known}.`,
    noProviders: 'Es liess sich keine Anmeldeadresse ableiten: lynox hat noch keine eingebauten Anbieter, daher gibt es hier nichts offenzulegen oder anzunehmen.',
    badPreset: (id, detail) => `Es liess sich keine Anmeldeadresse ableiten: Der eingebaute Anbieter "${id}" ist in lynox falsch definiert — ${detail}. An dieser Verbindung lässt sich das nicht beheben; melde es.`,
    missingParam: (id, describe, name) => `Es liess sich keine Anmeldeadresse ableiten: Der Anbieter "${id}" braucht ${describe} (auth.oauth.preset_params.${name}), und diese Verbindung gibt es nicht an. Setze es mit api_setup update — dann wird der Host offengelegt.`,
    refusedParam: (id, describe, name) => `Es liess sich keine Anmeldeadresse ableiten: Der Wert, den diese Verbindung für ${describe} (auth.oauth.preset_params.${name}) angibt, ist keiner, den der Anbieter "${id}" annimmt. Korrigiere ihn mit api_setup update — dann wird der Host offengelegt.`,
  },
};

/** The German for a provider parameter's description (`OAuthPresetParam.describe`), keyed by the English. */
const PRESET_PARAM_DESCRIBE_DE: Readonly<Record<string, string>> = {
  'the store\'s myshopify.com subdomain, e.g. "my-store" for my-store.myshopify.com, in lower case': 'die myshopify.com-Subdomain des Stores in Kleinbuchstaben, z. B. "my-store" für my-store.myshopify.com',
};

/** A provider parameter's description in `language`; English as written. */
export function presetParamDescribe(describe: string, language: DialogLanguage): string {
  if (language === 'en') return describe;
  return Object.hasOwn(PRESET_PARAM_DESCRIBE_DE, describe) ? PRESET_PARAM_DESCRIBE_DE[describe]! : describe;
}

/** `api_setup`'s own questions. Every `${…}` is a value, as in any `pv`. */
export interface ApiSetupDialog {
  /** `changes`: what the save changes, one line each (`securityChanges`, in this language); `disclosure` may be empty. */
  readonly save: (word: PromptText, name: string, changes: readonly PromptText[], disclosure: string) => PromptText;
  readonly redirect: (hosts: string[]) => string;
  /** The sentence before the acceptance of each host outside the listed sub-processors; `disclosures` (the acceptances, English, binding text) as given. */
  readonly outsideSubProcessors: (oauth: boolean, hosts: readonly string[], disclosures: string) => string;
  readonly deleteUnreadable: (word: PromptText, id: string, source: string) => PromptText;
  readonly deleteProfile: (word: PromptText, name: string, id: string, host: string | undefined, loses: PromptText) => PromptText;
  readonly losesTokens: (tokens: number) => PromptText;
  readonly losesSettings: PromptText;
  /**
   * `trailId`: the profile's opaque id; `more`: the settings that are part of the release but not
   * printed; `viewed`: when the owner last read the settings in a chat (`clock`) and whether they are
   * unchanged since, absent when never read; `version`: the short settings version; `slots`: what the
   * value is sent as, shown in words with the slot names in brackets as the release stores them.
   */
  readonly release: (word: PromptText, p: { name: string; trailId: string; author: string; slots: readonly SendSlot[]; hosts: string[]; more: number; viewed: { clock: string; unchanged: boolean } | undefined; version: string; clientId: boolean; held: boolean }) => PromptText;
  readonly adopt: (word: PromptText, p: { name: string; id: string; by: string; known: boolean; hosts: string[]; names: string[] }) => PromptText;
}

/** At most this many vault names are listed in an adoption question; the rest are counted. */
const ADOPT_NAMES_SHOWN = 30;

/**
 * The words for each slot a vault key is released for: the release question is the consent, so it
 * says what the value becomes, not only the field that holds it. Every kind has a word in each
 * language; the slot names follow in brackets as the release stores them.
 */
const ROLE_WORDS: Readonly<Record<DialogLanguage, Readonly<Record<SendRoleKind, string>>>> = {
  en: {
    'client-id': 'the client ID',
    'client-secret': 'the client secret',
    'basic-username': 'the user name for the Basic sign-in',
    'basic-password': 'the password for the Basic sign-in',
    'bearer-token': 'the bearer token',
    'header-key': 'the API key in a request header',
  },
  de: {
    'client-id': 'Client-ID',
    'client-secret': 'Client-Secret',
    'basic-username': 'Benutzername für die Basic-Anmeldung',
    'basic-password': 'Passwort für die Basic-Anmeldung',
    'bearer-token': 'Bearer-Token',
    'header-key': 'API-Schlüssel in einem Request-Header',
  },
};

/** The role as the owner reads it: the words for each slot, then the slot names in brackets, one value. */
function roleText(language: DialogLanguage, slots: readonly SendSlot[]): string {
  const words = slots.map((s) => ROLE_WORDS[language][s.kind]).join(language === 'de' ? ' und ' : ' and ');
  return `${words} (${slots.map((s) => s.slot).join('+')})`;
}

export const API_SETUP_DIALOG: Readonly<Record<DialogLanguage, ApiSetupDialog>> = {
  en: {
    save: (word, name, changes, disclosure) => {
      const changeList = changes.reduce<PromptText | undefined>((acc, c) => acc === undefined ? pv`\n- ${c}` : pv`${acc}\n- ${c}`, undefined);
      const changeBlock = changeList === undefined ? pv`` : pv`This save changes:${changeList}\n\n`;
      const disclosureBlock = disclosure === '' ? pv`` : pv`${disclosure}\n\n`;
      return pv`⚠ ${word}: saving "${name}" needs your acceptance.\n\n${changeBlock}${disclosureBlock}Accept and save this connection?`;
    },
    outsideSubProcessors: (oauth, _hosts, disclosures) => `This engine will send data${oauth ? ' — and, for its OAuth token, the managed access_token —' : ''} to host(s) outside lynox's listed sub-processors:\n\n${disclosures}`,
    redirect: (hosts) => `You will be sent to ${hosts.join(' and ')} in your own browser to authorize this connection. You sign in there, to that provider — not to lynox — and what comes back is stored here for this connection.`,
    deleteUnreadable: (word, id, source) => pv`⚠ ${word}: delete the stored API connection ${id}, which could not be read (${source})? Every vault name it carries is free for other connections once it is gone. Delete it?`,
    deleteProfile: (word, name, id, host, loses) => pv`⚠ ${word}: delete the API connection ${name} (id ${id}${host ? pv`, host ${host}` : pv``})?${loses} Delete it?`,
    losesTokens: (tokens) => pv` The ${tokens} token(s) its sign-in stored are removed from the vault with it, also where another connection reads them, which then has to be authorized again.`,
    losesSettings: pv` Its settings (endpoints, guidelines, sign-in method) are removed.`,
    release: (word, p) => {
      const moreSentence = p.more === 0 ? ''
        : p.more === 1
          ? pv` 1 more setting of this connection (such as its auth type, scopes, path or query) is part of the release too; a change to it ends it. To see it first, deny, ask here to view API connection ${p.trailId}, then ask to release ${p.name} again.`
          : pv` ${String(p.more)} more settings of this connection (such as its auth type, scopes, path or query) are part of the release too; a change to any of them ends it. To see them first, deny, ask here to view API connection ${p.trailId}, then ask to release ${p.name} again.`;
      const versionSentence = p.viewed === undefined ? ''
        : p.viewed.unchanged
          ? pv` These settings were last read in one of your chats at ${p.viewed.clock} and have not changed since (version ${p.version}).`
          : pv` These settings changed after they were last read in one of your chats at ${p.viewed.clock}; deny and view the connection again before you allow it (version ${p.version}).`;
      const clientIdSentence = p.clientId ? pv` A client ID also goes into the sign-in link, to the browser of whoever opens it.` : '';
      return pv`⚠ ${word}: release the vault key ${p.name} to API connection ${p.trailId}? It was set up in the session of ${p.author}. If you allow it, lynox sends the value of ${p.name}, as ${roleText('en', p.slots)}, to ${p.hosts.length > 0 ? p.hosts.join(', ') : 'no host it can name'}, with every request and run through this connection, your own and bulk runs included, until that mandate ends or you withdraw the release.${moreSentence}${versionSentence}${clientIdSentence} The vault ${p.held ? 'holds a value' : 'holds no value yet'} under this name. Any change to where the value goes ends the release. Release it?`;
    },
    adopt: (word, p) => {
      const shown = p.names.slice(0, ADOPT_NAMES_SHOWN).join(', ') + (p.names.length > ADOPT_NAMES_SHOWN ? ` and ${String(p.names.length - ADOPT_NAMES_SHOWN)} more` : '');
      return pv`⚠ ${word}: adopt the sign-in of API connection ${p.name} (id ${p.id})? It was authorized at the provider in the session of ${p.by}, ${p.known ? 'which is not active' : 'and this engine cannot tell whether that mandate is still active'}. Once adopted, the connection is yours. The engine then sends to ${p.hosts.length > 0 ? p.hosts.join(', ') : 'no host it can name'}, for your requests and runs, the sign-in's tokens and the vault names this connection names, read like any of your connections, values from the environment included: ${shown.length > 0 ? shown : 'none'}. Adopt it?`;
    },
  },
  de: {
    save: (word, name, changes, disclosure) => {
      const changeList = changes.reduce<PromptText | undefined>((acc, c) => acc === undefined ? pv`\n- ${c}` : pv`${acc}\n- ${c}`, undefined);
      const changeBlock = changeList === undefined ? pv`` : pv`Das Speichern ändert:${changeList}\n\n`;
      const disclosureBlock = disclosure === '' ? pv`` : pv`${disclosure}\n\n`;
      return pv`⚠ ${word}: Zum Speichern von „${name}“ braucht es deine Zustimmung.\n\n${changeBlock}${disclosureBlock}Diese Verbindung annehmen und speichern?`;
    },
    outsideSubProcessors: (oauth, hosts, disclosures) => `lynox sendet Daten${oauth ? ' – und für das OAuth-Token das verwaltete access_token –' : ''} an Hosts ausserhalb der aufgeführten Unterauftragsverarbeiter von lynox: ${hosts.join(', ')}.\n\n${disclosures}`,
    redirect: (hosts) => `Zur Freigabe dieser Verbindung öffnet sich ${hosts.join(' und ')} in deinem eigenen Browser. Du meldest dich dort beim Anbieter an, nicht bei lynox, und was zurückkommt, wird hier für diese Verbindung gespeichert.`,
    deleteUnreadable: (word, id, source) => pv`⚠ ${word}: die gespeicherte API-Verbindung ${id} löschen, die sich nicht lesen liess (${source})? Jeder Vault-Name darin ist danach für andere Verbindungen frei. Löschen?`,
    deleteProfile: (word, name, id, host, loses) => pv`⚠ ${word}: die API-Verbindung ${name} löschen (Id ${id}${host ? pv`, Host ${host}` : pv``})?${loses} Löschen?`,
    losesTokens: (tokens) => tokens === 1
      ? pv` Das Token, das ihre Anmeldung gespeichert hat, wird mit ihr aus dem Vault entfernt, auch dort, wo eine andere Verbindung es liest; diese muss dann neu autorisiert werden.`
      : pv` Die ${tokens} Tokens, die ihre Anmeldung gespeichert hat, werden mit ihr aus dem Vault entfernt, auch dort, wo eine andere Verbindung sie liest; diese muss dann neu autorisiert werden.`,
    losesSettings: pv` Die Einstellungen der Verbindung (Endpunkte, Richtlinien, Anmeldeart) werden entfernt.`,
    release: (word, p) => {
      const moreSentence = p.more === 0 ? ''
        : p.more === 1
          ? pv` 1 weitere Einstellung dieser Verbindung (etwa Anmeldeart, Scopes, Pfad oder Query) gehört ebenfalls zur Freigabe; eine Änderung daran beendet sie. Um sie zuerst anzusehen, lehne ab, bitte hier darum, die API-Verbindung ${p.trailId} anzuzeigen, und bitte dann erneut darum, ${p.name} freizugeben.`
          : pv` ${String(p.more)} weitere Einstellungen dieser Verbindung (etwa Anmeldeart, Scopes, Pfad oder Query) gehören ebenfalls zur Freigabe; eine Änderung an einer davon beendet sie. Um sie zuerst anzusehen, lehne ab, bitte hier darum, die API-Verbindung ${p.trailId} anzuzeigen, und bitte dann erneut darum, ${p.name} freizugeben.`;
      const versionSentence = p.viewed === undefined ? ''
        : p.viewed.unchanged
          ? pv` Diese Einstellungen wurden zuletzt um ${p.viewed.clock} in einem deiner Chats gelesen und haben sich seither nicht geändert (Version ${p.version}).`
          : pv` Diese Einstellungen haben sich geändert, nachdem sie zuletzt um ${p.viewed.clock} in einem deiner Chats gelesen wurden; lehne ab und sieh dir die Verbindung erneut an, bevor du zustimmst (Version ${p.version}).`;
      const clientIdSentence = p.clientId ? pv` Eine Client-ID steht ausserdem im Anmeldelink und geht an den Browser dessen, der ihn öffnet.` : '';
      return pv`⚠ ${word}: Den Vault-Schlüssel ${p.name} für die API-Verbindung ${p.trailId} freigeben? Sie wurde in der Sitzung von ${p.author} eingerichtet. Wenn du zustimmst, sendet lynox den Wert von ${p.name} als ${roleText('de', p.slots)} an ${p.hosts.length > 0 ? p.hosts.join(', ') : 'keinen Host, den lynox benennen kann'}, bei jeder Anfrage und jedem Lauf über diese Verbindung, auch bei deinen eigenen Läufen und bei Massenläufen, bis dieser Zugang endet oder du die Freigabe zurückziehst.${moreSentence}${versionSentence}${clientIdSentence} Unter diesem Namen ${p.held ? 'liegt im Vault ein Wert' : 'liegt im Vault noch kein Wert'}. Jede Änderung daran, wohin der Wert geht, beendet die Freigabe. Freigeben?`;
    },
    adopt: (word, p) => {
      const shown = p.names.slice(0, ADOPT_NAMES_SHOWN).join(', ') + (p.names.length > ADOPT_NAMES_SHOWN ? ` und ${String(p.names.length - ADOPT_NAMES_SHOWN)} weitere` : '');
      return pv`⚠ ${word}: Die Anmeldung der API-Verbindung ${p.name} (Id ${p.id}) übernehmen? Sie wurde beim Anbieter in der Sitzung von ${p.by} autorisiert, ${p.known ? 'deren Zugang nicht mehr aktiv ist' : 'und lynox kann nicht feststellen, ob dieser Zugang noch aktiv ist'}. Nach der Übernahme gehört die Verbindung dir. lynox sendet dann bei deinen Anfragen und Läufen an ${p.hosts.length > 0 ? p.hosts.join(', ') : 'keinen Host, den lynox benennen kann'} die Tokens der Anmeldung und die Vault-Namen, die diese Verbindung nennt. Sie werden gelesen wie bei jeder deiner Verbindungen, Werte aus der Umgebung eingeschlossen: ${shown.length > 0 ? shown : 'keine'}. Übernehmen?`;
    },
  },
};

/**
 * The words of the save question's list of changes (`securityChanges` in api-setup.ts). Every
 * `${…}` in a line is a value, as in any `pv`: a label, a profile's value, a scope. The engine
 * picks the language; nothing the model or a profile writes chooses it.
 */
export interface SecurityChangeWords {
  readonly address: string;
  readonly tokenAddress: string;
  readonly authType: string;
  readonly headerName: string;
  readonly queryParam: string;
  readonly basicFormat: string;
  readonly tokenBody: string;
  readonly secretRead: string;
  readonly secretReadNth: (n: number) => string;
  readonly secretUsername: string;
  readonly secretPassword: string;
  readonly secretBasicUsername: string;
  readonly secretBasicPassword: string;
  readonly secretClientId: string;
  readonly secretClientSecret: string;
  readonly secretRefreshToken: string;
  readonly grantType: string;
  readonly audience: string;
  readonly none: string;
  /** A value withheld because it has the shape of a credential. */
  readonly credentialShaped: string;
  readonly notAnAddress: (shown: string) => string;
  readonly originOnly: (origin: string) => string;
  readonly sendsToNoHost: (shown: string) => string;
  readonly sendsTo: (shown: string, host: string) => string;
  /** `held` scope tokens withheld, after the `shown` ones (which may be empty). */
  readonly scopesWithheld: (shown: readonly string[], held: number) => string;
  readonly line: (label: string, was: string, now: string) => PromptText;
  readonly scopesAdded: (scopes: string) => PromptText;
  readonly scopesRemoved: (scopes: string, noneLeft: boolean) => PromptText;
  readonly providerParameter: (key: string, was: string, now: string) => PromptText;
}

export const SECURITY_CHANGE_WORDS: Readonly<Record<DialogLanguage, SecurityChangeWords>> = {
  en: {
    address: 'address (base_url)',
    tokenAddress: 'token address (token_url)',
    authType: 'how the secret is attached (auth.type)',
    headerName: 'header it is sent in (auth.header_name)',
    queryParam: 'query parameter it is sent in (auth.query_param)',
    basicFormat: 'basic auth form (auth.basic_format)',
    tokenBody: 'token request body (auth.oauth.body_format)',
    secretRead: 'secret read',
    secretReadNth: (n) => `secret read (${String(n)}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'})`,
    secretUsername: 'secret read for the user name (username_key)',
    secretPassword: 'secret read for the password (password_key)',
    secretBasicUsername: 'secret read for the user name sent (basic auth)',
    secretBasicPassword: 'secret read for the password sent (basic auth)',
    secretClientId: 'secret read for the OAuth client id (oauth.client_id_key)',
    secretClientSecret: 'secret read for the OAuth client secret (oauth.client_secret_key)',
    secretRefreshToken: 'secret read for the OAuth refresh token (oauth.refresh_token_key)',
    grantType: 'grant type',
    audience: 'audience',
    none: '(none)',
    credentialShaped: '(a value shaped like a credential, not shown)',
    notAnAddress: (shown) => `${shown} (not an address a request can use)`,
    originOnly: (origin) => `${origin} (the rest is shaped like a credential, not shown)`,
    sendsToNoHost: (shown) => `${shown} (sends to no host)`,
    sendsTo: (shown, host) => `${shown} (sends to ${host})`,
    scopesWithheld: (shown, held) => {
      const count = `${String(held)} ${held === 1 ? 'value shaped like a credential' : 'values shaped like credentials'} (not shown)`;
      return shown.length === 0 ? count : `${shown.join(' ')}; plus ${count}`;
    },
    line: (label, was, now) => pv`${label}: ${was} → ${now}`,
    scopesAdded: (scopes) => pv`scopes added: ${scopes}`,
    scopesRemoved: (scopes, noneLeft) => noneLeft
      ? pv`scopes removed: ${scopes} (none left: the provider decides which it grants)`
      : pv`scopes removed: ${scopes}`,
    providerParameter: (key, was, now) => pv`provider parameter ${key}: ${was} → ${now}`,
  },
  de: {
    address: 'Adresse (base_url)',
    tokenAddress: 'Token-Adresse (token_url)',
    authType: 'wie das Secret mitgesendet wird (auth.type)',
    headerName: 'Header, in dem es gesendet wird (auth.header_name)',
    queryParam: 'Query-Parameter, in dem es gesendet wird (auth.query_param)',
    basicFormat: 'Form der Basic-Anmeldung (auth.basic_format)',
    tokenBody: 'Inhalt der Token-Anfrage (auth.oauth.body_format)',
    secretRead: 'gelesenes Secret',
    secretReadNth: (n) => `gelesenes Secret (${String(n)}.)`,
    secretUsername: 'gelesenes Secret für den Benutzernamen (username_key)',
    secretPassword: 'gelesenes Secret für das Passwort (password_key)',
    secretBasicUsername: 'gelesenes Secret für den gesendeten Benutzernamen (Basic-Anmeldung)',
    secretBasicPassword: 'gelesenes Secret für das gesendete Passwort (Basic-Anmeldung)',
    secretClientId: 'gelesenes Secret für die OAuth-Client-ID (oauth.client_id_key)',
    secretClientSecret: 'gelesenes Secret für das OAuth-Client-Secret (oauth.client_secret_key)',
    secretRefreshToken: 'gelesenes Secret für das OAuth-Refresh-Token (oauth.refresh_token_key)',
    grantType: 'Grant-Typ',
    audience: 'Audience',
    none: '(keiner)',
    credentialShaped: '(ein Wert in der Form von Zugangsdaten, nicht angezeigt)',
    notAnAddress: (shown) => `${shown} (keine Adresse, die eine Anfrage nutzen kann)`,
    originOnly: (origin) => `${origin} (der Rest hat die Form von Zugangsdaten, nicht angezeigt)`,
    sendsToNoHost: (shown) => `${shown} (sendet an keinen Host)`,
    sendsTo: (shown, host) => `${shown} (sendet an ${host})`,
    scopesWithheld: (shown, held) => {
      const count = `${String(held)} ${held === 1 ? 'Wert in der Form von Zugangsdaten' : 'Werte in der Form von Zugangsdaten'} (nicht angezeigt)`;
      return shown.length === 0 ? count : `${shown.join(' ')}; dazu ${count}`;
    },
    line: (label, was, now) => pv`${label}: ${was} → ${now}`,
    scopesAdded: (scopes) => pv`Scopes hinzugefügt: ${scopes}`,
    scopesRemoved: (scopes, noneLeft) => noneLeft
      ? pv`Scopes entfernt: ${scopes} (keiner mehr: der Anbieter entscheidet, welche er gewährt)`
      : pv`Scopes entfernt: ${scopes}`,
    providerParameter: (key, was, now) => pv`Anbieter-Parameter ${key}: ${was} → ${now}`,
  },
};

/**
 * How a consent key reads where the engine itself names it (a notification that lists a
 * question's options). The web UI shows the same words from its own table; a test holds the two
 * equal. The keys themselves are the wire (`src/contract/prompt.ts`).
 */
export const CONSENT_LABELS: Readonly<Record<DialogLanguage, Readonly<Record<ConsentKey, string>>>> = {
  en: { allow: 'Allow', deny: 'Deny', deep: 'Allow deep', balanced: 'Run on balanced', cancel: 'Cancel' },
  de: { allow: 'Erlauben', deny: 'Ablehnen', deep: 'Stufe Tief erlauben', balanced: 'Mit Ausgewogen ausführen', cancel: 'Abbrechen' },
};
