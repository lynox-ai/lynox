/**
 * The frame every page of the profile OAuth flow is drawn in: the consent page before a connect,
 * and the result page after it (connected, or not completed).
 *
 * These pages are served under `/api/`, where the engine sends
 * `Content-Security-Policy: default-src 'none'`. That blocks every style as well as every script,
 * so until this frame they were bare browser defaults. The frame keeps the rest of that policy:
 * no script, no image, no font, no request of any kind. It adds exactly one permission, the one
 * stylesheet below, by its SHA-256 in `style-src`. Not `'unsafe-inline'`: a hash admits these
 * bytes and nothing else, so markup injected into a page could not bring a style of its own.
 */
import { createHash } from 'node:crypto';

/**
 * The stylesheet, fixed bytes. Any change here changes {@link OAUTH_PAGE_STYLE_HASH} with it,
 * because both are computed from this one constant; a test pins that the header and the
 * element carry the same bytes.
 */
export const OAUTH_PAGE_CSS = [
  ':root{color-scheme:light dark;--bg:#f6f6fb;--card:#fff;--text:#1b1b2f;--muted:#55557a;--line:#e3e3f0;--accent:#6525ef;--accent-text:#fff}',
  '@media (prefers-color-scheme:dark){:root{--bg:#050510;--card:#0e0e22;--text:#e8e8f5;--muted:#9a9ac0;--line:#23234a;--accent:#7c4dff;--accent-text:#fff}}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'main{width:100%;max-width:36rem;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 28px 24px}',
  '.mark{margin:0 0 20px;font-weight:700;font-size:20px;letter-spacing:.01em;color:var(--accent)}',
  'h1{margin:0 0 16px;font-size:22px;line-height:1.3}',
  'p{margin:0 0 12px}',
  'ul{margin:0 0 12px;padding-left:20px}',
  'li{margin:0 0 4px}',
  'form{margin:20px 0 8px}',
  'button{display:block;width:100%;padding:12px 20px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;cursor:pointer}',
  'button:focus-visible{outline:3px solid var(--text);outline-offset:2px}',
  '@media (min-width:600px){button{display:inline-block;width:auto}}',
  '.small{font-size:14px;color:var(--muted)}',
  '.go{display:block;margin-top:20px;padding:12px 20px;border-radius:10px;background:var(--accent);color:var(--accent-text);font-weight:600;text-align:center;text-decoration:none}',
  '.go:focus-visible{outline:3px solid var(--text);outline-offset:2px}',
  '@media (min-width:600px){.go{display:inline-block}}',
].join('');

/** `'sha256-…'` of {@link OAUTH_PAGE_CSS}, as `style-src` names it. */
export const OAUTH_PAGE_STYLE_HASH = `'sha256-${createHash('sha256').update(OAUTH_PAGE_CSS, 'utf8').digest('base64')}'`;

/**
 * The policy of a result page: nothing but the frame's stylesheet — no `script-src`, no `img-src`,
 * no `connect-src`. `frame-ancestors`, `base-uri` and `form-action` are not covered by
 * `default-src`, so they are named too — the page stays unframeable and without a base or a form
 * target even outside the `/api/` branch that sets `X-Frame-Options`.
 */
