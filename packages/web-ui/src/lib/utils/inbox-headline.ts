// === Synthesised headline for items with empty subjects ===
//
// Some senders (auto-replies, transactional bots, badly-configured forms)
// ship mail with no Subject header at all. Rendering "(kein Betreff)" as
// the card title hides the entire content of the mail from the user — they
// have to open the reading-pane just to find out what it's about, which
// defeats the at-a-glance triage promise of the inbox.
//
// Fallback hierarchy:
//   1. The real `subject` (when v11 envelope ingestion captured one)
//   2. The `snippet` first sentence trimmed to `MAX_HEADLINE_CHARS`
//   3. The classifier's `reasonDe` (always present)
//   4. The literal "(kein Betreff)" — only when all of the above are empty
//
// Note: this is UI-only. The DB still holds the original (possibly empty)
// subject. The Phase 4 decision-card redesign promotes this to a proper
// `card_headline` column generated at classify time.

const MAX_HEADLINE_CHARS = 70;

export interface HeadlineCandidate {
  subject?: string | undefined;
  snippet?: string | undefined;
  reasonDe?: string | undefined;
}

export function inboxHeadline(item: HeadlineCandidate): string {
  const subject = item.subject?.trim();
  if (subject && subject.length > 0) return subject;

  const snippet = item.snippet?.trim();
  if (snippet && snippet.length > 0) {
    // Take the first sentence-ish chunk so we don't render half a paragraph.
    // Falls back to a hard char-clamp when there's no sentence boundary.
    const sentenceEnd = snippet.search(/[.!?]\s/);
    const head = sentenceEnd > 0 && sentenceEnd < MAX_HEADLINE_CHARS
      ? snippet.slice(0, sentenceEnd + 1)
      : truncate(snippet, MAX_HEADLINE_CHARS);
    return head;
  }

  const reason = item.reasonDe?.trim();
  if (reason && reason.length > 0) return truncate(reason, MAX_HEADLINE_CHARS);

  return '(kein Betreff)';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
