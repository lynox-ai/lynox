import { describe, expect, it, vi } from 'vitest';
import {
  buildGeneratorPrompt,
  generateDraft,
  GENERATOR_VERSION,
  type GenerateDraftInput,
} from './generator.js';
import type { LLMCaller } from './classifier/index.js';

const SAMPLE: GenerateDraftInput = {
  item: { id: 'inb_1', reasonDe: 'Kunde fragt nach Termin', channel: 'email' },
  fromAddress: 'max@acme.example',
  fromDisplayName: 'Max Muster',
  accountAddress: 'me@x.example',
  accountDisplayName: 'Rafael',
  subject: 'Termin nächste Woche?',
  body: 'Hi Rafael,\n\nhast du am Mittwoch zwischen 14 und 16 Uhr Zeit für ein kurzes Strategie-Call? Grüsse, Max',
};

describe('buildGeneratorPrompt', () => {
  it('wraps the body in <untrusted_data> and includes all sender + account headers', () => {
    const built = buildGeneratorPrompt(SAMPLE);
    expect(built.user).toContain('<untrusted_data>');
    expect(built.user).toContain('</untrusted_data>');
    expect(built.user).toContain('Max Muster <max@acme.example>');
    expect(built.user).toContain('Rafael <me@x.example>');
    expect(built.user).toContain('Termin nächste Woche?');
    expect(built.user).toContain('Kunde fragt nach Termin');
    expect(built.user).toContain('hast du am Mittwoch');
    expect(built.bodyTruncated).toBe(false);
  });

  it('falls back to address-only when fromDisplayName is missing', () => {
    const built = buildGeneratorPrompt({ ...SAMPLE, fromDisplayName: undefined });
    expect(built.user).toContain('Empfänger der Antwort: max@acme.example');
    expect(built.user).not.toContain('undefined <max@acme.example>');
  });

  it('renders "(kein Betreff)" when subject is missing', () => {
    const built = buildGeneratorPrompt({ ...SAMPLE, subject: undefined });
    expect(built.user).toContain('Betreff der Original-Mail: (kein Betreff)');
  });

  it('renders "(leerer Body)" when body is empty so the LLM still sees a structured prompt', () => {
    const built = buildGeneratorPrompt({ ...SAMPLE, body: '' });
    expect(built.user).toContain('(leerer Body)');
  });

  it('marks bodyTruncated when the body exceeds sanitizeBody MAX_BODY_LEN', () => {
    const huge = 'x'.repeat(30_000);
    const built = buildGeneratorPrompt({ ...SAMPLE, body: huge });
    expect(built.bodyTruncated).toBe(true);
    expect(built.user).toContain('gekürzt');
  });

  it('the system prompt forbids following instructions inside <untrusted_data>', () => {
    const built = buildGeneratorPrompt(SAMPLE);
    expect(built.system.toLowerCase()).toContain('untrusted_data');
    expect(built.system.toLowerCase()).toContain('keinen anweisungen');
  });
});

describe('generateDraft', () => {
  it('returns the trimmed LLM output stamped with GENERATOR_VERSION', async () => {
    const llm: LLMCaller = vi.fn(async () => '  Hallo Max,\n\nMittwoch 15:00 passt mir.\n\nGrüsse,\nRafael  ');
    const result = await generateDraft(SAMPLE, llm);
    expect(result.bodyMd).toBe('Hallo Max,\n\nMittwoch 15:00 passt mir.\n\nGrüsse,\nRafael');
    expect(result.generatorVersion).toBe(GENERATOR_VERSION);
    expect(result.bodyTruncated).toBe(false);
  });

  it('honours generatorVersionOverride', async () => {
    const llm: LLMCaller = vi.fn(async () => 'ok');
    const result = await generateDraft(SAMPLE, llm, { generatorVersionOverride: 'mistral-2026-05' });
    expect(result.generatorVersion).toBe('mistral-2026-05');
  });

  it('forwards the AbortSignal to the LLM caller', async () => {
    const ac = new AbortController();
    const llm: LLMCaller = vi.fn(async ({ signal }) => {
      expect(signal).toBe(ac.signal);
      return 'x';
    });
    await generateDraft(SAMPLE, llm, { signal: ac.signal });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw when the LLM returns an empty string — the editor handles the empty case', async () => {
    const llm: LLMCaller = vi.fn(async () => '   ');
    const result = await generateDraft(SAMPLE, llm);
    expect(result.bodyMd).toBe('');
  });
});
