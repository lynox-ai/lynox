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
  it('wraps subject + sender + body in <untrusted_data>; keeps trusted account context outside', () => {
    const built = buildGeneratorPrompt(SAMPLE);
    expect(built.user).toContain('<untrusted_data source="mail-generator">');
    expect(built.user).toContain('</untrusted_data>');
    expect(built.user).toContain('Max Muster <max@acme.example>');
    // Account identity (the receiving mailbox we trust) stays in the frame.
    expect(built.user).toContain('Rafael <me@x.example>');
    expect(built.user).toContain('Termin nächste Woche?');
    expect(built.user).toContain('Kunde fragt nach Termin');
    expect(built.user).toContain('hast du am Mittwoch');
    expect(built.bodyTruncated).toBe(false);

    // The attacker-controlled triplet (sender, subject, body) must all be
    // inside the wrap; trusted account + classifier reason must stay
    // outside it.
    const matched = built.user.match(/<untrusted_data[^>]*>([\s\S]*?)<\/untrusted_data>/);
    expect(matched?.[1]).toContain('Max Muster <max@acme.example>');
    expect(matched?.[1]).toContain('Termin nächste Woche?');
    expect(matched?.[1]).toContain('hast du am Mittwoch');
    expect(matched?.[1]).not.toContain('Antwortendes Postfach');
    expect(matched?.[1]).not.toContain('Klassifizierer-Kontext');
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

  it('strips a wrapping Markdown code fence when the model disobeys the no-fences instruction', async () => {
    const llm: LLMCaller = vi.fn(async () => '```text\nHallo Max,\n\nMittwoch passt.\n```');
    const result = await generateDraft(SAMPLE, llm);
    expect(result.bodyMd).toBe('Hallo Max,\n\nMittwoch passt.');
  });

  it('strips an unlabelled wrapping fence', async () => {
    const llm: LLMCaller = vi.fn(async () => '```\nHallo\n```');
    const result = await generateDraft(SAMPLE, llm);
    expect(result.bodyMd).toBe('Hallo');
  });

  it('leaves inline backticks untouched when no wrapping fence is present', async () => {
    const llm: LLMCaller = vi.fn(async () => 'Use the `--flag` switch.');
    const result = await generateDraft(SAMPLE, llm);
    expect(result.bodyMd).toBe('Use the `--flag` switch.');
  });

  it('propagates the LLM rejection — caller is responsible for the 5xx envelope', async () => {
    const llm: LLMCaller = vi.fn(async () => {
      throw new Error('429 Too Many Requests');
    });
    await expect(generateDraft(SAMPLE, llm)).rejects.toThrow('429');
  });

  it('uses the tone-rewrite template when previousBodyMd + tone are both set', async () => {
    let captured: { system: string; user: string } | null = null;
    const llm: LLMCaller = async ({ system, user }) => {
      captured = { system, user };
      return 'shortened';
    };
    await generateDraft(
      { ...SAMPLE, previousBodyMd: 'Hi Max,\n\nMittwoch 15 Uhr passt mir gut, danke!', tone: 'shorter' },
      llm,
    );
    expect(captured).not.toBeNull();
    expect(captured!.user).toContain('<previous_draft>');
    expect(captured!.user).toContain('Mittwoch 15 Uhr passt mir gut');
    expect(captured!.user).toContain('halbiere');
  });

  it('falls back to first-time generation when tone is set but previousBodyMd is missing', async () => {
    let captured: { user: string } | null = null;
    const llm: LLMCaller = async ({ user }) => {
      captured = { user };
      return 'x';
    };
    await generateDraft({ ...SAMPLE, tone: 'shorter' }, llm);
    expect(captured).not.toBeNull();
    expect(captured!.user).not.toContain('<previous_draft>');
    expect(captured!.user).toContain('Schreibe jetzt den Antwortentwurf');
  });

  it('falls back to first-time generation when previousBodyMd is set but tone is missing', async () => {
    let captured: { user: string } | null = null;
    const llm: LLMCaller = async ({ user }) => {
      captured = { user };
      return 'x';
    };
    await generateDraft({ ...SAMPLE, previousBodyMd: 'previous draft' }, llm);
    expect(captured).not.toBeNull();
    expect(captured!.user).not.toContain('<previous_draft>');
    // Also pin the first-time-template marker so a regression that
    // drops BOTH branches (e.g. truncates the prompt entirely) fails.
    expect(captured!.user).toContain('Schreibe jetzt den Antwortentwurf');
  });

  it('falls back to first-time generation when previousBodyMd is an empty string even if tone is set', async () => {
    let captured: { user: string } | null = null;
    const llm: LLMCaller = async ({ user }) => {
      captured = { user };
      return 'x';
    };
    await generateDraft({ ...SAMPLE, previousBodyMd: '', tone: 'shorter' }, llm);
    expect(captured).not.toBeNull();
    expect(captured!.user).not.toContain('<previous_draft>');
    expect(captured!.user).toContain('Schreibe jetzt den Antwortentwurf');
  });

  it('honours each tone modifier with its own instruction', async () => {
    const captured: string[] = [];
    const llm: LLMCaller = async ({ user }) => {
      captured.push(user);
      return 'x';
    };
    for (const tone of ['shorter', 'formal', 'warmer', 'regenerate'] as const) {
      await generateDraft(
        { ...SAMPLE, previousBodyMd: 'draft', tone },
        llm,
      );
    }
    expect(captured[0]).toContain('halbiere');
    expect(captured[1]).toContain('förmlicheren');
    expect(captured[2]).toContain('wärmeren');
    expect(captured[3]).toContain('alternative Antwort');
  });
});
