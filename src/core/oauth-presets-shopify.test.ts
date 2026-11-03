import { describe, expect, it } from 'vitest';
import { OAUTH_PRESETS, consentFrameProblems, derivePresetEndpoints, presetNotFollowed, presetRegisterOf, presetScopeRequest, presetStoreHost } from './oauth-presets.js';
import { decideConnect, isRefusal } from '../server/oauth-connect-decision.js';
import { SHOPIFY_MEDIA_WRITABLE_FIELDS, SHOPIFY_WRITABLE_FIELDS } from './shopify-graphql.js';

const shopify = OAUTH_PRESETS.get('shopify')!;

const profile = (base_url: string, shop: unknown, preset_id: string | undefined = 'shopify', type = 'oauth2') => ({
  base_url,
  auth: { type, oauth: { preset_id, preset_params: { shop } } },
});

describe('the Shopify preset', () => {
  it('derives the store host and both endpoints from the shop parameter', () => {
    expect(derivePresetEndpoints('shopify', { shop: 'my-store' })).toEqual({
      host: 'my-store.myshopify.com',
      authorizeUrl: 'https://my-store.myshopify.com/admin/oauth/authorize',
      tokenUrl: 'https://my-store.myshopify.com/admin/oauth/access_token',
    });
  });

  it.each(['My-Store', '-store', 'my_store', 'my.store', 'evil.com#', 'a/b', 'store.myshopify.com'])('refuses the shop value %j', (shop) => {
    expect(derivePresetEndpoints('shopify', { shop })).toMatchObject({ kind: 'bad-param' });
  });

  it('allows the read scopes and write_products, and asks for nothing it does not name', () => {
    expect(shopify.requiredScopes).toEqual([]);
    // The whole list: a scope added here reaches every store the preset connects. One write
    // scope, for the bulk run's product write; any other write scope is a reviewed change.
    expect(shopify.allowedScopes).toEqual(['read_products', 'read_orders', 'read_customers', 'read_inventory', 'read_fulfillments', 'write_products']);
    expect(presetScopeRequest(shopify, 'read_products read_orders')).toEqual({ scopes: ['read_products', 'read_orders'] });
    expect(presetScopeRequest(shopify, 'read_all_orders')).toEqual({ refused: ['read_all_orders'] });
  });

  it('asks for write_products only when the profile names it', () => {
    expect(presetScopeRequest(shopify, 'read_products write_products')).toEqual({ scopes: ['read_products', 'write_products'] });
    expect(presetScopeRequest(shopify, 'read_products')).toEqual({ scopes: ['read_products'] });
  });

  it.each(['write_files', 'write_orders', 'write_inventory', 'write_customers', 'write_themes'])('still refuses %s, with write_products or without', (scope) => {
    expect(presetScopeRequest(shopify, `read_products write_products ${scope}`)).toEqual({ refused: [scope] });
    expect(presetScopeRequest(shopify, scope)).toEqual({ refused: [scope] });
  });
});

describe('a template preset whose API is not on its derived host', () => {
  it('has no store host', () => {
    const tenant = { ...shopify, id: 'tenant', apiOnDerivedHost: undefined };
    expect(presetStoreHost(profile('https://my-store.myshopify.com', 'my-store', 'tenant'), presetRegisterOf([tenant]))).toBeNull();
  });
});

describe('presetStoreHost', () => {
  it('is the derived host when the base url is https on exactly that host', () => {
    expect(presetStoreHost(profile('https://my-store.myshopify.com', 'my-store'))).toBe('my-store.myshopify.com');
    expect(presetStoreHost(profile('https://my-store.myshopify.com/admin/api/2025-10', 'my-store'))).toBe('my-store.myshopify.com');
  });

  it.each([
    ['another store', profile('https://other.myshopify.com', 'my-store')],
    ['http', profile('http://my-store.myshopify.com', 'my-store')],
    ['a port', profile('https://my-store.myshopify.com:8443', 'my-store')],
    ['credentials', profile('https://u:p@my-store.myshopify.com', 'my-store')],
    ['a password alone', profile('https://:p@my-store.myshopify.com', 'my-store')],
    ['a user name alone', profile('https://u@my-store.myshopify.com', 'my-store')],
    ['a trailing dot', profile('https://my-store.myshopify.com.', 'my-store')],
    ['a refused shop value', profile('https://My-Store.myshopify.com', 'My-Store')],
    ['no shop value', profile('https://my-store.myshopify.com', undefined)],
    ['an unparsable base url', profile('not a url', 'my-store')],
    ['bexio', profile('https://api.bexio.com', 'my-store', 'bexio')],
    ['no preset', { base_url: 'https://my-store.myshopify.com', auth: { type: 'oauth2', oauth: { preset_params: { shop: 'my-store' } } } }],
    ['not oauth2', profile('https://my-store.myshopify.com', 'my-store', 'shopify', 'bearer')],
  ] as const)('is null for %s', (_label, p) => {
    expect(presetStoreHost(p)).toBeNull();
  });
});