export const OAUTH_PAGE_CSP = `default-src 'none'; style-src ${OAUTH_PAGE_STYLE_HASH}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

/**
 * The consent page's policy: the same, without `form-action`. Its form posts back to this origin,
 * and that POST answers with a 302 to the provider's authorize endpoint on another origin. Browsers
 * check `form-action` against every redirect of a form submission, so `form-action 'self'` blocks
 * that 302 and the connect never reaches the provider (measured in Chrome, 10.11.2026). The page
 * holds one form whose action this server writes; no script can add another.
 */
export const OAUTH_CONSENT_CSP = `default-src 'none'; style-src ${OAUTH_PAGE_STYLE_HASH}; frame-ancestors 'none'; base-uri 'none'`;

/** HTML-escape, for text and attribute values alike. */
export function escapeOAuthHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

/** The languages these pages are written in. Anything else falls back to English. */
export type OAuthLang = 'de' | 'en';

/** One text in both languages. */
export interface OAuthText {
  readonly en: string;
  readonly de: string;
}

/**
 * The page language from the instance's configured language (`config.language`,
 * `LYNOX_LANGUAGE`): German for any `de` tag (`de`, `de-CH`, …), English for everything else,
 * unset included.
 */
export function oauthLangOf(language: string | undefined): OAuthLang {
  return typeof language === 'string' && /^de(?:$|[-_])/i.test(language.trim()) ? 'de' : 'en';
}

/**
 * Every fixed text of the result page, by the place that sends it, in German and English. The
 * English one names lynox or this instance where it used to say "this engine", a word a
 * customer does not know.
 */
export const OAUTH_RESULT_TEXTS = {
  confirmFromOwnPage: {
    en: 'This confirmation has to come from the page this instance showed. Open the link again and confirm there. Nothing was sent to the provider.',
    de: 'Diese Bestätigung muss von der Seite kommen, die diese Instanz angezeigt hat. Öffne den Link noch einmal und bestätige dort. An den Anbieter wurde nichts gesendet.',
  },
  ownProfileOnly: {
    en: 'In this session you can connect only an API profile you set up yourself. Nothing was sent to the provider.',
    de: 'In dieser Sitzung kannst du nur ein API-Profil verbinden, das du selbst eingerichtet hast. An den Anbieter wurde nichts gesendet.',
  },
  tokenSlotNotOwn: {
    en: 'This connection would store its token under a name that is not this session\'s to fill. Nothing was sent to the provider.',
    de: 'Diese Verbindung würde ihr Token unter einem Namen speichern, den diese Sitzung nicht füllen darf. An den Anbieter wurde nichts gesendet.',
  },
  startFailed: {
    en: 'lynox could not start the authorization. Nothing was sent to the provider.',
    de: 'lynox konnte die Anmeldung beim Anbieter nicht starten. An den Anbieter wurde nichts gesendet.',
  },
  clientIdBesideCredential: {
    en: 'The client id of this profile is stored under a name that also holds a credential, and a client id is sent in the link. Store the client id under its own name, then ask for a new link. Nothing was sent to the provider.',
    de: 'Die Client-ID dieses Profils ist unter einem Namen gespeichert, unter dem auch ein Zugangsschlüssel liegt, und eine Client-ID steht im Link. Speichere die Client-ID unter einem eigenen Namen und fordere dann einen neuen Link an. An den Anbieter wurde nichts gesendet.',
  },
  clientIdWithheld: {
    en: 'The owner has not released the client id of this profile to it. Nothing was sent to the provider.',
    de: 'Der Inhaber dieser Instanz hat die Client-ID für dieses Profil nicht freigegeben. An den Anbieter wurde nichts gesendet.',
  },
  clientIdMissing: {
    en: 'The client id for this profile is no longer in the vault. Set it again, then ask for a new link.',
    de: 'Die Client-ID für dieses Profil liegt nicht mehr im Tresor. Speichere sie erneut und fordere dann einen neuen Link an.',
  },
  scopesChanged: {
    en: 'This connection asks for other access than the page you confirmed showed. Open the link again and read the page. Nothing was sent to the provider.',
    de: 'Diese Verbindung verlangt andere Rechte als die, die auf der bestätigten Seite standen. Öffne den Link noch einmal und lies die Seite. An den Anbieter wurde nichts gesendet.',
  },
  erasing: {
    en: 'Your data is being erased right now. Connect this API again after it has finished. Nothing was stored.',
    de: 'Deine Daten werden gerade gelöscht. Verbinde diese API erneut, wenn das abgeschlossen ist. Es wurde nichts gespeichert.',
  },
  providerDeclined: {
    en: 'The provider did not complete the authorization. Nothing was stored. You can start the connection again.',
    de: 'Der Anbieter hat die Anmeldung nicht abgeschlossen. Es wurde nichts gespeichert. Du kannst die Verbindung neu starten.',
  },
  linkExpired: {
    en: 'This sign-in link is no longer valid. Start the connection again in lynox.',
    de: 'Dieser Anmelde-Link ist nicht mehr gültig. Starte die Verbindung in lynox neu.',
  },
  connectionGone: {
    en: 'That connection no longer exists on this instance. Nothing was changed.',
    de: 'Diese Verbindung gibt es in dieser Instanz nicht mehr. Es wurde nichts geändert.',
  },
  otherSessionChanged: {
    en: 'This connection can no longer be completed for the session that started it. Nothing was changed.',
    de: 'Diese Verbindung lässt sich für die Sitzung, die sie gestartet hat, nicht mehr abschliessen. Es wurde nichts geändert.',
  },
  notCompletableChanged: {
    en: 'This connection can no longer be completed on this instance. Nothing was changed.',
    de: 'Diese Verbindung lässt sich in dieser Instanz nicht mehr abschliessen. Es wurde nichts geändert.',
  },
  credentialTargetRefused: {
    en: 'This connection points somewhere lynox may not send credentials. Nothing was changed.',
    de: 'Diese Verbindung zeigt auf eine Adresse, an die lynox keine Zugangsdaten senden darf. Es wurde nichts geändert.',
  },
  tokenAsClientCredential: {
    en: 'This connection names an OAuth token as its client credentials, which lynox does not send. Nothing was changed.',
    de: 'Diese Verbindung nennt ein OAuth-Token als Client-Zugangsdaten, und so etwas sendet lynox nicht. Es wurde nichts geändert.',
  },
  keyNotAllowedThere: {
    en: 'Nothing was changed. This connection would send a stored key to an address it is not allowed to go to. The owner of this instance can allow it: save the profile again in the chat and answer the question that appears.',
    de: 'Es wurde nichts geändert. Diese Verbindung würde einen gespeicherten Schlüssel an eine Adresse senden, an die er nicht gehen darf. Erlauben kann das der Inhaber dieser Instanz: das Profil im Chat noch einmal speichern und die Frage beantworten, die dann erscheint.',
  },
  credentialsWithheld: {
    en: 'The owner has not released the credentials of this profile to it. Nothing was changed.',
    de: 'Der Inhaber dieser Instanz hat die Zugangsdaten für dieses Profil nicht freigegeben. Es wurde nichts geändert.',
  },
  credentialsMissing: {
    en: 'The credentials for this connection are no longer in the vault. Set them again, then ask for a new link.',
    de: 'Die Zugangsdaten für diese Verbindung liegen nicht mehr im Tresor. Speichere sie erneut und fordere dann einen neuen Link an.',
  },
  storeMismatch: {
    en: 'This connection\'s address is not the store it authorizes. Nothing was changed.',
    de: 'Die Adresse dieser Verbindung ist nicht der Shop, den sie autorisiert. Es wurde nichts geändert.',
  },
  signatureRefused: {
    en: 'The provider\'s signature on this authorization does not hold for this connection. Nothing was stored.',
    de: 'Die Signatur des Anbieters passt nicht zu dieser Verbindung. Es wurde nichts gespeichert.',
  },
  logUnavailable: {
    en: 'This connection cannot be recorded in the instance log right now. Nothing was stored. Try again later.',
    de: 'Diese Verbindung kann gerade nicht im Protokoll der Instanz festgehalten werden. Es wurde nichts gespeichert. Versuch es später noch einmal.',
  },
  exchangeFailed: {
    en: 'The authorization could not be completed with the provider. Nothing was stored. You can start the connection again.',
    de: 'Die Anmeldung beim Anbieter liess sich nicht abschliessen. Es wurde nichts gespeichert. Du kannst die Verbindung neu starten.',
  },
  unreadableAnswer: {
    en: 'The provider answered with something lynox could not read. Nothing was stored.',
    de: 'Der Anbieter hat mit etwas geantwortet, das lynox nicht lesen konnte. Es wurde nichts gespeichert.',
  },
  noAccessToken: {
    en: 'The provider answered without an access token. Nothing was stored.',
    de: 'Der Anbieter hat ohne Zugangstoken geantwortet. Es wurde nichts gespeichert.',
  },
  otherSessionStored: {
    en: 'This connection can no longer be completed for the session that started it. Nothing was stored.',
    de: 'Diese Verbindung lässt sich für die Sitzung, die sie gestartet hat, nicht mehr abschliessen. Es wurde nichts gespeichert.',
  },
  addressChanged: {
    en: 'This connection\'s address changed while it was being completed. Nothing was stored.',
    de: 'Die Adresse dieser Verbindung hat sich geändert, während sie abgeschlossen wurde. Es wurde nichts gespeichert.',
  },
  storeIncomplete: {
    en: 'The authorization arrived but lynox could not finish storing it. The connection is incomplete — ask for a new link and try again.',
    de: 'Die Anmeldung ist angekommen, aber lynox konnte sie nicht fertig speichern. Die Verbindung ist unvollständig: Fordere einen neuen Link an und versuch es noch einmal.',
  },
  bindFailed: {
    en: 'The authorization arrived, but lynox could not bind it to the store, so lynox will not use this connection. Ask for a new link and try again.',
    de: 'Die Anmeldung ist angekommen, aber lynox konnte sie nicht an den Shop binden und nutzt diese Verbindung deshalb nicht. Fordere einen neuen Link an und versuch es noch einmal.',
  },
  recordFailed: {
    en: 'The authorization arrived, but lynox could not record the new connection, so the profile still counts as revoked and a deletion announced for it still stands. Reconnect again from the profile.',
    de: 'Die Anmeldung ist angekommen, aber lynox konnte die neue Verbindung nicht festhalten. Das Profil gilt deshalb weiter als widerrufen, und eine dafür angekündigte Löschung bleibt bestehen. Verbinde das Profil noch einmal.',
  },
  noteProviderUnknown: {
    en: 'This connection has no provider this instance knows, so it cannot show what the owner sees of it. Nothing was sent to the provider.',
    de: 'Diese Verbindung nennt keinen Anbieter, den lynox kennt. Deshalb kann diese Seite nicht zeigen, was der Inhaber dieser Instanz von ihr sieht. An den Anbieter wurde nichts gesendet.',
  },
  noteChanged: {
    en: 'This connection now shows another note than the page you confirmed. Open the link again and read the page. Nothing was sent to the provider.',
    de: 'Der Hinweis zu dieser Verbindung hat sich geändert, seit du die Seite bestätigt hast. Öffne den Link noch einmal und lies die Seite. An den Anbieter wurde nichts gesendet.',
  },
} as const satisfies Record<string, OAuthText>;

/** The 200 page's text: which provider is now connected. */
export function connectedText(provider: string): OAuthText {
  return { en: `${provider} is connected to lynox.`, de: `${provider} ist mit lynox verbunden.` };
}

/**
 * The 200 page when the provider granted more than was asked: the first ten extra scopes by id,
 * then how many more.
 */
export function connectedWithMoreText(grantedBeyond: readonly string[]): OAuthText {
  const shown = grantedBeyond.slice(0, 10).join(', ');
  const rest = grantedBeyond.length - 10;
  const en = shown + (rest > 0 ? `, and ${String(rest)} more` : '');
  const de = shown + (rest > 0 ? ` und ${String(rest)} weitere` : '');
  return {
    en: `The provider granted more access than this connection asks for: ${en}. The token the provider issued holds all of it. If that is not what you want, narrow the app's permissions at the provider and connect again.`,
    de: `Der Anbieter hat mehr Rechte erteilt, als diese Verbindung verlangt: ${de}. Das ausgestellte Token enthält alle davon. Willst du das nicht, schränke die Rechte der App beim Anbieter ein und verbinde neu.`,
  };
}

