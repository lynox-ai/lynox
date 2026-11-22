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

import type { ConsentKey } from '../contract/prompt.js';
import type { NoticeLanguage } from '../core/notice-language.js';
import { pv, singleLine } from '../core/prompt-value.js';
import type { PromptText } from '../types/agent.js';

/** The language a confirmation dialog is asked in. */
export type DialogLanguage = NoticeLanguage;

/** The quotation marks of each dialog language, opening and closing: a value is quoted as its
 *  readers write it. */
export const QUOTE_MARKS: Readonly<Record<DialogLanguage, readonly [open: string, close: string]>> = { en: ['“', '”'], de: ['„', '“'] };

/** `\` and every character that reads as a double quotation mark (the straight one, both
 *  languages' marks, and their lookalikes), so a value cannot close the marks around it. */
const QUOTE_LIKE = /[\\"“”„‟″‶＂〝〞〟〃ˮ״❝❞ʺ˝˶⹂🙶🙷🙸]/gu;

/** `text` as it stands between a dialog's quotation marks: each quote-like character escaped. */
export function escapeQuoted(text: string): string {
  return text.replace(QUOTE_LIKE, (c) => `\\${c}`);
}

/** Whether `text` already ends a sentence (or a `[…]` marker), so no full stop is added after it. */
export function endsSentence(text: string): boolean {
  return /[.!?…\]]$/u.test(text.trimEnd());
}

/** The longest a profile's name is shown in a question, "…" included and before escaping: a long
 *  name cannot push the disclosure after it out of view. */
const PROFILE_NAME_MAX = 64;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A profile's name as a question quotes it: on one line, at most 64 characters as a reader counts
 *  them (a flag or an emoji with its modifier is one), then escaped. */
function shownName(name: string): string {
  const chars = Array.from(GRAPHEMES.segment(singleLine(name).trim()), (g) => g.segment);
  return escapeQuoted(chars.length > PROFILE_NAME_MAX ? `${chars.slice(0, PROFILE_NAME_MAX - 1).join('')}…` : chars.join(''));
}

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
    delete: { en: 'delete profile', de: 'Profil löschen' },
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
    children: (count) => count === 1 ? '1 subtask would run' : `${count} subtasks would run`,
    tierUnknownBand: 'a model in the Deep tier (or an unregistered custom model whose cost band the engine cannot prove)',
    tierDeep: 'the Deep tier (a stronger model, more thorough but more expensive)',
    tailDowngrade: 'Allow this only if the task really needs the Deep tier. Otherwise choose “Run on Balanced”.',
    tailPinned: 'A model profile pins a specific endpoint and cannot be substituted down — allow only if you want this run on that model.',
    sentence: (word, children, tier, costUsd, providers, tail) => `⚠ ${word}: ${children} on ${tier}. Estimated model cost for this session: about $${costUsd}. Provider: ${providers}. ${tail}`,
  },
  de: {
    children: (count) => count === 1 ? 'Eine Teilaufgabe würde' : `${count} Teilaufgaben würden`,
    tierUnknownBand: 'einem Modell der Stufe „Tief“ (oder einem nicht registrierten eigenen Modell, dessen Kostenrahmen lynox nicht belegen kann)',
    tierDeep: 'der Stufe „Tief“ (ein stärkeres Modell, gründlicher, aber teurer)',
    tailDowngrade: 'Erlaube das nur, wenn die Aufgabe die Stufe „Tief“ wirklich braucht. Sonst wähle „Mit Ausgewogen ausführen“.',
    tailPinned: 'Ein Modellprofil legt einen bestimmten Endpunkt fest und lässt sich nicht herabstufen. Erlaube das nur, wenn dieser Lauf auf diesem Modell laufen soll.',
    sentence: (word, children, tier, costUsd, providers, tail) => `⚠ ${word}: ${children} auf ${tier} laufen. Geschätzte Modellkosten für diese Sitzung: etwa $${costUsd}. Anbieter: ${providers}. ${tail}`,
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
    unknownProvider: (known) => `No authorization address could be derived: this profile names a provider this engine does not have built in, so there is nothing here to disclose or accept. It knows: ${known}.`,
    noProviders: 'No authorization address could be derived: this engine has no built-in providers yet, so there is nothing here to disclose or accept.',
    badPreset: (id, detail) => `No authorization address could be derived: the built-in provider “${id}” is defined wrongly in this engine — ${detail}. Nothing on this profile fixes that; report it.`,
    missingParam: (id, describe, name) => `No authorization address could be derived: the provider “${id}” needs ${describe} (auth.oauth.preset_params.${name}), which this profile does not supply. Set it with api_setup update — the host is disclosed then.`,
    refusedParam: (id, describe, name) => `No authorization address could be derived: the value this profile supplies for ${describe} (auth.oauth.preset_params.${name}) is not one the provider “${id}” accepts. Correct it with api_setup update — the host is disclosed then.`,
  },
  de: {
    unknownProvider: (known) => `Es liess sich keine Anmeldeadresse ableiten: Dieses Profil nennt einen Anbieter, den lynox nicht eingebaut hat, daher gibt es hier nichts offenzulegen oder anzunehmen. Eingebaut sind: ${known}.`,
    noProviders: 'Es liess sich keine Anmeldeadresse ableiten: lynox hat noch keine eingebauten Anbieter, daher gibt es hier nichts offenzulegen oder anzunehmen.',
    badPreset: (id, detail) => `Es liess sich keine Anmeldeadresse ableiten: Der eingebaute Anbieter „${id}“ ist in lynox falsch definiert — ${detail}. An diesem Profil lässt sich das nicht beheben; melde es.`,
    missingParam: (id, describe, name) => `Es liess sich keine Anmeldeadresse ableiten: Der Anbieter „${id}“ braucht ${describe} (auth.oauth.preset_params.${name}), und dieses Profil gibt es nicht an. Setze es mit api_setup update — dann wird der Host offengelegt.`,
    refusedParam: (id, describe, name) => `Es liess sich keine Anmeldeadresse ableiten: Der Wert, den dieses Profil für ${describe} (auth.oauth.preset_params.${name}) angibt, ist keiner, den der Anbieter „${id}“ annimmt. Korrigiere ihn mit api_setup update — dann wird der Host offengelegt.`,
  },
};