describe('presetNotFollowed on a store host', () => {
  // While Shopify is closed, a profile on a store is not pointed at the preset: it gets the
  // closed text where it is used.
  it('names no provider for a store host', () => {
    expect(presetNotFollowed({ base_url: 'https://my-store.myshopify.com', auth: { type: 'bearer' } })).toBeUndefined();
    expect(presetNotFollowed({ base_url: 'https://my-store.myshopify.com' })).toBeUndefined();
  });

  it('still names bexio for its own host', () => {
    expect(presetNotFollowed({ base_url: 'https://api.bexio.com', auth: { type: 'bearer' } })?.id).toBe('bexio');
  });

  // Once the exchange is on, a profile on a store is the store preset's or nothing.
  const claimed = (base_url: string, auth?: { type: string; oauth?: { preset_id?: string } }) =>
    presetNotFollowed({ base_url, ...(auth === undefined ? {} : { auth }) }, OAUTH_PRESETS, { storesClaimed: true })?.id;

  it.each([
    ['a pasted token', 'https://my-store.myshopify.com/admin/api/2025-10', { type: 'bearer' }],
    ['a header of its own', 'https://my-store.myshopify.com', { type: 'header' }],
    ['no auth', 'https://my-store.myshopify.com', undefined],
    ['another provider\'s id', 'https://my-store.myshopify.com', { type: 'oauth2', oauth: { preset_id: 'bexio' } }],
    ['the host with a root dot', 'https://my-store.myshopify.com./admin', { type: 'bearer' }],
    ['the host in capitals', 'https://MY-STORE.MYSHOPIFY.COM/admin', { type: 'bearer' }],
  ] as const)('with storesClaimed, holds %s on a store to shopify', (_label, base_url, auth) => {
    expect(claimed(base_url, auth)).toBe('shopify');
  });

  it.each([
    ['the profile that goes through shopify', 'https://my-store.myshopify.com', { type: 'oauth2', oauth: { preset_id: 'shopify' } }],
    // Hosts the template cannot build from a parameter the preset accepts.
    ['the apex', 'https://myshopify.com', { type: 'bearer' }],
    ['a store name with a dot', 'https://a.b.myshopify.com', { type: 'bearer' }],
    ['a store name that starts with a hyphen', 'https://-x.myshopify.com', { type: 'bearer' }],
    ['a host that only ends like a store', 'https://evilmyshopify.com', { type: 'bearer' }],
    ['a host no provider claims', 'https://api.crm.example', { type: 'bearer' }],
  ] as const)('with storesClaimed, holds nothing for %s', (_label, base_url, auth) => {
    expect(claimed(base_url, auth)).toBeUndefined();
  });

  it('with storesClaimed, still names bexio for its own host', () => {
    expect(claimed('https://api.bexio.com', { type: 'bearer' })).toBe('bexio');
  });
});

