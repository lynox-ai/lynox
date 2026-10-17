// === Inbox eval corpus — labels follow the prompt's named examples ===
//
// The eval scores the classifier against these labels, so a label that contradicts an
// example the prompt itself names makes a model that follows the prompt look wrong. This
// reads the committed corpus offline (no LLM) and checks the examples that a pattern can
// recognise without judging the mail.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InboxEvalCorpus } from './inbox-classifier-runner.js';

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'inbox-classifier-fixtures.json'), 'utf8'),
) as InboxEvalCorpus;

/** A clock time as the corpus writes one: `2pm`, `10 am`, `14 Uhr`, `14.05. um 11:00`. */
const TIME = String.raw`(\d{1,2}(?::\d{2})?\s?(?:am|pm|uhr)|\d{1,2}\.\d{2}\.?\s+um\s+\d{1,2}:\d{2})`;
/** Two clock times joined by `or` / `oder` within one sentence: a choice between two slots. */
const TWO_SLOTS = new RegExp(`${TIME}[^.?!]{0,40}\\b(?:or|oder)\\b[^.?!]{0,40}${TIME}`, 'i');

describe('inbox eval corpus labels', () => {
  // prompt.ts, draft_ready: "Terminvorschlag … Beispiele: \"Hast du Zeit am Mittwoch?\" →
  // ja/nein-Antwort reicht". Picking one of two offered slots is that short answer.
  it('labels every request to pick one of two time slots draft_ready', () => {
    const slotRequests = corpus.fixtures.filter((f) => TWO_SLOTS.test(`${f.subject ?? ''} ${f.body ?? ''}`));
    // control: the pattern sees the meeting requests at all, both languages
    expect(slotRequests.map((f) => f.id)).toEqual(expect.arrayContaining(['meeting-request-en-315', 'meeting-request-de-316']));
    expect(slotRequests.filter((f) => f.expectedBucket !== 'draft_ready').map((f) => f.id)).toEqual([]);
  });
});
