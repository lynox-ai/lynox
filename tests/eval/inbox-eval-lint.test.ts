// === inbox-eval-lint unit tests ===
//
// Pins the brand-vs-person heuristic + the dangerous-domain canary.
// Imports the lint function directly — no subprocess, no fixture I/O.

import { describe, expect, it } from 'vitest';
import { lintCorpus, type Fixture } from '../../scripts/inbox-eval-lint.js';

function mk(over: Partial<Fixture> & { id: string }): Fixture {
  return {
    fromAddress: 'max.mustermann@acme.example',
    fromName: 'Max Mustermann',
    subject: 's',
    body: 'b',
    ...over,
  };
}

describe('inbox-eval-lint', () => {
  it('clean for a Mustermann + brand-only corpus', () => {
    const findings = lintCorpus([
      mk({ id: 'p1', fromAddress: 'max.mustermann@acme-corp.example', fromName: 'Max Mustermann' }),
      mk({ id: 'b1', fromAddress: 'newsletter@example-shop.example', fromName: 'Acme Shop' }),
      mk({ id: 'b2', fromAddress: 'support@acme-vendor.example', fromName: 'Acme Vendor Support' }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('rejects lynox.* / brandfusion.* domains', () => {
    const findings = lintCorpus([
      mk({ id: 'lynox', fromAddress: 'admin@lynox.cloud', fromName: 'Admin' }),
    ]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.reason).toMatch(/lynox/);
  });

  it('flags real-looking surnames on person-style senders', () => {
    const findings = lintCorpus([
      mk({ id: 'roland', fromAddress: 'roland.mueller@kunde.example', fromName: 'Roland Müller' }),
    ]);
    expect(findings.some((f) => f.where === 'fromName')).toBe(true);
  });

  it('does NOT flag brand-style fromName when sender is a role address', () => {
    const findings = lintCorpus([
      mk({ id: 'role', fromAddress: 'support@acme-vendor.example', fromName: 'Acme Vendor Support' }),
      mk({ id: 'news', fromAddress: 'newsletter@example-shop.example', fromName: 'Beispiel AG Marketing' }),
    ]);
    expect(findings).toHaveLength(0);
  });

  it('flags non-example top-level domains', () => {
    const findings = lintCorpus([
      mk({ id: 'tld', fromAddress: 'max.mustermann@somerandom.com', fromName: 'Max Mustermann' }),
    ]);
    expect(findings.some((f) => f.where === 'fromAddress')).toBe(true);
  });
});