/** The German for a provider parameter's description (`OAuthPresetParam.describe`), keyed by the English. */
const PRESET_PARAM_DESCRIBE_DE: Readonly<Record<string, string>> = {
  'the store\'s myshopify.com subdomain, e.g. "my-store" for my-store.myshopify.com, in lower case': 'die myshopify.com-Subdomain des Stores in Kleinbuchstaben, z. B. „my-store“ für my-store.myshopify.com',
};

/** A provider parameter's description in `language`; English as written. */
export function presetParamDescribe(describe: string, language: DialogLanguage): string {
  if (language === 'en') return describe;
  return Object.hasOwn(PRESET_PARAM_DESCRIBE_DE, describe) ? PRESET_PARAM_DESCRIBE_DE[describe]! : describe;
}

/** `api_setup`'s own questions. Every `${…}` is a value, as in any `pv`. */
export interface ApiSetupDialog {
  readonly save: (word: PromptText, name: string, disclosure: string) => PromptText;
  readonly redirect: (hosts: string[]) => string;
  readonly deleteUnreadable: (word: PromptText, id: string, source: string) => PromptText;
  readonly deleteProfile: (word: PromptText, name: string, id: string, host: string | undefined, loses: PromptText) => PromptText;
  readonly losesTokens: (tokens: number) => PromptText;
  readonly losesSettings: PromptText;
  readonly release: (word: PromptText, p: { name: string; id: string; author: string; role: string; hosts: string[]; authority: string; clientId: boolean; held: boolean }) => PromptText;
  readonly adopt: (word: PromptText, p: { name: string; id: string; by: string; known: boolean; hosts: string[]; names: string[] }) => PromptText;
}

/** At most this many vault names are listed in an adoption question; the rest are counted. */
const ADOPT_NAMES_SHOWN = 30;

