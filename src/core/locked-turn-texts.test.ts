/**
 * A locked turn (a mandate's, `toolLockFor`) reads its own texts where the owner's send the model
 * to collect a key with `ask_secret`, which stores nothing there (U-185). Each swap is held to
 * both directions: the locked text in the locked turn, word for word, and the owner's text in the
 * owner's turn, unchanged. The words are held here exactly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SYSTEM_PROMPT, shopifyPresetSuffix, lockedTurnPrompt, LOCKED_TURN_PROMPT_SWAPS } from './prompts.js';
import { lockedTurnBriefing, BRIEFING_CUT_MARKER } from './api-store.js';
import { turnIsLocked, MANDATE_INSIDE_NON_WRITERS } from './mandate-tool-lock.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { askSecretTool } from '../tools/builtin/ask-secret.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { findAutonomousViolations } from '../orchestrator/human-in-the-loop.js';
import type { InlinePipelineStep } from '../types/index.js';

const MANDATE = { kind: 'mandate', email: 'helper@example.org', mandateId: 'M-1' } as RequestPrincipal;
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** U-185 §3 and §4 (Shopify), word for word. */
const LOCKED_PROMPT_TEXTS = [
  '**NEVER ask for credentials, API keys, tokens or passwords with `ask_user` or in plain text.** In this session none is entered; see the Secrets rules.',
  '**Never ask for credentials in chat**; in this session only the owner of this instance stores keys (see the Secrets rules).',
  '6. **Keys in this session.** When the walkthrough reaches the credential, tell the user that the owner of this instance has to store it, and go on with the steps that need no key.',
  '1. This session runs for a person the owner let in, not for the owner. No credential is entered here: never ask for one with `ask_user`, in plain text, in options or in tabs. Only the owner of this instance stores keys; if one is needed, tell the user to ask the owner to store it. Do not say that the owner has been asked or told, or has stored it, unless a tool result says so.',
  '3. `ask_secret` stores nothing in this session and opens no input; its result says how the key gets stored. Pass that on, and offer no other path, never a plaintext one.',
  '4. If the user pastes what looks like a credential into chat anyway, **refuse to use it**: tell them the value is now in the conversation and should be rotated, and that the owner of this instance has to store the key.',
  "- that app's client ID and secret, which the owner of this lynox instance enters in the profile's connection form under Settings → API Profiles, never in the chat;",
  'Never ask the user to give you, paste or type the client ID or secret; there is no way to enter them in this session. Tell them that the owner of this lynox instance enters both in Settings → API Profiles.',
];

/** The owner's parts, as the prompt carried them before this change (core 8e0822363). */
const OWNER_PROMPT_HEADS = [
  '**ALWAYS use `ask_secret` for credentials, API keys, tokens, or passwords — NEVER use `ask_user` for secrets, NEVER ask in plain text.**',
  '**Never ask for credentials in chat** — use `ask_secret` to securely collect them.',
  '6. **Hold `ask_secret` until the user signals readiness.**',
  '6b. **Verify the integration exists before opening `ask_secret`.**',
  '1. Collect credentials ONLY via `ask_secret`. Never `ask_user`. Never plain text. Never options. Never tabs.',
  '3. When `ask_secret` returns:',
  '   - `managed_blocked` → this fires only for the narrow set of admin-only infrastructure names',
  'then re-issue `ask_secret` so they can resubmit via the vault.',
  "- that app's client ID and secret, which the owner enters in lynox, in the profile's connection form under Settings → API Profiles, never in the chat;",
  'and do not collect them with `ask_secret` either; tell them to enter both in Settings → API Profiles.',
];

const FULL = SYSTEM_PROMPT + shopifyPresetSuffix(true);

