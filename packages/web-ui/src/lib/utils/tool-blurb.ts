/**
 * Turn a registry tool `description` (written FOR THE LLM, full of agent-only
 * jargon) into a clean one-line blurb for the human-facing Settings → Tools
 * list. Takes the first sentence and drops the LLM-facing tail — e.g.
 * "...gated behind `api-setup-v2` flag; runs a single Haiku extraction...",
 * "NEVER use for file reads/writes", "unrecognised roles error out".
 *
 * Falls back to a length-capped slice when the first "sentence" is just an
 * abbreviation (too short to be a real summary).
 */
export function toolBlurb(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const firstSentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0]?.trim() ?? '';
  if (firstSentence.length >= 25 && firstSentence.length <= 200) return firstSentence;
  return text.length > 160 ? text.slice(0, 159).trimEnd() + '…' : text;
}
