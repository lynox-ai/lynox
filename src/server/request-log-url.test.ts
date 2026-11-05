import { describe, expect, it } from 'vitest';
import { requestLogUrl } from './request-log-url.js';

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

  it('drops the fragment, and leaves a URL without a query as it is', () => {
    expect(requestLogUrl('/a?b=1#frag')).toBe('/a?b=<redacted>');
    expect(requestLogUrl('/a#frag')).toBe('/a');
    expect(requestLogUrl('/api/health')).toBe('/api/health');
    expect(requestLogUrl('/api/health?')).toBe('/api/health');
    expect(requestLogUrl('/a?&&')).toBe('/a');
  });
});
