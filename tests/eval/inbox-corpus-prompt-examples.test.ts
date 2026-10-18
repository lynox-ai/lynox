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
    // control: the whole family is there (40 fixtures), both languages
    expect(family).toHaveLength(40);
    expect(family.map((f) => f.id)).toEqual(expect.arrayContaining(['meeting-request-en-315', 'meeting-request-de-316']));
    expect(family.filter((f) => f.expectedBucket !== 'draft_ready').map((f) => f.id)).toEqual([]);
  });

  // Outside the meeting-request family the shape is not uniform, so the corpus was read against
  // one written rule (the first `operatorRelabels` entry dated 2026-10-17 that starts "Rule for
  // draft_ready vs requires_user"): a short answer the recipient knows without looking anything up
  // is draft_ready. These fixtures changed label under it; reverting one must be a decision in a
  // diff, not a silent edit.
  it('keeps the fixtures relabelled under the short-answer rule at draft_ready', () => {
    const byId = new Map(corpus.fixtures.map((f) => [f.id, f.expectedBucket]));
    // control: every id is in the corpus
    expect(SHORT_ANSWER_RULE_RELABELS.filter((id) => !byId.has(id))).toEqual([]);
    expect(SHORT_ANSWER_RULE_RELABELS.filter((id) => byId.get(id) !== 'draft_ready')).toEqual([]);
  });
});

const SHORT_ANSWER_RULE_RELABELS: ReadonlyArray<string> = [
  'colleague-question-de-276',
  'colleague-question-de-278',
  'colleague-question-de-280',
  'colleague-question-de-284',
  'info-share-en-402',
  'urgent-deadline-en-464',
];