/**
 * The page an engine without engine.db shows instead of connecting an account (`connect`, the OAuth
 * start) or saving the connection (`save`, the callback). A person reads it, so it is shorter than
 * the JSON refusal. The closing paragraph is word for word the status bar's for the same mode
 * (web-ui i18n `status.boot_store_missing_selfhost` / `status.boot_store_missing_managed`), chosen
 * the same way: managed when a control plane runs the instance. The status bar shows the owner only;
 * the callback page reaches whoever started the connection, so on self-host a mandate that started it
 * on a healthy engine gets `helper`: it cannot fix the cause, the owner can. (At the start a mandate
 * is turned away earlier: without engine.db no mandate is live.) Each is its own paragraph on the page.
 */
const ENGINE_LESS_PAGE_HEADS = {
  connect: {
    de: 'lynox verbindet gerade keine Konten: Die Engine ist ohne engine.db gestartet, und eine neue Verbindung ginge verloren, sobald sie engine.db wieder öffnet. An den Anbieter wurde nichts gesendet. Verbinde das Konto erneut, wenn die Engine neu gestartet ist.',
    en: 'lynox is not connecting accounts right now: the engine started without engine.db, and a new connection would be lost once it opens engine.db again. Nothing was sent to the provider. Connect the account again once the engine has restarted.',
  },
  save: {
    de: 'lynox hat diese Verbindung nicht gespeichert: Die Engine ist ohne engine.db gestartet, und die Änderung ginge verloren, sobald sie engine.db wieder öffnet. Füge die Verbindung erneut hinzu oder ändere sie, wenn die Engine neu gestartet ist.',
    en: 'lynox did not save this connection: the engine started without engine.db, and the change would be lost once it opens engine.db again. Add or change the connection again once the engine has restarted.',
  },
} as const satisfies Record<string, OAuthText>;