// The page before a connect appears for the scopes in `writeScopes`, a second list next to
// `allowedScopes`: a write scope added to one and not the other would skip the page.
describe('the Shopify customer text', () => {
  const connect = (scope: string): ReturnType<typeof decideConnect> => decideConnect({
    authenticated: true, fetchSite: 'same-origin', fetchDest: 'document', httpSecretSet: true,
    profile: {
      id: 'shop', name: 'Shop', base_url: 'https://my-store.myshopify.com', description: 'Shop',
      auth: { type: 'oauth2', vault_keys: [], oauth: { preset_id: 'shopify', preset_params: { shop: 'my-store' }, scope } },
      custom_endpoint_ack: { accepted: true, hosts: ['my-store.myshopify.com'], redirect_hosts: ['my-store.myshopify.com'], accepted_at: '2026-10-28T00:00:00.000Z' },
    },
  }, OAUTH_PRESETS);

  it('covers every write scope the preset allows, no more and no fewer, and has no frame problem', () => {
    expect(shopify.consentNotice?.writeScopes).toEqual(shopify.allowedScopes.filter((s) => s.startsWith('write_')));
    expect(consentFrameProblems(shopify.consentNotice!)).toEqual([]);
  });

  // `decideConnect` takes no existing grant, so a reconnect decides the same way as a first link.
  it('comes before a link that asks for write_products and not before a read-only one', () => {
    const writing = connect('read_products write_products');
    expect(isRefusal(writing)).toBe(false);
    if (isRefusal(writing)) return;
    expect(writing.consent?.writeScopes).toEqual(['write_products']);
    expect(writing.consent?.frame?.title).toBe('Schreibrechte für Shopify bestätigen');
    const reading = connect('read_products');
    expect(isRefusal(reading)).toBe(false);
    if (isRefusal(reading)) return;
    expect(reading).not.toHaveProperty('consent');
  });

  // The text says lynox asks for no write access to orders, customers or stock. Such a scope may
  // not come into the list without a new text.
  it('allows no write scope for orders, customers or stock', () => {
    expect(shopify.consentNotice?.paragraphs.join(' ')).toContain('Bestellungen, Kunden, Lagerbestand und Versand kann lynox höchstens lesen; Schreibrechte dafür fragt es bei Shopify gar nicht an.');
    expect(shopify.allowedScopes.filter((s) => /^write_(orders|all_orders|customers|inventory|fulfillments)/.test(s))).toEqual([]);
  });

  // The text names the fields a bulk run writes with this scope: those of the engine's product
  // write form. A field added to the form fails here, and the text needs a new approval.
  it('names exactly the fields the engine\'s Shopify product write form sets', () => {
    const named: Record<string, string> = { title: 'Titel', descriptionHtml: 'Beschreibung', seo_title: 'SEO-Titel', seo_description: 'SEO-Beschreibung' };
    const order = ['title', 'descriptionHtml', 'seo_title', 'seo_description'];
    for (const f of SHOPIFY_WRITABLE_FIELDS) expect(named[f], `a name for ${f}`).toBeDefined();
    const fields = order.filter((f) => SHOPIFY_WRITABLE_FIELDS.includes(f)).map((f) => named[f]);
    const list = `${fields.slice(0, -1).join(', ')} und ${fields[fields.length - 1]}`;
    expect(shopify.consentNotice?.paragraphs[1]).toContain(`Ein Massenlauf ändert nur Texte bestehender Produkte: ${list}.`);
  });

  // The image form writes alt texts through `fileUpdate`, which Shopify grants only with
  // `write_files` or `write_themes`. Without either scope the text may not promise alt texts.
  it('promises no image alt texts while the preset allows no scope that writes them', () => {
    expect(SHOPIFY_MEDIA_WRITABLE_FIELDS).toEqual(['alt']);
    expect(shopify.allowedScopes.filter((s) => s === 'write_files' || s === 'write_themes')).toEqual([]);
    const text = [...shopify.consentNotice!.paragraphs, ...Object.values(shopify.consentNotice!.frame ?? {})].join(' ');
    expect(text).not.toMatch(/Alt-Text|Bild/);
  });

  // The words the owner reads, byte for byte. A change to one needs a new approval; this test is
  // the reminder, as bexio's is.
  it('holds the customer text byte for byte', () => {
    expect(shopify.consentNotice?.paragraphs).toEqual([
      'lynox kann in deinem Shopify-Store Produkte ändern, wenn du es beim Verbinden erlaubst. Ohne deine Erlaubnis liest lynox nur. Jeden Schreibschritt zeigt lynox vorher der Person, für die es gerade arbeitet, mit allem, was lynox an Shopify schickt. Das kann auch jemand sein, dem der Inhaber dieser lynox-Instanz Zugang gegeben hat. Der Schritt geschieht erst nach einem Ja dieser Person oder des Inhabers; das Ja einer Person mit Zugang gilt für diese Verbindung, und lynox protokolliert jede solche Anfrage. Ohne ein solches Ja schreibt lynox nicht in Shopify, auch nicht in einem geplanten Ablauf: Dort wartet der Schritt auf die Antwort, und kommt keine, unterbleibt er.',
      'Die eine Ausnahme ist ein Massenlauf: Vorher zeigt lynox die Liste aller Änderungen, und der Inhaber bestätigt den Lauf. Zuerst schreibt lynox eine einzige Änderung, die der Inhaber bestätigen muss, bevor der Rest folgt. Danach schreibt lynox die bestätigten Änderungen, ohne bei jeder einzeln zu fragen. Ein Massenlauf ändert nur Texte bestehender Produkte: Titel, SEO-Titel und SEO-Beschreibung. Anlegen, löschen oder Preise ändern kann er nicht.',
      'Bestellungen, Kunden, Lagerbestand und Versand kann lynox höchstens lesen; Schreibrechte dafür fragt es bei Shopify gar nicht an.',
    ]);
    expect(shopify.consentNotice?.frame).toEqual({
      title: 'Schreibrechte für Shopify bestätigen',
      scopesIntro: 'Mit dieser Verbindung erlaubst du lynox in Shopify:',
      scopesNote: 'Ein Schreibzugriff gilt bei Shopify für alle Produkte und Kollektionen, also etwa anlegen, ändern und löschen, auch Preise und Varianten. Das Recht ist damit breiter als das, was lynox damit tut.',
      button: 'Zustimmen und weiter zu Shopify',
      afterButton: 'Willst du nicht zustimmen, schliess diese Seite. Dann bekommt lynox keine neuen Rechte in Shopify.',
    });
    expect(shopify.consentNotice?.scopeNames).toEqual({ write_products: 'Produkte: Schreibzugriff' });
  });
});