describe('the system prompt of a locked turn', () => {
  it('the owner\'s prompt carries each owner part once and none of the locked texts', () => {
    for (const [owner] of LOCKED_TURN_PROMPT_SWAPS) expect(count(FULL, owner)).toBe(1);
    for (const head of OWNER_PROMPT_HEADS) expect(count(FULL, head)).toBe(1);
    for (const text of LOCKED_PROMPT_TEXTS) expect(FULL).not.toContain(text);
  });

  it('the locked prompt carries every locked text once and none of the owner parts', () => {
    const locked = lockedTurnPrompt(FULL);
    for (const text of LOCKED_PROMPT_TEXTS) expect(count(locked, text)).toBe(1);
    for (const head of OWNER_PROMPT_HEADS) expect(locked).not.toContain(head);
    // Rule 6b is gone with rule 6; the plain-text ban stays (HARD RULE 1).
    expect(locked).not.toContain('6b.');
    expect(locked).toContain('never ask for one with `ask_user`, in plain text, in options or in tabs');
    // The one mention of the tool left is rule 3, which says it stores nothing.
    expect(count(locked, 'ask_secret')).toBe(1);
    expect(count(FULL, 'ask_secret')).toBe(12);
  });

  it('nothing else changes: undoing the swaps gives the owner\'s prompt back', () => {
    let back = lockedTurnPrompt(FULL);
    for (const [owner, locked] of LOCKED_TURN_PROMPT_SWAPS) back = back.split(locked).join(owner);
    expect(back).toBe(FULL);
  });

  it('a prompt without the parts (a configured one) stays as it is', () => {
    expect(lockedTurnPrompt('You are a helpful agent.')).toBe('You are a helpful agent.');
  });

  it('the Shopify section is swapped only while it is sent', () => {
    expect(lockedTurnPrompt(SYSTEM_PROMPT)).not.toContain("owner of this lynox instance enters in the profile's");
    expect(lockedTurnPrompt(FULL)).toContain("owner of this lynox instance enters in the profile's");
  });
});

describe('ask_secret in a locked turn', () => {
  const owner = askSecretTool.definition;
  const locked = askSecretTool.lockedDefinition!;
  const props = (d: typeof owner): Record<string, { description?: string }> =>
    (d.input_schema as { properties: Record<string, { description?: string }> }).properties;

  it('has the same name, properties and required list, so a call reaches the same handler', () => {
    expect(locked.name).toBe('ask_secret');
    expect(Object.keys(props(locked))).toEqual(Object.keys(props(owner)));
    expect((locked.input_schema as { required: unknown }).required).toEqual((owner.input_schema as { required: unknown }).required);
  });

  it('describes the call as the way, word for word (U-185 §2), and keeps name and key_type', () => {
    expect(locked.description).toBe('In this session ask_secret stores nothing and opens no input: it returns how a key gets stored here. When a step needs a key, token or password, call it instead of asking the user for one.');
    expect(props(locked)['action']!.description).toBe('Optional, default "collect". In this session "collect" stores nothing and returns how a key gets stored here; "list" returns no names.');
    expect(props(locked)['prompt']!.description).toBe('What the key is for, in a few words (e.g. "Stripe API key"). Not shown to the user in this session.');
    expect(props(locked)['name']).toEqual(props(owner)['name']);
    expect(props(locked)['key_type']).toEqual(props(owner)['key_type']);
  });

  it('leaves the owner\'s definition as it was', () => {
    expect(owner.description).toBe('Securely collect a secret (API key, token, password) from the user. The secret is stored encrypted in the vault and NEVER enters the conversation. Use this instead of ask_user whenever the answer is a credential.');
    expect(props(owner)['prompt']!.description).toBe('Human-readable prompt shown to the user (e.g. "Enter your Stripe API key"). Required for action:"collect".');
  });

  it('sends no guidance in a locked turn; the owner keeps it', () => {
    expect(askSecretTool.lockedGuidance).toBe('');
    expect(askSecretTool.detailedGuidance).toContain('first confirm the consuming integration exists');
  });

  it('its place in the registry says what it does for a mandate now', () => {
    expect(MANDATE_INSIDE_NON_WRITERS['ask_secret']).toBe('opens no dialog for a mandate and stores nothing; it returns how a key gets stored, by the owner alone');
  });
});

describe('api_setup guidance in a locked turn', () => {
  it('swaps only the last sentence (U-185 §5)', () => {
    const owner = apiSetupTool.detailedGuidance!;
    const locked = apiSetupTool.lockedGuidance!;
    expect(owner.endsWith('Store the value with ask_secret, then just call http_request.')).toBe(true);
    expect(locked.endsWith('The value is stored by the owner of this instance, not in this session; once it is stored, just call http_request.')).toBe(true);
    expect(locked.split('The value is stored by the owner of this instance, not in this session; once it is stored, just call http_request.').join('Store the value with ask_secret, then just call http_request.')).toBe(owner);
    expect(locked).not.toContain('ask_secret');
  });
});