export const ENGINE_LESS_PAGE_CLOSE = {
  selfhost: {
    de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Den Grund nennt das Log, das die Engine beim Start schreibt; behebe ihn und starte die Engine neu.',
    en: 'This lasts until the engine restarts and can open all its files again. The log the engine writes at startup names the cause; fix it and restart the engine.',
  },
  helper: {
    de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Sag dem Inhaber dieser Instanz Bescheid.',
    en: 'This lasts until the engine restarts and can open all its files again. Let the owner of this instance know.',
  },
  managed: {
    de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Das lynox-Team bekommt dazu automatisch eine Meldung.',
    en: 'This lasts until the engine restarts and can open all its files again. The lynox team gets an automatic alert about it.',
  },
} as const satisfies Record<string, OAuthText>;

/** Which closing paragraph: managed for everyone, else the owner's or a helper's. */
export function engineLessPageClose(managed: boolean, owner: boolean): keyof typeof ENGINE_LESS_PAGE_CLOSE {
  if (managed) return 'managed';
  return owner ? 'selfhost' : 'helper';
}

export function engineLessPageText(kind: keyof typeof ENGINE_LESS_PAGE_HEADS, managed: boolean, owner: boolean): readonly OAuthText[] {
  return [ENGINE_LESS_PAGE_HEADS[kind], ENGINE_LESS_PAGE_CLOSE[engineLessPageClose(managed, owner)]];
}

