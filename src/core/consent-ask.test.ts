import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAgent, PromptMeta, ToolEntry } from '../types/index.js';
import { CONSENT_KEYS, consentAnswer, isConsentKind } from '../contract/prompt.js';
import { CONSENT_UNRECOGNISED_SENTENCE, consentMeta, consentOptions, consentRefusal, decideConsent } from './consent-ask.js';
import { CONSENT_LABELS } from '../tools/dialog-text.js';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from './agent.js';
import { RunHistory } from './run-history.js';
import { PromptStore, consentOfPayload, UNATTENDED_BLOCK_ANSWER } from './prompt-store.js';
import { askUserTool } from '../tools/builtin/ask-user.js';

// The engine's own confirmations offer fixed keys and approve only on one of them. Every other
// answer — a label, the other language's word, typed text, an older client's `y` — approves
// nothing, and is told apart from a plain "no" so the person learns why.

/** Answers that once approved, or read like an approval, and approve nothing now. */
const NOT_KEYS = ['y', 'yes', 'Yes', 'no', 'No', 'Allow', 'ALLOW', ' allow', 'allow ', 'Erlauben', 'ja', 'ok', '1', 'allow deep', 'run on balanced', 'Allow deep', 'Run on balanced', '["allow"]'];

describe('the contract keys', () => {
  it('approve only as themselves, exactly', () => {
    expect(consentAnswer('guard', 'allow')).toBe('allow');
    expect(consentAnswer('guard', 'deny')).toBe('deny');
    expect(consentAnswer('deep', 'deep')).toBe('deep');
    expect(consentAnswer('deep', 'balanced')).toBe('balanced');
    expect(consentAnswer('deep', 'cancel')).toBe('cancel');
    for (const answer of NOT_KEYS) {
      expect(consentAnswer('guard', answer), answer).toBeUndefined();
      expect(consentAnswer('deep', answer), answer).toBeUndefined();
    }
  });

  it('are a kind\'s own: one kind\'s key is no key of the other', () => {
    expect(consentAnswer('guard', 'deep')).toBeUndefined();
    expect(consentAnswer('guard', 'balanced')).toBeUndefined();
    expect(consentAnswer('deep', 'allow')).toBeUndefined();
    expect(consentAnswer('deep', 'deny')).toBeUndefined();
    expect(consentAnswer('guard', 'toString')).toBeUndefined();
    expect(consentAnswer('guard', undefined)).toBeUndefined();
  });

  it('name only the two kinds', () => {
    expect(isConsentKind('guard')).toBe(true);
    expect(isConsentKind('deep')).toBe(true);
    for (const v of ['Guard', 'permission', '', null, undefined, 1, {}]) expect(isConsentKind(v), String(v)).toBe(false);
  });
});

describe('decideConsent', () => {
  it('tells a key, a question nobody answered and an unrecognised answer apart', () => {
    expect(decideConsent('guard', 'allow')).toBe('allow');
    expect(decideConsent('guard', 'deny')).toBe('deny');
    for (const answer of ['', '__dismissed__', UNATTENDED_BLOCK_ANSWER]) expect(decideConsent('guard', answer), answer).toBe('dismissed');
    for (const answer of NOT_KEYS) expect(decideConsent('guard', answer), answer).toBe('unrecognised');
  });

  it('says why only after an unrecognised answer, as a sentence of its own after the refusal', () => {
    expect(consentRefusal('deny', 'Blocked: x — user declined.')).toBe('Blocked: x — user declined.');
    expect(consentRefusal('dismissed', 'Blocked: x — user declined.')).toBe('Blocked: x — user declined.');
    expect(consentRefusal('unrecognised', 'Blocked: x — user declined.')).toBe(`Blocked: x — user declined. ${CONSENT_UNRECOGNISED_SENTENCE}`);
    // A refusal without a closing mark gets one, so the sentence after it reads as its own.
    expect(consentRefusal('unrecognised', 'Permission denied by user: bash')).toBe(`Permission denied by user: bash. ${CONSENT_UNRECOGNISED_SENTENCE}`);
    expect(consentRefusal('unrecognised', 'Secret use denied by user')).toBe(`Secret use denied by user. ${CONSENT_UNRECOGNISED_SENTENCE}`);
    expect(consentRefusal('deny', 'Permission denied by user: bash')).toBe('Permission denied by user: bash');
  });

  it('asks with the kind\'s keys and nothing to type in, and marks the question', () => {
    expect(consentOptions('guard')).toEqual(['allow', 'deny']);
    expect(consentOptions('deep')).toEqual(['deep', 'balanced', 'cancel']);
    expect(consentMeta('guard', { blocked: true })).toEqual({ blocked: true, consent: 'guard' });
  });

  it('has a word for every key in both languages', () => {
    for (const language of ['de', 'en'] as const) {
      for (const keys of Object.values(CONSENT_KEYS)) for (const key of keys) expect(CONSENT_LABELS[language][key], `${language} ${key}`).toBeTruthy();
    }
  });
});

