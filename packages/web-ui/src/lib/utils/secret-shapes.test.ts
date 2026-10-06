import { describe, it, expect } from 'vitest';
import { looksLikeSecret } from './secret-shapes.js';

// Values are assembled at runtime so no scanner mistakes this file for a leak,
// and written independently of the shape list so the list cannot vouch for itself.
describe('looksLikeSecret — chat input guard', () => {
  it.each([
    ['OpenAI project key', 'sk-' + 'proj-' + 'Ab12_Cd34-' + 'A'.repeat(16)],
    ['OpenAI service-account key', 'sk-' + 'svcacct-' + 'B'.repeat(24)],
    ['Anthropic key', 'sk-' + 'ant-api03-' + 'C'.repeat(24)],
    ['Stripe key', 'sk_' + 'live_' + 'D'.repeat(20)],
    ['GitHub fine-grained token', 'github_pat_' + 'E'.repeat(24)],
    ['Slack token', 'xox' + 'b-' + '1234567890-' + 'F'.repeat(12)],
    ['AWS key', 'AKIA' + 'G'.repeat(16)],
    ['Google OAuth token', 'ya29.' + 'Z'.repeat(24)],
    ['private key block', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'],
    ['JWT', 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'H'.repeat(20)],
    // A key followed directly by a word character is still a key.
    ['key followed by a word character', 'sk-' + 'I'.repeat(24) + '_old'],
    // Glued to an identifier in front: `\b` saw no boundary after the `_`.
    ['key glued to an identifier', 'LYNOX_' + 'sk-' + 'ant-api03-' + 'J'.repeat(24)],
    ['GitHub token glued to an identifier', 'foo_' + 'ghp_' + 'K'.repeat(34) + '42'],
    ['key after a JSON escape', 'my key:\\n' + 'sk-' + 'ant-api03-' + 'M'.repeat(24)],
    ['AWS key with a suffix glued on', 'AKIA' + 'L'.repeat(16) + '_PROD'],
  ])('rejects a pasted %s', (_name, value) => {
    expect(looksLikeSecret(`here it is: ${value} thanks`)).toBe(true);
  });

  it.each([
    'Can you summarise last week’s invoices?',
    'see task-abcdefghij1234567890xyz for details',
    'the risk_test_coverage2026abcdef report',
    'if has_github_pat_configured then',
    'https://example.com/docs?page=2',
  ])('lets ordinary text through: %s', (text) => {
    expect(looksLikeSecret(text)).toBe(false);
  });
});
