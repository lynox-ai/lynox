/**
 * Markdown → spoken-text sanitizer.
 *
 * Raw assistant replies are Markdown. Reading them verbatim through a TTS
 * engine produces "asterisk-asterisk" for bold, URLs read character-by-character,
 * code fences as noise. This module flattens Markdown to a spoken-friendly
 * form, preserving punctuation for prosody.
 *
 * Phase 0 finding (voice-tts.md, 2026-04-16): prosody scales with input length.
 * Short replies read flatter than long ones because the model plans intonation
 * over the whole input. Preferring spoken connectors over terse bullet lists
 * partially offsets this.
 */

/**
 * Flatten Markdown-ish assistant output into text a TTS can read cleanly.
 * Pure function. No throws. Empty input returns empty string.
 */
export function prepareForSpeech(input: string): string {
  if (!input) return '';
  let text = input;

  text = text.replace(/```[\s\S]*?```/g, '. ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/`+/g, '');

  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');

  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  text = text.replace(/https?:\/\/\S+/g, ' ');

  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/(?<![*_])[*_]([^*_\n]+)[*_](?![*_])/g, '$1');

  text = text.replace(/^\s*>\s?/gm, '');

  text = text.replace(/<[^>]+>/g, ' ');

  text = flattenLists(text);

  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\n{2,}/g, '. ');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/([,.;:!?]){2,}/g, '$1');

  return text.trim();
}

/**
 * Collapse bullet/numbered lists into comma- and "und"-joined sentences so TTS
 * prosody doesn't lurch at every bullet. Non-list lines pass through untouched.
 */
function flattenLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let runStart = -1;

  const flushRun = (endExclusive: number): void => {
    if (runStart < 0) return;
    const items = lines
      .slice(runStart, endExclusive)
      .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter((l) => l.length > 0);
    if (items.length > 0) out.push(joinItems(items));
    runStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      if (runStart < 0) runStart = i;
    } else {
      flushRun(i);
      out.push(line);
    }
  }
  flushRun(lines.length);
  return out.join('\n');
}

function joinItems(items: string[]): string {
  if (items.length === 1) return ensureSentenceEnd(items[0]!);
  const last = items[items.length - 1]!;
  const rest = items.slice(0, -1).map(stripTrailingPunct);
  return `${rest.join(', ')} und ${stripTrailingPunct(last)}.`;
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?]+$/, '').trim();
}

function ensureSentenceEnd(s: string): string {
  return /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}
