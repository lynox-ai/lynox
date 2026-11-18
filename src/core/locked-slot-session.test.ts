import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// A config.json slot naming a model this engine does not know, on a provider other than its
// strategy's, holds every session back until the settings change it — without a restart.
const tmpBase = mkdtempSync(join(tmpdir(), 'lynox-locked-slot-'));
const fakeHome = join(tmpBase, 'home');
mkdirSync(join(fakeHome, '.lynox'), { recursive: true });
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

const LOCKING = { tier_preset: 'balanced', tier_set: { deep: { provider: 'openai', model_id: 'ghost-override-model' } } };

function write(config: Record<string, unknown>): void {
  writeFileSync(join(fakeHome, '.lynox', 'config.json'), JSON.stringify(config));
}

describe('a locked slot holds sessions back until the settings change it', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => rmSync(tmpBase, { recursive: true, force: true }));

  /** What constructing a session throws: the gate's refusal, or whatever a stub engine trips over next. */
  async function sessionStart(opts?: Record<string, unknown>): Promise<unknown> {
    const { Session } = await import('./session.js');
    try {
      new Session({} as never, opts as never);
      return undefined;
    } catch (err: unknown) {
      return err;
    }
  }

  it('locked: the session is refused with the tier and the way out', async () => {
    write(LOCKING);
    const { LockedSlotError } = await import('./config.js');
    const err = await sessionStart();
    expect(err).toBeInstanceOf(LockedSlotError);
    expect((err as Error).message).toMatch(/the Deep tier has a saved model, "ghost-override-model".*Settings → LLM Provider → Model per tier/);
  });

  it('a person with delegated access is told it is the owner\'s move, not sent to settings they cannot open', async () => {
    write(LOCKING);
    const { LockedSlotError } = await import('./config.js');
    const err = await sessionStart({ principal: { kind: 'mandate', email: 'eva@example.com', mandateId: 'm-1' } });
    expect(err).toBeInstanceOf(LockedSlotError);
    expect((err as Error).message).toBe('This version of lynox does not know the model ghost-override-model. The “Deep” tier is locked for that reason, and nothing runs until the owner picks another model.');
  });

  it('a save that sets the tier to a known model lifts it in the running process', async () => {
    write(LOCKING);
    const { saveUserConfig, readUserConfig, LockedSlotError } = await import('./config.js');
    expect(await sessionStart()).toBeInstanceOf(LockedSlotError);
    saveUserConfig({ ...readUserConfig(), tier_set: { deep: { provider: 'anthropic', model_id: 'claude-opus-4-8' } } });
    expect(await sessionStart()).not.toBeInstanceOf(LockedSlotError);
  });

  it('a save that clears the slot lifts it too', async () => {
    write(LOCKING);
    const { saveUserConfig, readUserConfig, LockedSlotError } = await import('./config.js');
    const { tier_set: _dropped, ...rest } = readUserConfig();
    saveUserConfig(rest);
    expect(await sessionStart()).not.toBeInstanceOf(LockedSlotError);
  });

  it('a save of another field leaves it locked', async () => {
    write(LOCKING);
    const { saveUserConfig, readUserConfig, LockedSlotError } = await import('./config.js');
    saveUserConfig({ ...readUserConfig(), thinking_mode: 'disabled' });
    expect(await sessionStart()).toBeInstanceOf(LockedSlotError);
  });
});
