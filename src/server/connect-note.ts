/**
 * The note a helper reads before connecting a provider in a mandate's session.
 *
 * A helper connects with their own login, and the owner of the instance later sees the
 * connection and, for some providers, the account. The helper is told so before the provider's
 * login, on a page of this instance, in the words below. The two notes are binding customer
 * text: change them only together with the approval that holds them, never to fit a layout.
 *
 * The page is shown to a mandate's session before every connect, read access included, and is
 * never skipped by a redirect. The owner's session never sees it. Which note applies is decided
 * by the provider, because the page stands before the login: the first only where the account is
 * known from where the provider's answer comes from (a store's own address), the third
 * everywhere else, since it holds with a label and without one.
 */
import type { OAuthPreset } from '../core/oauth-presets.js';

export type NoteLang = 'de' | 'en';

/**
 * Which note: `1` where the account is known from the store the provider signs its answer for,
 * `3` for every other provider. The callback reads the account from that origin under the same
 * condition (`preset.callbackVerification === 'shopify-hmac'` → `accountFromStoreOrigin`); a test
 * holds every preset in the register to it.
 */
export type NoteVersion = '1' | '3';

export function noteVersionFor(preset: Pick<OAuthPreset, 'callbackVerification'>): NoteVersion {
  return preset.callbackVerification === 'shopify-hmac' ? '1' : '3';
}

/** The note itself, word for word. `{provider}` is the preset's label. */
export function noteText(version: NoteVersion, lang: NoteLang, provider: string): string {
  if (version === '1') {
    return lang === 'de'
      ? 'Der Inhaber dieser Instanz sieht, welches Konto du hier verbindest. Ein Plan, den er bestätigt, kann diese Verbindung nutzen.'
      : 'The owner of this instance sees which account you connect here. A plan they confirm can use this connection.';
  }
  return lang === 'de'
    ? `Der Inhaber dieser Instanz sieht, dass du hier ${provider} mit deinem eigenen Login verbindest, und, wenn ${provider} es lynox mitteilt, mit welchem Konto. Ein Plan, den er bestätigt, kann diese Verbindung nutzen.`
    : `The owner of this instance sees that you connect ${provider} here with your own login and, if ${provider} tells lynox, with which account. A plan they confirm can use this connection.`;
}

/** The page's title and heading, where no customer text brings its own. */
export function noteTitle(lang: NoteLang, provider: string): string {
  return lang === 'de' ? `${provider} verbinden` : `Connect ${provider}`;
}

/** The page's button, where no customer text brings its own. */
export function noteButton(lang: NoteLang, provider: string): string {
  return lang === 'de' ? `Weiter zu ${provider}` : `Continue to ${provider}`;
}

/**
 * The page's language from `Accept-Language`: the preferred range whose primary subtag is `de` or
 * `en` (so `de-CH` and `de-DE` read as German), English otherwise. The engine keeps no locale of
 * its own for a session; the web UI's choice lives in the browser and does not reach this page.
 */
export function noteLang(acceptLanguage: string | undefined): NoteLang {
  if (acceptLanguage === undefined) return 'en';
  const ranges = acceptLanguage.split(',').map((part, index) => {
    const [tag = '', ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    return { primary: tag.trim().toLowerCase().split('-')[0] ?? '', weight: Number.isFinite(weight) ? weight : 0, index };
  });
  ranges.sort((a, b) => b.weight - a.weight || a.index - b.index);
  const first = ranges.find((r) => r.weight > 0 && (r.primary === 'de' || r.primary === 'en'));
  return first?.primary === 'de' ? 'de' : 'en';
}

/** What the connect page shows a mandate's session, and what its confirmation is held to. */
export interface ConnectNote {
  readonly version: NoteVersion;
  readonly lang: NoteLang;
  readonly provider: string;
}

export function connectNoteFor(preset: Pick<OAuthPreset, 'callbackVerification' | 'label'>, lang: NoteLang): ConnectNote {
  return { version: noteVersionFor(preset), lang, provider: preset.label };
}