/**
 * Where a result page's one button leads. `apis` once the page knows the
 * profile — Settings → APIs shows the connection's state; `app` where it does not. The paths are
 * fixed here and a caller names only the kind, so no request value can become the target.
 */
export type OAuthBack = 'apis' | 'app';
export const OAUTH_BACK_PATHS: Readonly<Record<OAuthBack, string>> = Object.freeze({
  apis: '/app/settings/apis',
  app: '/app',
});

/** The result page, in `lang`: a title by outcome, the text, and one button back into lynox —
 *  never "close this tab" as the only way on. A list is one paragraph per entry; a text is never
 *  split, so a value written into it (a profile name) cannot start a paragraph of its own. */
export function oauthResultHtml(lang: OAuthLang, status: number, text: OAuthText | readonly OAuthText[], back: OAuthBack): string {
  const title = status === 200
    ? (lang === 'de' ? 'Verbunden' : 'Connected')
    : (lang === 'de' ? 'Verbindung nicht abgeschlossen' : 'Connection not completed');
  const go = lang === 'de' ? 'Zu lynox' : 'Go to lynox';
  return oauthPageHtml(lang, title,
    `<h1>${escapeOAuthHtml(title)}</h1>${(Array.isArray(text) ? text : [text]).map((p: OAuthText) => `<p>${escapeOAuthHtml(p[lang])}</p>`).join('')}`
    + `<a class="go" href="${OAUTH_BACK_PATHS[back]}">${escapeOAuthHtml(go)}</a>`);
}

/**
 * A whole page in the frame. `lang` and `title` are escaped here; `body` is markup the caller has
 * already escaped, because it holds the caller's own elements (paragraphs, a list, a form).
 */
export function oauthPageHtml(lang: string, title: string, body: string): string {
  return `<!DOCTYPE html><html lang="${escapeOAuthHtml(lang)}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeOAuthHtml(title)}</title><style>${OAUTH_PAGE_CSS}</style></head>`
    + `<body><main><p class="mark">lynox</p>${body}</main></body></html>`;
}
