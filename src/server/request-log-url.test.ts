import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_LOGGED_PATH, requestLogUrl } from './request-log-url.js';

describe('requestLogUrl', () => {
  it('keeps the path and the parameter names and replaces every value', () => {
    expect(requestLogUrl('/app/settings/channels/google?google_oauth=abc123&tab=x'))
      .toBe('/app/settings/channels/google?google_oauth=<redacted>&tab=<redacted>');
  });

  it('replaces a value of any parameter, not only known ones', () => {
    expect(requestLogUrl('/api/anything?some_new_param=secret-value')).toBe('/api/anything?some_new_param=<redacted>');
  });

  it('replaces an entry without a name whole', () => {
    expect(requestLogUrl('/x?bare-token-value&a=1')).toBe('/x?<redacted>&a=<redacted>');
  });

  it('replaces a name that does not look like one', () => {
    expect(requestLogUrl('/x?%73ecret%3D=1')).toBe('/x?<redacted>=<redacted>');
    expect(requestLogUrl(`/x?${'n'.repeat(80)}=1`)).toBe('/x?<redacted>=<redacted>');
  });

  it('still takes a webhook route token out of the path', () => {
    expect(requestLogUrl('/api/webhooks/tok3n?topic=orders')).toBe('/api/webhooks/<redacted>?topic=<redacted>');
  });

  it('replaces an address in a path segment and masks a secret shape', () => {
    expect(requestLogUrl('/api/inbox/contacts/jane.doe%40customer.ch')).toBe('/api/inbox/contacts/<address>');
    for (const p of ['/c/jane@customer.ch', '/c/jane%2540customer.ch', '/c/jane%EF%BC%A0customer.ch', '/c/jane%2Fdoe%40x.ch/more']) {
      expect(requestLogUrl(p)).not.toMatch(/jane/);
    }
    const key = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;
    expect(requestLogUrl(`/api/memory/${key}`)).not.toContain(key);
    expect(requestLogUrl('/api/threads/abc-123')).toBe('/api/threads/abc-123');
    const opaque = 'Ab3dEfGh'.repeat(6);
    expect(requestLogUrl(`/api/memory/${opaque}`)).not.toContain(opaque);
    expect(requestLogUrl('/c/jane%ef%bc%a0customer.ch')).toBe('/c/<address>');
  });

  // Every route that takes a contact in the path below /api/crm/contacts/, read from the route
  // table's source in any registration form, so a route added later is checked as well. The
  // row-id route (`:id`) names no one and is checked below.
  const crmContactRoutes = [...readFileSync(new URL('./http-api.ts', import.meta.url), 'utf8')
    .matchAll(/['`](\/api\/crm\/contacts\/:([A-Za-z]+)[^'`]*)['`]/g)]
    .filter((m) => m[2] !== 'id')
    .map((m) => m[1]!.replace(/:[A-Za-z]+/, ':name'));

  it('finds the CRM routes that name a contact in the path', () => {
    expect(crmContactRoutes).toEqual(expect.arrayContaining(['/api/crm/contacts/:name/interactions', '/api/crm/contacts/:name/deals']));
  });

  it.each(crmContactRoutes)('writes the contact of %s as a placeholder', (route) => {
    const written = route.replace(':name', '<contact>');
    for (const name of ['Jane%20Doe', 'M%C3%BCller', 'Jane', '42a', 'Jane%3Fx', 'Jane%2Fdoe']) {
      const url = route.replace(':name', name);
      expect(requestLogUrl(url)).toBe(written);
      expect(requestLogUrl(`${url}/`)).toBe(`${written}/`);
      expect(requestLogUrl(`${url}?limit=5`)).toBe(`${written}?limit=<redacted>`);
    }
  });

  // The router reads the path through `URL` and accepts `/api/v1/` for `/api/`; each of these
  // reaches the deals route of the contact Jane.
  it.each([
    ['/api/v1/crm/contacts/Jane/deals', '/api/v1/crm/contacts/<contact>/deals'],
    ['//host/api/crm/contacts/Jane/deals', '/api/crm/contacts/<contact>/deals'],
    ['http://host/api/crm/contacts/Jane/deals', '/api/crm/contacts/<contact>/deals'],
    ['/api/crm/./contacts/Jane/deals', '/api/crm/contacts/<contact>/deals'],
    ['/api/crm/x/../contacts/Jane/deals', '/api/crm/contacts/<contact>/deals'],
    ['/api/crm/contacts/./Jane/deals', '/api/crm/contacts/<contact>/deals'],
    ['/api/crm/contacts/%2e/Jane/deals', '/api/crm/contacts/<contact>/deals'],
    ['/api\\crm\\contacts\\Jane\\deals', '/api/crm/contacts/<contact>/deals'],
  ])('writes the contact as a placeholder when %s reaches the route', (url, written) => {
    expect(requestLogUrl(url)).toBe(written);
  });

  it('keeps the contact row id and the list route as they are', () => {
    expect(requestLogUrl('/api/crm/contacts/17')).toBe('/api/crm/contacts/17');
    expect(requestLogUrl('/api/crm/contacts/')).toBe('/api/crm/contacts/');
    expect(requestLogUrl('/api/crm/contacts?limit=5')).toBe('/api/crm/contacts?limit=<redacted>');
    expect(requestLogUrl('/api/crm/deals')).toBe('/api/crm/deals');
    expect(requestLogUrl('/api/inbox/contacts/Jane')).toBe('/api/inbox/contacts/Jane');
  });

  it('replaces everything after an encoded question mark in the path', () => {
    expect(requestLogUrl('/x%3Ftoken=s3cret')).toBe('/x%3F<redacted>');
    expect(requestLogUrl('/x%3ftoken=s3cret?a=1')).toBe('/x%3F<redacted>?a=<redacted>');
  });

  it('drops scheme and authority of an absolute-form target', () => {
    expect(requestLogUrl('http://user:pw@host/p?x=1')).toBe('/p?x=<redacted>');
  });

  it('replaces values behind a semicolon as part of the value', () => {
    expect(requestLogUrl('/a?a=1;t=s3cret')).toBe('/a?a=<redacted>');
  });

  it('writes a path past the bound as a placeholder, and one at the bound as sent', () => {
    expect(requestLogUrl(`/${'%E0'.repeat(MAX_LOGGED_PATH)}?a=1`)).toBe('<long path>?a=<redacted>');
    const atBound = `/${'a'.repeat(MAX_LOGGED_PATH - 1)}`;
    expect(requestLogUrl(atBound)).not.toBe('<long path>');
    expect(requestLogUrl(`${atBound}b`)).toBe('<long path>');
  });

  it('does not throw on broken escapes', () => {
    for (const p of ['/%', '/%E0%A4', '/%zz', '/%ED%A0%80', '/%C0%80']) expect(() => requestLogUrl(p)).not.toThrow();
  });

  it('writes the path undecoded, so it cannot pose as the other fields', () => {
    expect(requestLogUrl('/x%20404%201ms%0AGET%20/fake')).toBe('/x%20404%201ms%0AGET%20/fake');
    expect(requestLogUrl('/x%C2%A0y')).toBe('/x%C2%A0y');
  });

  it('takes the route token out behind an encoded separator', () => {
    expect(requestLogUrl('/api/webhooks%2Ftok3n')).toBe('/api/webhooks/<redacted>');
  });

  it('writes an empty path as a slash', () => {
    expect(requestLogUrl('HTTP://u:p@h')).toBe('/');
  });

  it('drops the fragment, and leaves a URL without a query as it is', () => {
    expect(requestLogUrl('/a?b=1#frag')).toBe('/a?b=<redacted>');
    expect(requestLogUrl('/a#frag')).toBe('/a');
    expect(requestLogUrl('/api/health')).toBe('/api/health');
    expect(requestLogUrl('/api/health?')).toBe('/api/health');
    expect(requestLogUrl('/a?&&')).toBe('/a');
  });
});