describe('the catalog briefing in a locked turn', () => {
  const OWNER_STEP = 'Once they name it: walk them through creating the credential in their own account, have them store it with `ask_secret`, then call `api_setup` action=bootstrap with the docs_url';
  const LOCKED_STEP = 'Once they name it: tell them which credential the API needs and that the owner of this instance has to store it, then call `api_setup` action=bootstrap with the docs_url';

  it('swaps the store step and leaves the rest', () => {
    const briefing = `<api_bootstrap_hints>Connect ONLY after the user names one. ${OWNER_STEP} (an entry that names a built-in preset says to create the profile directly instead).</api_bootstrap_hints>`;
    const locked = lockedTurnBriefing(briefing);
    expect(locked).toBe(briefing.replace(OWNER_STEP, LOCKED_STEP));
    expect(locked).not.toContain('ask_secret');
    expect(lockedTurnBriefing('<session_briefing>run history</session_briefing>')).toBe('<session_briefing>run history</session_briefing>');
  });

  // Session cuts a long briefing before the swap: the step can end cut off, and its rest still
  // names ask_secret. Every cut that leaves at least 20 characters of the step is swapped whole.
  it('swaps a store step that the briefing cut leaves cut off at the end', () => {
    const before = '<api_bootstrap_hints>Connect ONLY after the user names one. Once they name it: ';
    const step = 'walk them through creating the credential in their own account, have them store it with `ask_secret`, then call';
    const lockedStep = 'tell them which credential the API needs and that the owner of this instance has to store it, then call';
    for (let n = 20; n < step.length; n++) {
      const cutBriefing = before + step.slice(0, n) + BRIEFING_CUT_MARKER;
      const locked = lockedTurnBriefing(cutBriefing);
      expect(locked).toBe(before + lockedStep + BRIEFING_CUT_MARKER);
      expect(locked).not.toContain('ask_secret');
    }
    // Without the marker too, and text that only shares a short start stays as it is.
    expect(lockedTurnBriefing(before + step.slice(0, 90))).toBe(before + lockedStep);
    expect(lockedTurnBriefing('see the walk' + BRIEFING_CUT_MARKER)).toBe('see the walk' + BRIEFING_CUT_MARKER);
  });

  it('uses the marker Session appends when it cuts a briefing', () => {
    const session = readFileSync(new URL('./session.ts', import.meta.url), 'utf8');
    expect(session).toContain(`rawBriefing.slice(0, 8000) + ${JSON.stringify(BRIEFING_CUT_MARKER).replace(/"/g, "'")}`);
  });
});

describe('a pipeline step on ask_secret saved in a locked turn', () => {
  const steps = [
    { id: 'collect', task: 'get the key', tools: ['ask_secret'] },
    { id: 'confirm', task: 'ask the user', tools: ['ask_user'] },
  ] as unknown as InlinePipelineStep[];

  it('is told that ask_secret stores nothing there (U-185 §4); other tools keep their text', () => {
    const locked = findAutonomousViolations(steps, true).map((i) => i.message);
    const owner = findAutonomousViolations(steps).map((i) => i.message);
    expect(locked[0]).toBe('Step "collect" uses ask_secret, which stores nothing in this session, so the step cannot get a key from it. Remove ask_secret from this step; the key has to be stored by the owner of this instance.');
    expect(owner[0]).toBe('Step "collect" uses ask_secret, but the pipeline is marked autonomous. Either remove the human-in-the-loop tool from this step or change the pipeline mode to \'interactive\'.');
    expect(locked[1]).toBe(owner[1]);
    expect(locked[1]).toContain('Step "confirm" uses ask_user, but the pipeline is marked autonomous.');
  });
});

describe('turnIsLocked', () => {
  it('is false for the owner, true for a mandate and for an agent that names no principal', () => {
    expect(turnIsLocked(OWNER_PRINCIPAL)).toBe(false);
    expect(turnIsLocked(MANDATE)).toBe(true);
    expect(turnIsLocked(undefined)).toBe(true);
  });
});