export const API_SETUP_DIALOG: Readonly<Record<DialogLanguage, ApiSetupDialog>> = {
  en: {
    save: (word, name, disclosure) => pv`⚠ ${word}: saving “${shownName(name)}” needs your acceptance.\n\n${disclosure}\n\nAccept and save this profile?`,
    redirect: (hosts) => `You will be sent to ${hosts.join(' and ')} in your own browser to authorize this profile. You sign in there, to that provider — not to lynox — and what comes back is stored here for this profile.`,
    deleteUnreadable: (word, id, source) => pv`⚠ ${word}: delete the stored API profile ${id}, which could not be read (${source})? Every vault name it carries is free for other profiles once it is gone. Delete it?`,
    deleteProfile: (word, name, id, host, loses) => pv`⚠ ${word}: delete the API profile ${name} (id ${id}${host ? pv`, host ${host}` : pv``})?${loses} Delete it?`,
    losesTokens: (tokens) => pv` The ${tokens} token(s) its sign-in stored are removed from the vault with it, also where another profile reads them, so the connection has to be authorized again.`,
    losesSettings: pv` Its settings (endpoints, guidelines, sign-in method) are removed.`,
    release: (word, p) => pv`⚠ ${word}: release the vault name ${p.name} to API profile ${p.id}, set up in the session of ${p.author}? The engine then sends its value, as ${p.role}, to ${p.hosts.length > 0 ? p.hosts.join(', ') : 'no host it can name'}${p.authority ? ` (${p.authority})` : ''}, for every request and run through this profile, the user's own and bulk runs included, until that mandate ends or the user withdraws it.${p.clientId ? ' A client id also goes into the sign-in link, to the browser of whoever opens it.' : ''} The vault ${p.held ? 'holds a value' : 'holds no value yet'} under this name. Any change to where it goes ends the release. Release it?`,
    adopt: (word, p) => {
      const shown = p.names.slice(0, ADOPT_NAMES_SHOWN).join(', ') + (p.names.length > ADOPT_NAMES_SHOWN ? ` and ${String(p.names.length - ADOPT_NAMES_SHOWN)} more` : '');
      return pv`⚠ ${word}: adopt the connection of API profile ${p.name} (id ${p.id})? It was authorized at the provider in the session of ${p.by}, ${p.known ? 'which is not active' : 'and this engine cannot tell whether that mandate is still active'}. Once adopted, the profile is yours. The engine then sends to ${p.hosts.length > 0 ? p.hosts.join(', ') : 'no host it can name'}, for your requests and runs, the connection's tokens and the vault names this profile names, read like any of your profiles, values from the environment included: ${shown.length > 0 ? shown : 'none'}. Adopt it?`;
    },
  },
  de: {
    save: (word, name, disclosure) => pv`⚠ ${word}: Zum Speichern von „${shownName(name)}“ braucht es deine Zustimmung.\n\n${disclosure}\n\nDieses Profil annehmen und speichern?`,
    redirect: (hosts) => `Zur Freigabe dieses Profils öffnet sich ${hosts.join(' und ')} in deinem eigenen Browser. Du meldest dich dort beim Anbieter an, nicht bei lynox, und was zurückkommt, wird hier für dieses Profil gespeichert.`,
    deleteUnreadable: (word, id, source) => pv`⚠ ${word}: das gespeicherte API-Profil ${id} löschen, das sich nicht lesen liess (${source})? Jeder Vault-Name darin ist danach für andere Profile frei. Löschen?`,
    deleteProfile: (word, name, id, host, loses) => pv`⚠ ${word}: das API-Profil ${name} löschen (Id ${id}${host ? pv`, Host ${host}` : pv``})?${loses} Löschen?`,
    losesTokens: (tokens) => tokens === 1
      ? pv` Das Token, das seine Anmeldung gespeichert hat, wird mit ihm aus dem Vault entfernt, auch dort, wo ein anderes Profil es liest; die Verbindung muss dann neu autorisiert werden.`
      : pv` Die ${tokens} Tokens, die seine Anmeldung gespeichert hat, werden mit ihm aus dem Vault entfernt, auch dort, wo ein anderes Profil sie liest; die Verbindung muss dann neu autorisiert werden.`,
    losesSettings: pv` Seine Einstellungen (Endpunkte, Richtlinien, Anmeldeart) werden entfernt.`,
    release: (word, p) => pv`⚠ ${word}: den Vault-Namen ${p.name} für das API-Profil ${p.id} freigeben, eingerichtet in der Sitzung von ${p.author}? lynox sendet seinen Wert dann als ${p.role} an ${p.hosts.length > 0 ? p.hosts.join(', ') : 'keinen Host, den lynox benennen kann'}${p.authority ? ` (${p.authority})` : ''}, bei jeder Anfrage und jedem Lauf über dieses Profil, auch bei deinen eigenen und bei Massenläufen, bis der Zugang dieser Person endet oder du die Freigabe zurückziehst.${p.clientId ? ' Eine Client-ID steht ausserdem im Anmeldelink und geht an den Browser dessen, der ihn öffnet.' : ''} Unter diesem Namen ${p.held ? 'liegt im Vault ein Wert' : 'liegt im Vault noch kein Wert'}. Jede Änderung daran, wohin er geht, beendet die Freigabe. Freigeben?`,
    adopt: (word, p) => {
      const shown = p.names.slice(0, ADOPT_NAMES_SHOWN).join(', ') + (p.names.length > ADOPT_NAMES_SHOWN ? ` und ${String(p.names.length - ADOPT_NAMES_SHOWN)} weitere` : '');
      return pv`⚠ ${word}: die Verbindung des API-Profils ${p.name} (Id ${p.id}) übernehmen? Sie wurde beim Anbieter in der Sitzung von ${p.by} autorisiert, ${p.known ? 'deren Zugang beendet ist' : 'und lynox kann nicht feststellen, ob der Zugang dieser Person noch besteht'}. Nach der Übernahme gehört das Profil dir. lynox sendet dann bei deinen Anfragen und Läufen an ${p.hosts.length > 0 ? p.hosts.join(', ') : 'keinen Host, den lynox benennen kann'} die Tokens der Verbindung und die Vault-Namen, die dieses Profil nennt. Sie werden gelesen wie bei jedem deiner Profile, Werte aus der Umgebung eingeschlossen: ${shown.length > 0 ? shown : 'keine'}. Übernehmen?`;
    },
  },
};

/**
 * How a consent key reads where the engine itself names it (a notification that lists a
 * question's options). The web UI shows the same words from its own table; a test holds the two
 * equal. The keys themselves are the wire (`src/contract/prompt.ts`).
 */
export const CONSENT_LABELS: Readonly<Record<DialogLanguage, Readonly<Record<ConsentKey, string>>>> = {
  en: { allow: 'Allow', deny: 'Deny', deep: 'Allow Deep', balanced: 'Run on Balanced', cancel: 'Cancel' },
  de: { allow: 'Erlauben', deny: 'Ablehnen', deep: 'Tief erlauben', balanced: 'Mit Ausgewogen ausführen', cancel: 'Abbrechen' },
};
