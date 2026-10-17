// === Inbox eval corpus — the meeting-request family carries draft_ready ===
//
// The eval scores the classifier against these labels, so a label that contradicts the
// prompt makes a model that follows the prompt look wrong. The generator wrote the
// meeting-request family as requests to pick one of one or two slots for a short call
// (`scripts/inbox-eval-gen.ts`, hint draft_ready), and the prompt's draft_ready bucket names
// exactly that: "Terminvorschlag … \"Hast du Zeit am Mittwoch?\" → ja/nein-Antwort reicht".
// This reads the committed corpus offline (no LLM). It checks that one family only; it does
// not decide whether a mail outside it is a slot request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InboxEvalCorpus } from './inbox-classifier-runner.js';

const corpus = JSON.parse(
  readFileSync(join(__dirname, 'inbox-classifier-fixtures.json'), 'utf8'),
) as InboxEvalCorpus;

describe('inbox eval corpus labels', () => {
  it('labels every fixture of the meeting-request family draft_ready', () => {
    const family = corpus.fixtures.filter((f) => f.id.startsWith('meeting-request-'));
    // control: the family is there, both languages
    expect(family.map((f) => f.id)).toEqual(expect.arrayContaining(['meeting-request-en-315', 'meeting-request-de-316']));
    expect(family.filter((f) => f.expectedBucket !== 'draft_ready').map((f) => f.id)).toEqual([]);
  });
});
