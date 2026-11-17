import { afterEach, describe, expect, it } from 'vitest';
import { toolCallLabel } from './tool-call-label.js';
import { getLocale, setLocale, t } from '../i18n.svelte.js';

// The chat's tool line for api_setup, through the real translator: never the raw tool name.
describe('toolCallLabel with the real translator', () => {
  const before = getLocale();
  afterEach(() => setLocale(before));

  it.each([
    ['de', 'API-Profile'],
    ['en', 'API profiles'],
  ] as const)('labels api_setup in %s as %s', (locale, label) => {
    setLocale(locale);
    const out = toolCallLabel('api_setup', { action: 'view', id: 'bexio' }, t);
    expect(out).toEqual({ action: label, subject: 'bexio' });
    expect(out?.action).not.toContain('api_setup');
  });
});
