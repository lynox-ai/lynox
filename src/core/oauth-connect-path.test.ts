import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OAUTH_CONNECT_PATH } from './oauth-connect-path.js';

/**
 * The web UI's "Reconnect" button points at the engine's connect route through a twin of this
 * constant (the UI does not import engine code). The twin plus the UI's API base `/api` must be
 * this path, or the button leads nowhere.
 */
describe('the connect path the web UI links to is the engine\'s', () => {
  it('"/api" + the web UI\'s segment equals the engine\'s path', () => {
    const twin = readFileSync(fileURLToPath(new URL('../../packages/web-ui/src/lib/oauth-connect-path.ts', import.meta.url)), 'utf8');
    const segment = /export const OAUTH_CONNECT_SEGMENT = '([^']+)';/.exec(twin)?.[1];
    expect(segment).toBeDefined();
    expect(`/api${segment}`).toBe(OAUTH_CONNECT_PATH);
  });
});
