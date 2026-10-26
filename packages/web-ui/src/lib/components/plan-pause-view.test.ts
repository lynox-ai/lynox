import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A paused plan in the Triggers view (engine `plan-pause.ts`): the label, no next run, and Run
 * now's own refusal. The engine and the view have to agree on the code and the field; a test of
 * either alone cannot see a disagreement, as in `run-now-refusal-i18n.test.ts` beside it.
 * Source-level: a Svelte component cannot be imported in vitest here.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VIEW = readFileSync(`${HERE}TriggersView.svelte`, 'utf8');
const I18N = readFileSync(`${HERE}../i18n.svelte.ts`, 'utf8');
const ROUTE = readFileSync(`${HERE}../../../../../src/server/http-api.ts`, 'utf8');

const both = (key: string): void => {
  const line = new RegExp(`'${key.replace('.', '\\.')}':\\s*\\{([\\s\\S]*?)\\},`).exec(I18N);
  expect(line, `${key} has to exist`).not.toBeNull();
  expect(line![1]).toMatch(/\bde:\s*'[^']{10,}'/);
  expect(line![1]).toMatch(/\ben:\s*'[^']{10,}'/);
};

describe('a paused plan in the Triggers view', () => {
  it('Run now: the engine sends `paused`, the view switches on it, and both languages have the line', () => {
    expect(ROUTE).toMatch(/errorResponse\(res, 409, PAUSED_REFUSAL, 'paused'\)/);
    expect(VIEW).toMatch(/code === 'paused' \? 'triggers\.run_paused'/);
    both('triggers.run_paused');
  });

  it('the list carries `paused`, and the view labels it and shows no next run', () => {
    expect(ROUTE).toMatch(/planPauseOn\(\) \? \{ paused: isPaused\(trigger\) \}/);
    expect(VIEW).toMatch(/\{#if trigger\.paused === true\}[\s\S]{0,300}?triggers\.paused_takeover/);
    expect(VIEW).toMatch(/\{#if trigger\.next_run_at[^}]*trigger\.paused !== true\}/);
    expect(I18N).toMatch(/'triggers\.paused_takeover': \{ de: 'Pausiert · Übernahme nötig', en: 'Paused · needs takeover' \}/);
  });
});
