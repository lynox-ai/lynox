/**
 * The Microsoft OAuth decline vocabulary and the handle-only claim
 * (`src/contract/http.ts`).
 *
 * Pinned as exact lists for the reason `contract-oauth-decline.test.ts` gives:
 * the control plane will send these codes and the web-ui will map each to a
 * message, and a code added on one side only reaches the user as the generic
 * text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  MICROSOFT_OAUTH_CLAIM_PARAM,
  MICROSOFT_OAUTH_DECLINE_CODES,
  MICROSOFT_OAUTH_ERROR_PARAM,
  MICROSOFT_OAUTH_START_ADDRESS_PARAM,
  OAUTH_DECLINE_CODES,
  isMicrosoftOAuthDeclineCode,
} from '../src/contract/http.js';
import { MIGRATED } from '../src/contract/migrated.js';
import { adminConsentStatusWelds, handleClaimWelds } from '../src/core/oauth-handle-claim-welds.js';

describe('the Microsoft decline vocabulary', () => {
  it('is the start failures, then the address, consent, directory and fallback codes, in that order', () => {
    expect([...MICROSOFT_OAUTH_DECLINE_CODES]).toEqual([
      'missing_token', 'expired', 'replayed', 'bad_signature', 'instance_unbound',
      'no_tenant', 'consumer_domain',
      'access_denied', 'consent_required',
      'not_assigned', 'policy_blocked', 'wrong_tenant',
      'exchange_failed',
    ]);
  });

  it('isMicrosoftOAuthDeclineCode accepts every member and nothing else', () => {
    for (const code of MICROSOFT_OAUTH_DECLINE_CODES) expect(isMicrosoftOAuthDeclineCode(code)).toBe(true);
    for (const other of ['AADSTS50105', 'interaction_required', 'NOT_ASSIGNED', '', ' wrong_tenant', undefined, null, 1]) {
      expect(isMicrosoftOAuthDeclineCode(other)).toBe(false);
    }
  });

  it('leaves the Google vocabulary as it was', () => {
    // The Microsoft list is a superset of the Google one; the reverse must stay false,
    // or a Google card would route on a code its control plane never sends.
    for (const code of OAUTH_DECLINE_CODES) expect(MICROSOFT_OAUTH_DECLINE_CODES).toContain(code);
    for (const code of ['no_tenant', 'consumer_domain', 'consent_required', 'not_assigned', 'policy_blocked', 'wrong_tenant']) {
      expect(OAUTH_DECLINE_CODES as readonly string[]).not.toContain(code);
    }
  });
});

describe('the new symbols are registered as migrated', () => {
  it('names all ten, owned by http.ts', () => {
    const rows = MIGRATED.filter((m) => m.contractFile === 'http.ts').map((m) => m.name);
    for (const name of [
      'OAuthHandleProvider', 'OAuthHandleClaimResponse', 'MICROSOFT_OAUTH_DECLINE_CODES', 'MicrosoftOAuthDeclineCode', 'isMicrosoftOAuthDeclineCode',
      'MICROSOFT_OAUTH_CLAIM_PARAM', 'MICROSOFT_OAUTH_ERROR_PARAM', 'AdminConsentStatusRequest', 'AdminConsentStatusResponse',
      'MICROSOFT_OAUTH_START_ADDRESS_PARAM',
    ]) {
      expect(rows, name).toContain(name);
    }
  });
});

describe('the handle-only claim', () => {
  it('has its compile welds in a file tsc reads', () => {
    // The welds are type-level; this import is what makes deleting their file fail.
    expect(typeof handleClaimWelds).toBe('function');
  });
});

describe('the Microsoft return parameters', () => {
  it('are microsoft_oauth and microsoft_oauth_error', () => {
    expect(MICROSOFT_OAUTH_CLAIM_PARAM).toBe('microsoft_oauth');
    expect(MICROSOFT_OAUTH_ERROR_PARAM).toBe('microsoft_oauth_error');
  });

  it('share no name with Google or with each other', () => {
    // Google's names live in the control plane's redirect and the web-ui's reader,
    // not in the contract; a shared name would let one card redeem the other's nonce.
    const google = ['google_oauth', 'google_oauth_error'];
    for (const name of [MICROSOFT_OAUTH_CLAIM_PARAM, MICROSOFT_OAUTH_ERROR_PARAM]) expect(google).not.toContain(name);
    expect(MICROSOFT_OAUTH_CLAIM_PARAM).not.toBe(MICROSOFT_OAUTH_ERROR_PARAM);
  });
});

describe('the work address on the Microsoft start', () => {
  it('is microsoft_work_address', () => {
    expect(MICROSOFT_OAUTH_START_ADDRESS_PARAM).toBe('microsoft_work_address');
  });

  it('shares no name with the return parameters or the start\'s own', () => {
    // The start already carries `instance_id` and `token`; the card reads the return names.
    for (const name of ['instance_id', 'token', MICROSOFT_OAUTH_CLAIM_PARAM, MICROSOFT_OAUTH_ERROR_PARAM, 'google_oauth', 'google_oauth_error']) {
      expect(MICROSOFT_OAUTH_START_ADDRESS_PARAM).not.toBe(name);
    }
  });
});

describe('the admin-consent status', () => {
  it('has its compile welds in a file tsc reads', () => {
    expect(typeof adminConsentStatusWelds).toBe('function');
  });
});

// The twin check in `migrated.ts` sees a re-declared NAME. A param name drifts by a
// re-typed STRING instead (the Google card reads `'google_oauth'` by hand), so the
// literal is swept for here: outside the contract, code imports the constant.
const PARAM_NAMES = String.raw`microsoft_oauth(?:_error)?|microsoft_work_address`;
// Quoted, as a template literal passed to a call, in a query string, or as an object key.
// A name in backticks inside a comment is a doc mention and stays allowed.
const PARAM_LITERAL = new RegExp(String.raw`['"](?:${PARAM_NAMES})['"]|\(\s*\`(?:${PARAM_NAMES})\`|[?&](?:${PARAM_NAMES})=|\b(?:${PARAM_NAMES})\s*:`);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'contract' ? [] : sourceFiles(path);
    return /\.(?:ts|js|mjs|svelte)$/.test(entry.name) ? [path] : [];
  });
}

describe('the Microsoft parameters are imported, never typed', () => {
  it('the sweep finds the literal in each form it is meant to catch, and not in a doc mention', () => {
    for (const line of [
      "params.get('microsoft_oauth')",
      'params.get("microsoft_oauth_error")',
      'c.redirect(`${url}?microsoft_oauth=${nonce}`)',
      'c.redirect(`${url}?x=1&microsoft_oauth_error=${code}`)',
      "c.req.query('microsoft_work_address')",
      'c.req.query(`microsoft_work_address`)',
      '`${cp}/oauth/microsoft/start?instance_id=${id}&microsoft_work_address=${encodeURIComponent(a)}`',
      'new URLSearchParams({ instance_id: id, microsoft_work_address: a })',
    ]) expect(PARAM_LITERAL.test(line), line).toBe(true);
    for (const line of [
      '// the card reads `microsoft_oauth` through the constant',
      'params.get(MICROSOFT_OAUTH_CLAIM_PARAM)',
      '// the start carries the user\'s address next to the token',
      "params.get('work_address')",
      "params.get('google_oauth')",
    ]) expect(PARAM_LITERAL.test(line), line).toBe(false);
  });

  it('no source file under src/ or packages/web-ui/src/ outside the contract types any of the names', () => {
    const files = [...sourceFiles('src'), ...sourceFiles('packages/web-ui/src')];
    // A walk that read nothing would pass; the two trees hold far more than this.
    expect(files.length).toBeGreaterThan(500);
    const hits = files.filter((file) => PARAM_LITERAL.test(readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });
});
