import { describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_VERSION, classifyMail, type LLMCaller } from './index.js';

function fakeLLM(reply: string): LLMCaller {
  return vi.fn(async () => reply);
}

const baseInput = {
  accountAddress: 'me@acme.example',
  accountDisplayName: 'Me (Acme)',
  subject: 'Vorschlag für nächste Woche',
  fromAddress: 'mustermann@example.com',
  fromDisplayName: 'Max Mustermann',
  body: 'Hi Me, hast du Zeit am Mittwoch für ein Strategie-Gespräch?',
};

describe('classifyMail', () => {
  it('returns the parsed verdict on a happy-path response', async () => {
    const llm = fakeLLM(
      JSON.stringify({
        bucket: 'requires_user',
        confidence: 0.92,
        one_line_why_de: 'Kunde fragt nach Termin am Mittwoch',
      }),
    );
    const out = await classifyMail(baseInput, llm);
    expect(out.bucket).toBe('requires_user');
    expect(out.confidence).toBe(0.92);
    expect(out.reasonDe).toBe('Kunde fragt nach Termin am Mittwoch');
    expect(out.failReason).toBeNull();
    expect(out.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(out.bodyTruncated).toBe(false);
  });

  it('passes both system and user prompts to the LLM', async () => {
    const llm = vi.fn<LLMCaller>(async () =>
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'r' }),
    );
    await classifyMail(baseInput, llm);
    expect(llm).toHaveBeenCalledTimes(1);
    const call = llm.mock.calls[0]![0];
    expect(call.system).toContain('lynox');
    // Account context (trusted) stays outside the untrusted_data block.
    expect(call.user).toContain('Empfänger-Postfach: Me (Acme) <me@acme.example>');
    // Sender + subject + body now sit inside the untrusted_data block so a
    // crafted subject can't bleed into the trusted framing.
    expect(call.user).toContain('<untrusted_data source="mail-classifier">');
    expect(call.user).toContain('Absender: Max Mustermann <mustermann@example.com>');
    expect(call.user).toContain('</untrusted_data>');
    expect(call.user).toContain('Strategie-Gespräch');
    // Belt-and-braces: the trusted account line must NOT appear inside the
    // wrap (otherwise we leaked trusted context into the attacker's
    // surface).
    const matched = call.user.match(/<untrusted_data[^>]*>([\s\S]*?)<\/untrusted_data>/);
    expect(matched?.[1]).not.toContain('Empfänger-Postfach');
  });

  it('forwards the abort signal to the LLM caller', async () => {
    const controller = new AbortController();
    const llm = vi.fn<LLMCaller>(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      return JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'k' });
    });
    await classifyMail(baseInput, llm, { signal: controller.signal });
    expect(llm).toHaveBeenCalled();
  });

  it('falls back to requires_user when the LLM returns nonsense', async () => {
    const llm = fakeLLM('lol no json');
    const out = await classifyMail(baseInput, llm);
    expect(out.bucket).toBe('requires_user');
    expect(out.failReason).toBe('json_parse_error');
  });

  it('reports body truncation when the body exceeds the cap', async () => {
    const llm = fakeLLM(
      JSON.stringify({ bucket: 'requires_user', confidence: 0.8, one_line_why_de: 'lang' }),
    );
    const out = await classifyMail(
      { ...baseInput, body: 'x'.repeat(20_000) },
      llm,
    );
    expect(out.bodyTruncated).toBe(true);
  });

  it('lets network errors from the LLM propagate to the caller', async () => {
    const llm: LLMCaller = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(classifyMail(baseInput, llm)).rejects.toThrow('ECONNRESET');
  });

  it('writes a custom classifier version when overridden', async () => {
    const llm = fakeLLM(
      JSON.stringify({ bucket: 'auto_handled', confidence: 0.9, one_line_why_de: 'k' }),
    );
    const out = await classifyMail(baseInput, llm, { classifierVersion: 'haiku-test-1' });
    expect(out.classifierVersion).toBe('haiku-test-1');
  });
});
