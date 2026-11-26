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
      'Die beobachtete Seite wurde nicht gelesen: sie ist keine http- oder https-Adresse.',
      'Die beobachtete Seite wurde nicht gelesen: die network_policy dieser Instanz ist deny-all, darum liest lynox keine Webseite. Nur der Betreiber kann network_policy ändern.',
      'Die beobachtete Seite wurde nicht gelesen: ihr Host other.example steht nicht in der Netzwerk-Allow-List dieser Instanz. Der Betreiber kann den Host in die Allow-List aufnehmen (network_policy).',
      'Die beobachtete Seite wurde nicht gelesen: diese Instanz liest nur HTTPS-Seiten (enforce_https). Beobachte stattdessen die https://-Adresse.',
      'Die beobachtete Seite wurde nicht gelesen: die Netzwerkeinstellungen dieser Instanz lassen die Seite nicht zu.',
    ]);
  });

  it('adds the https step after the way out, in each language', () => {
    expect(watchPolicyWordsEn({ kind: 'deny_all' }, true).wayOut).toBe('Only the operator can change network_policy. The address must also be https://, since this instance only reads HTTPS pages (enforce_https).');
    expect(watchPolicyWordsDe({ kind: 'deny_all' }, true).wayOut).toBe('Nur der Betreiber kann network_policy ändern. Die Adresse muss ausserdem mit https:// beginnen, weil diese Instanz nur HTTPS-Seiten liest (enforce_https).');
    expect(watchPolicyWordsDe({ kind: 'allow_list', host: 'h.example' }, false).wayOut).not.toContain('https://');
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
