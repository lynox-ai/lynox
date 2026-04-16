// === Body cleaning ===
//
// Wraps email-reply-parser to strip quoted history and trailing signatures
// from a plain-text mail body. The result is the "fresh" content the user
// actually wrote in this reply — typically 1–3 paragraphs instead of the
// full email chain.
//
// Only call this on plain-text bodies (provider.fetch already converts
// text/html → plain via a basic stripper). The PRD calls for "HTML→Markdown
// only if no text/plain part exists" — that conversion happens upstream.

import EmailReplyParser from 'email-reply-parser';

export interface CleanedBody {
  /** The user-authored content with quotes and signatures removed. */
  visible: string;
  /** Quoted history (chained replies, "On X wrote:" blocks). */
  quoted: string;
  /** Detected trailing signature, if any. */
  signature: string;
}

/**
 * Strip quoted history and signatures from a plain-text mail body.
 * Pure function — never throws on malformed input.
 */
export function cleanBody(text: string): CleanedBody {
  if (!text || text.trim().length === 0) {
    return { visible: '', quoted: '', signature: '' };
  }
  try {
    const parser = new EmailReplyParser();
    const email = parser.read(normalizeLineEndings(text));

    const visibleParts: string[] = [];
    const quotedParts: string[] = [];
    const signatureParts: string[] = [];

    for (const fragment of email.getFragments()) {
      const content = fragment.getContent();
      if (!content || fragment.isEmpty()) continue;
      if (fragment.isSignature()) {
        signatureParts.push(content);
        continue;
      }
      if (fragment.isQuoted()) {
        quotedParts.push(content);
        continue;
      }
      visibleParts.push(content);
    }

    return {
      visible: collapseBlankLines(visibleParts.join('\n').trim()),
      quoted: collapseBlankLines(quotedParts.join('\n').trim()),
      signature: collapseBlankLines(signatureParts.join('\n').trim()),
    };
  } catch {
    // Defensive — on parser error, return the raw body as visible content.
    return { visible: text.trim(), quoted: '', signature: '' };
  }
}

/**
 * Convenience wrapper: just the visible text. Used by mail_read tool to keep
 * the agent's view of the body small.
 */
export function visibleBody(text: string): string {
  return cleanBody(text).visible;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}
