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
    ['private key block', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'],
    ['JWT', 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'H'.repeat(20)],
    // A key followed directly by a word character is still a key.
    ['key followed by a word character', 'sk-' + 'I'.repeat(24) + '_old'],
  ])('rejects a pasted %s', (_name, value) => {
    expect(looksLikeSecret(`here it is: ${value} thanks`)).toBe(true);
  });

  it.each([
    'Can you summarise last week’s invoices?',
    'see task-abcdefghij1234567890xyz for details',
    'https://example.com/docs?page=2',
  ])('lets ordinary text through: %s', (text) => {
    expect(looksLikeSecret(text)).toBe(false);
  });
});
