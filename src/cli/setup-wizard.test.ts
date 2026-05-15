import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreate = vi.fn().mockResolvedValue({ id: 'msg_ok' });
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

let fakeHome: string;
vi.mock('../core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../core/config.js')>('../core/config.js');
  return {
    ...actual,
    saveUserConfig: (cfg: unknown) => actual.saveUserConfig(cfg),
    getLynoxDir: () => join(fakeHome, '.lynox'),
  };
});

function mockReadline(answers: string[]): ReturnType<typeof createInterface> {
  const input = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
  const output = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  const rl = createInterface({ input, output, terminal: false });

  let idx = 0;
  const origQuestion = rl.question.bind(rl);
  vi.spyOn(rl, 'question').mockImplementation(async (_prompt: string) => {
    if (idx < answers.length) return answers[idx++]!;
    return '';
  });

  return rl;
}

// New answer sequence (provider + credentials wizard):
// 1. Provider selection (1=Anthropic, 2=Mistral, 3=Custom OpenAI-compatible)
// 2. API key (for Anthropic) or model + URL + key (for the OpenAI-compatible paths)
// (Encryption = always on, Accuracy = always sonnet — no prompts)

function basicAnswers(apiKey: string): string[] {
  return ['1', apiKey]; // 1 = Anthropic, then API key
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setup-wizard', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ id: 'msg_ok' });
    fakeHome = mkdtempSync(join(tmpdir(), 'lynox-wizard-'));
    process.env['HOME'] = fakeHome;
  });

  it('saves config with API key and sonnet tier', async () => {
    const rl = mockReadline(basicAnswers('sk-ant-test-key-12345678'));

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(config!.api_key).toBe('sk-ant-test-key-12345678');
    expect(config!.default_tier).toBe('sonnet');
    const filePath = join(fakeHome, '.lynox', 'config.json');
    const saved = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    expect(saved['api_key']).toBe('sk-ant-test-key-12345678');
  });

  it('always sets tier to sonnet (no prompt)', async () => {
    const rl = mockReadline(basicAnswers('sk-ant-opus-key-12345678'));

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(config!.default_tier).toBe('sonnet');
  });

  it('always enables encryption (no prompt)', async () => {
    const rl = mockReadline(basicAnswers('sk-ant-enc-key-123456789'));

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(process.env['LYNOX_VAULT_KEY']).toBeTruthy();
  });

  it('returns null when API key is empty', async () => {
    const rl = mockReadline(['1', '']); // select Anthropic, then empty key

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).toBeNull();
  });

  it('rejects key with bad format then accepts valid key', async () => {
    const rl = mockReadline([
      '1',                                // select Anthropic
      'too-short',                        // rejected: bad format
      'sk-ant-valid-key-12345678',        // accepted
    ]);

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(config!.api_key).toBe('sk-ant-valid-key-12345678');
  });

  it('rejects key on auth error then accepts second key', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('401 authentication error'))
      .mockResolvedValueOnce({ id: 'msg_ok' });

    const rl = mockReadline([
      '1',                               // select Anthropic
      'sk-ant-bad-key-123456789',        // rejected: auth error
      'sk-ant-good-key-12345678',        // accepted
    ]);

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(config!.api_key).toBe('sk-ant-good-key-12345678');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('warns but accepts key on network error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const rl = mockReadline(basicAnswers('sk-ant-net-error-key-12345'));

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(config!.api_key).toBe('sk-ant-net-error-key-12345');
  });

  it('saves mistral config with model + api_base_url + api_key', async () => {
    const rl = mockReadline([
      '2',                            // select Mistral
      '1',                            // select mistral-large-latest
      'mst-secret-key-12345678',      // Mistral API key
    ]);

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
    expect(config!.api_base_url).toBe('https://api.mistral.ai/v1');
    expect(config!.openai_model_id).toBe('mistral-large-latest');
    expect(config!.api_key).toBe('mst-secret-key-12345678');
  });

  it('saves custom OpenAI-compatible config with user-supplied URL + model + key', async () => {
    const rl = mockReadline([
      '3',                              // select Custom OpenAI-compatible
      'http://localhost:11434/v1',      // Base URL (Ollama default)
      'llama3.2',                       // Model
      '',                               // No API key (local endpoint)
    ]);

    const { runSetupWizard } = await import('./setup-wizard.js');
    const config = await runSetupWizard(rl);

    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
    expect(config!.api_base_url).toBe('http://localhost:11434/v1');
    expect(config!.openai_model_id).toBe('llama3.2');
    expect(config!.api_key).toBeUndefined();
  });
});
