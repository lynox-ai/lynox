import { describe, it, expect } from 'vitest';
import { watchPolicyWordsDe, watchPolicyWordsEn, type WatchPolicyReason } from './watch-policy-reason.js';
import { watchPolicyRefusal } from './task-manager.js';
import { WORKER_NOTICES } from './worker-notices.js';

// A watch the network policy keeps from its page is told at the poll in the instance language,
// with the way out each reason names; the setting names stay as the operator writes them.

const REASONS: readonly WatchPolicyReason[] = [
  { kind: 'protocol' },
  { kind: 'deny_all' },
  { kind: 'allow_list', host: 'other.example' },
  { kind: 'https' },
  { kind: 'other', detail: 'network access denied (unrecognised egress policy)' },
];

describe('watch policy refusal words', () => {
  it('words every reason in English as the poll told it before, and in German', () => {
    expect(REASONS.map((r) => WORKER_NOTICES.en.watchPolicyRefused(r, false))).toEqual([
      'The watched page was not read: it is not an http or https address.',
      "The watched page was not read: this instance's network_policy is deny-all, so lynox reads no web page. Only the operator can change network_policy.",
      "The watched page was not read: its host other.example is not in this instance's network allow-list. The operator can add the host to the allow-list (network_policy).",
      'The watched page was not read: this instance only reads HTTPS pages (enforce_https). Watch the https:// address instead.',
      "The watched page was not read: this instance's network settings refuse it: network access denied (unrecognised egress policy).",
    ]);
    expect(REASONS.map((r) => WORKER_NOTICES.de.watchPolicyRefused(r, false))).toEqual([
      'Die beobachtete Seite wurde nicht gelesen: Die Adresse ist keine http- oder https-Adresse.',
      'Die beobachtete Seite wurde nicht gelesen: Diese Instanz liest keine Webseiten (network_policy: deny-all). Ändern kann das nur der Betreiber der Instanz.',
      'Die beobachtete Seite wurde nicht gelesen: Der Host other.example steht nicht in der Netzwerk-Liste dieser Instanz (network_policy). Aufnehmen kann ihn der Betreiber der Instanz.',
      'Die beobachtete Seite wurde nicht gelesen: Diese Instanz liest nur https-Seiten (enforce_https). Bitte lynox im Chat, die Beobachtung auf die https-Adresse umzustellen.',
      'Die beobachtete Seite wurde nicht gelesen: Die Netzwerkeinstellungen dieser Instanz lassen diese Seite nicht zu. Ändern kann das der Betreiber der Instanz.',
    ]);
  });

  it('adds the https step after the way out, in each language', () => {
    expect(watchPolicyWordsEn({ kind: 'deny_all' }, true).wayOut).toBe('Only the operator can change network_policy. The address must also be https://, since this instance only reads HTTPS pages (enforce_https).');
    expect(watchPolicyWordsDe({ kind: 'deny_all' }, true).wayOut).toBe('Ändern kann das nur der Betreiber der Instanz. Ausserdem muss die Adresse mit https:// beginnen, weil diese Instanz nur https-Seiten liest (enforce_https).');
    expect(watchPolicyWordsDe({ kind: 'allow_list', host: 'h.example' }, false).wayOut).not.toContain('https://');
    // Through the notice table, as the poll records it.
    expect(WORKER_NOTICES.en.watchPolicyRefused({ kind: 'deny_all' }, true)).toBe("The watched page was not read: this instance's network_policy is deny-all, so lynox reads no web page. Only the operator can change network_policy. The address must also be https://, since this instance only reads HTTPS pages (enforce_https).");
    expect(WORKER_NOTICES.en.watchPolicyRefused({ kind: 'allow_list', host: 'h.example' }, true)).toBe("The watched page was not read: its host h.example is not in this instance's network allow-list. The operator can add the host to the allow-list (network_policy). The address must also be https://, since this instance only reads HTTPS pages (enforce_https).");
    expect(WORKER_NOTICES.de.watchPolicyRefused({ kind: 'allow_list', host: 'h.example' }, true)).toBe('Die beobachtete Seite wurde nicht gelesen: Der Host h.example steht nicht in der Netzwerk-Liste dieser Instanz (network_policy). Aufnehmen kann ihn der Betreiber der Instanz. Ausserdem muss die Adresse mit https:// beginnen, weil diese Instanz nur https-Seiten liest (enforce_https).');
  });

  it('keeps the host check\'s English words out of the German sentence', () => {
    const detail = 'hostname "evil.example" not permitted under some policy';
    const de = WORKER_NOTICES.de.watchPolicyRefused({ kind: 'other', detail }, false);
    expect(de).not.toContain('evil.example');
    expect(de).not.toContain('not permitted');
    expect(WORKER_NOTICES.en.watchPolicyRefused({ kind: 'other', detail }, false)).toContain(detail);
  });

  it('reads the reason from the host check, with an address that is not http or https as its own kind', () => {
    const ctx = { networkPolicy: 'allow-list' as const, allowedHosts: new Set(['listed.example']), allowedWildcards: [] as string[], enforceHttps: false };
    expect(watchPolicyRefusal('ftp://listed.example/p', ctx)).toEqual({ why: 'it is not an http or https address.', wayOut: '', reason: { kind: 'protocol' }, shown: null });
    expect(watchPolicyRefusal('https://other.example/p', ctx)?.reason).toEqual({ kind: 'allow_list', host: 'other.example' });
    expect(watchPolicyRefusal('https://listed.example/p', ctx)).toBeNull();
  });
});
