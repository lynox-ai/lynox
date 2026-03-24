import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAgentDef } from './agent-registry.js';

function createAgentFile(agentsDir: string, name: string, content: string): void {
  mkdirSync(join(agentsDir, name), { recursive: true });
  writeFileSync(join(agentsDir, name, 'index.js'), content, 'utf-8');
}

describe('loadAgentDef', () => {
  it('loads a valid agent definition', async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'nodyn-agents-'));
    const agentContent = `
export default {
  name: 'test-agent',
  version: '1.0.0',
  defaultTier: 'sonnet',
  systemPrompt: 'You are a test agent.',
  tools: [],
};
`;
    createAgentFile(agentsDir, 'test-agent', agentContent);
    const def = await loadAgentDef('test-agent', agentsDir);
    expect(def.name).toBe('test-agent');
    expect(def.version).toBe('1.0.0');
    expect(def.defaultTier).toBe('sonnet');
    expect(def.systemPrompt).toBe('You are a test agent.');
  });

  it('throws when agent directory does not exist', async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'nodyn-agents-'));
    await expect(loadAgentDef('missing-agent', agentsDir))
      .rejects.toThrow('not found');
  });

  it('throws for invalid agent name with path traversal (../escape)', async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'nodyn-agents-'));
    await expect(loadAgentDef('../escape', agentsDir))
      .rejects.toThrow(/Invalid agent name/);
  });

  it('throws for agent name with slashes', async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'nodyn-agents-'));
    await expect(loadAgentDef('some/agent', agentsDir))
      .rejects.toThrow(/Invalid agent name/);
  });

  it('throws for agent name with special characters', async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'nodyn-agents-'));
    await expect(loadAgentDef('agent!@#', agentsDir))
      .rejects.toThrow(/Invalid agent name/);
  });

  it('accepts agent names with hyphens and underscores', async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'nodyn-agents-'));
    const content = `export default { name: 'my-agent_v2', version: '1.0', defaultTier: 'haiku', systemPrompt: 'x' };`;
    createAgentFile(agentsDir, 'my-agent_v2', content);
    const def = await loadAgentDef('my-agent_v2', agentsDir);
    expect(def.name).toBe('my-agent_v2');
  });

  it('throws when module has no default export', async () => {
    const agentsDir = mkdtempSync(join(tmpdir(), 'nodyn-agents-'));
    createAgentFile(agentsDir, 'no-default', 'export const foo = 1;');
    await expect(loadAgentDef('no-default', agentsDir))
      .rejects.toThrow('must have a default export');
  });
});