describe('the stored marker', () => {
  const withStore = (fn: (store: PromptStore) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-consent-marker-'));
    const history = new RunHistory(join(dir, 'history.db'));
    try { fn(new PromptStore(history.getDb())); } finally { history.close(); rmSync(dir, { recursive: true, force: true }); }
  };

  it('is written only for the engine\'s own confirmation, and read back from it alone', () => {
    withStore((store) => {
      const consent = store.insertQuestion({ blocked: false, attended: true }, 's1', '⚠ Command: x', ['allow', 'deny'], false, undefined, undefined, undefined, undefined, 'guard');
      expect(consentOfPayload(store.getById(consent)!.payload_json)).toBe('guard');
      store.expirePrompt(consent, 'timed_out');
      // A question the model writes, offering the same words: no marker.
      const model = store.insertQuestion({ blocked: false, attended: true }, 's1', 'Allow or deny?', ['Allow', 'Deny', '\x00']);
      expect(store.getById(model)!.payload_json).toBeNull();
      expect(consentOfPayload(store.getById(model)!.payload_json)).toBeUndefined();
    });
  });

  it('a question stored before the marker existed is no consent, whatever its options: it fails closed', () => {
    // A parked task question from before the upgrade: English labels, no marker. Its answer
    // reaches the next run only as text (`RUN_TASK_ANSWERED`), and no gate reads it.
    withStore((store) => {
      const old = store.insertAskUser('s-old', '⚠ Command: rm', ['Allow', 'Deny', '\x00']);
      expect(consentOfPayload(store.getById(old)!.payload_json)).toBeUndefined();
    });
    for (const payload of ['{"kind":"consent","consent":"Guard"}', '{"kind":"consent"}', '{"consent":"guard"}', '{"kind":"onboarding_basics","keys":[]}', 'not json', '"guard"', 'null']) {
      expect(consentOfPayload(payload), payload).toBeUndefined();
    }
  });
});

type Exec = { _executeOneInner(tc: unknown): Promise<{ content: unknown; is_error?: boolean }> };

function stub(name: string): ToolEntry & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    definition: { name, description: name, input_schema: { type: 'object', properties: {}, additionalProperties: true } },
    handler: async (input: unknown) => { calls.push(input); return 'done'; },
  } as unknown as ToolEntry & { calls: unknown[] };
}

const call = (agent: Agent, name: string, input: Record<string, unknown>) =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t${Math.random()}`, name, input });

describe('the guard\'s question through the agent', () => {
  const ask = async (answer: string) => {
    const bash = stub('bash');
    const metas: Array<PromptMeta | undefined> = [];
    const options: Array<string[] | undefined> = [];
    const promptUser = vi.fn(async (_q: unknown, o?: string[], m?: PromptMeta) => { options.push(o); metas.push(m); return answer; });
    const agent = new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', tools: [bash], autonomy: 'guided', promptUser } as ConstructorParameters<typeof Agent>[0]);
    const result = await call(agent, 'bash', { command: 'git push origin main' });
    return { bash, metas, options, result };
  };

  it('asks with the keys, marked as the guard\'s', async () => {
    const { options, metas } = await ask('deny');
    expect(options).toEqual([['allow', 'deny']]);
    expect(metas[0]?.consent).toBe('guard');
  });

  it('runs on the key allow', async () => {
    const { bash, result } = await ask('allow');
    expect(result.is_error).not.toBe(true);
    expect(bash.calls).toHaveLength(1);
  });

  it('typed text approves nothing, in either language, and the refusal says why', async () => {
    for (const answer of ['yes', 'Erlauben', 'y', 'Allow']) {
      const { bash, result } = await ask(answer);
      expect(bash.calls, answer).toEqual([]);
      expect(result.is_error, answer).toBe(true);
      expect(String(result.content), answer).toContain(CONSENT_UNRECOGNISED_SENTENCE);
    }
  });

  it('a plain deny refuses without the sentence', async () => {
    const { bash, result } = await ask('deny');
    expect(bash.calls).toEqual([]);
    expect(String(result.content)).not.toContain(CONSENT_UNRECOGNISED_SENTENCE);
  });
});

describe('a question the model writes', () => {
  it('offering "Allow" and "Deny" is no consent: it is asked unmarked and its answer goes back to the model', async () => {
    for (const options of [['Allow', 'Deny'], ['Allow deep', 'Run on balanced', 'Cancel'], ['allow', 'deny']]) {
      const metas: Array<PromptMeta | undefined> = [];
      const promptUser = vi.fn(async (_q: unknown, _o?: string[], m?: PromptMeta) => { metas.push(m); return 'allow'; });
      const agent = { promptUser, toolContext: {} } as unknown as IAgent;
      const answer = await askUserTool.handler({ question: 'May I?', options } as never, agent);
      expect(String(answer), options.join('/')).toContain('allow');
      expect(metas.every((m) => m?.consent === undefined), options.join('/')).toBe(true);
    }
  });
});
