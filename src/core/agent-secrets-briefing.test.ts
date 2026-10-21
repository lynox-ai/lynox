/**
 * The vault's `<secrets>` listing goes with the session briefing, but only to an owner's turn.
 *
 * A mandate references no secret at all (`secret:` is refused under its lock), so the names and
 * their last characters would only tell it what the owner stores. The principal is per run and an
 * agent built for an owner's run is reused by a mandate's, so the agent asks on every request.
 * The listing rides in the uncached tail, so the cached prefix is the same with or without it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));
vi.mock('./observability.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./observability.js')>()),
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent } from './agent.js';
import { initSecrets } from './engine-init.js';
import { SecretVault } from './secret-vault.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import type { LynoxUserConfig } from '../types/index.js';

interface AgentInternals {
  _buildSystemPrompt(): Array<{ type: string; text: string }>;
  _buildEphemeralContextBlocks(): Array<{ type: string; text: string }>;
}

const MANDATE = { kind: 'mandate', email: 'helper@example.org', mandateId: 'M-1' } as RequestPrincipal;
const LISTING = '<secrets>secret:CRM_TOKEN (***wxyz)</secrets>';
const BRIEFING = '<session_briefing>run history</session_briefing>';

function agentWith(principal: RequestPrincipal): Agent & AgentInternals {
  const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', systemPrompt: 'STATIC', briefing: BRIEFING, secretsBriefing: LISTING, principal });
  return agent as unknown as Agent & AgentInternals;
}

const tail = (agent: AgentInternals): string => agent._buildEphemeralContextBlocks().map((b) => b.text).join('\n');

describe('the vault listing in the briefing tail', () => {
  it('an owner\'s turn gets it with the briefing; a mandate\'s turn gets the briefing without it', () => {
    const owner = tail(agentWith(OWNER_PRINCIPAL));
    expect(owner).toContain(BRIEFING);
    expect(owner).toContain(LISTING);

    const mandate = tail(agentWith(MANDATE));
    expect(mandate).toContain(BRIEFING);
    expect(mandate).not.toContain('CRM_TOKEN');
    expect(mandate).not.toContain('***');
  });

  it('is asked per request: the same agent, reused by a mandate\'s run, drops it, and an owner\'s run gets it back', () => {
    const agent = agentWith(OWNER_PRINCIPAL);
    expect(tail(agent)).toContain(LISTING);
    agent.principal = MANDATE;
    expect(tail(agent)).not.toContain('CRM_TOKEN');
    agent.principal = OWNER_PRINCIPAL;
    expect(tail(agent)).toContain(LISTING);
  });

  it('a mandate\'s turn with only the listing and no briefing gets no briefing block at all', () => {
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', systemPrompt: 'STATIC', secretsBriefing: LISTING, principal: MANDATE }) as unknown as AgentInternals;
    expect(agent._buildEphemeralContextBlocks()).toEqual([]);
  });

  it('the cached system prefix is the same for an owner, a mandate, and without the listing', () => {
    const plain = new Agent({ name: 'test', model: 'claude-sonnet-4-6', systemPrompt: 'STATIC', briefing: BRIEFING }) as unknown as AgentInternals;
    const prefix = JSON.stringify(plain._buildSystemPrompt());
    expect(JSON.stringify(agentWith(OWNER_PRINCIPAL)._buildSystemPrompt())).toBe(prefix);
    expect(JSON.stringify(agentWith(MANDATE)._buildSystemPrompt())).toBe(prefix);
  });

  it('cleared with the briefing: no listing once the session consumed it', () => {
    const agent = agentWith(OWNER_PRINCIPAL);
    agent.setBriefing(undefined);
    agent.setSecretsBriefing(undefined);
    expect(agent._buildEphemeralContextBlocks()).toEqual([]);
  });
});

describe('initSecrets keeps the listing out of the briefing parts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-secrets-briefing-'));
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    vi.stubEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-briefing-00000000');
    const vault = new SecretVault();
    vault.set('CRM_TOKEN', 'crm-token-value-abcdwxyz');
    vault.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the listing on its own, and no briefing part names a stored secret', () => {
    const result = initSecrets({} as LynoxUserConfig);
    expect(result.secretsBriefing).toContain('secret:CRM_TOKEN (***wxyz)');
    expect(JSON.stringify(result.briefingParts)).not.toContain('CRM_TOKEN');
  });
});
