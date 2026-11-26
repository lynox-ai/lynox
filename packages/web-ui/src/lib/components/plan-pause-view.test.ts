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
  it('a completed paused plan names the workflow\'s takeover in all four places: the model, task_update, the API and the view (U-275)', () => {
    const CORE = readFileSync(`${HERE}../../../../../src/core/plan-pause.ts`, 'utf8');
    const WAY = 'If it runs a workflow that the person whose access ended created or last changed';
    expect(CORE).toContain(`export const PAUSED_DONE_WORKFLOW_FIRST = '${WAY}, the owner first takes over that workflow, under "Workflows" with "Take over workflow".';`);
    expect(CORE).toMatch(/PAUSED_DONE_MODEL_TEXT = `[^`]*\$\{PAUSED_DONE_WORKFLOW_FIRST\}`;/);
    expect(CORE).toMatch(/PAUSED_DONE_UPDATE_REFUSAL = `[^`]*\$\{PAUSED_DONE_WORKFLOW_FIRST\}`;/);
    expect(ROUTE).toMatch(/const PAUSED_DONE_REFUSAL = `[^`]*\$\{PAUSED_DONE_WORKFLOW_FIRST\}`;/);
    expect(I18N).toContain(`en: 'An access ended. If the plan should run again, create a new one. ${WAY}, first take over that workflow under “{tab}” with “{button}”.'`);
    expect(I18N).toContain(`en: 'An access ended. If the plan should run again, create a new one. ${WAY}, the owner has to take over that workflow first.'`);
    // The button is the owner's (`ownerActs` in the workflow library), so a helper reads who does it.
    expect(VIEW).toContain("{ownerActs ? tf('triggers.paused_done_hint', { tab: t('hub.automation.workflows'), button: t('workflow_library.takeover.button') }) : t('triggers.paused_done_hint_helper')}");
  });

  it('Run now: the engine sends `paused`, the view switches on it, and both languages have the line', () => {
    expect(ROUTE).toContain("errorResponse(res, 409, pausedRefusal(engine.getRunHistory()?.getTrigger(params['id']!)), 'paused');");
    expect(ROUTE).toContain("errorResponse(res, 409, pausedRefusal(trigger), 'paused');");
    expect(VIEW).toMatch(/code === 'paused'\s*\?\s*\(who !== '' \? tf\('triggers\.run_paused', \{ who \}\) : t\('triggers\.run_paused_anon'\)\)/);
    both('triggers.run_paused_anon');
  });

  it('the refusal names whose access ended, and says it without a name when the view has none', () => {
    expect(I18N).toContain("de: 'Pausiert: Der Zugang von {who} ist beendet. Der Plan läuft erst wieder, wenn du ihn übernimmst.'");
    expect(I18N).toContain(`en: "Paused: {who}'s access has ended. The plan runs again only once you take it over."`);
    expect(I18N).toContain("de: 'Pausiert: Der Zugang der Person, die ihn eingerichtet hat, ist beendet. Der Plan läuft erst wieder, wenn du ihn übernimmst.'");
    expect(I18N).toContain("en: 'Paused: the access of the person who set it up has ended. The plan runs again only once you take it over.'");
    expect(VIEW).toContain('const who = pausedWhoText(trigger.paused_who);');
  });

  it('the list carries `paused`, and the view labels it and shows no next run', () => {
    expect(ROUTE).toMatch(/\.\.\.triggerForRoute\(trigger, principal\)/);
    // `pausedOpen`: paused and not completed (641c-2; a completed plan keeps its pause, nothing is due).
    expect(VIEW).toMatch(/\{#if pausedOpen\(trigger\)\}[\s\S]{0,300}?triggers\.paused_takeover/);
    expect(VIEW).toContain("return trigger.paused === true && trigger.status !== 'completed';");
    expect(VIEW).toMatch(/\{#if trigger\.next_run_at[^}]*trigger\.paused !== true\}/);
    expect(I18N).toMatch(/'triggers\.paused_takeover': \{ de: 'Pausiert · Übernahme nötig', en: 'Paused · needs takeover' \}/);
  });
});
