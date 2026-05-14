import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDef } from '../types/orchestration.js';

const SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export async function loadAgentDef(name: string, agentsDir: string): Promise<AgentDef> {
  if (!SAFE_AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name: "${name}" — must match /^[a-zA-Z0-9_-]+$/`);
  }
  const defPath = join(agentsDir, name, 'index.js');
  if (!existsSync(defPath)) {
    throw new Error(`Agent "${name}" not found — expected: ${defPath}`);
  }
  const mod: unknown = await import(pathToFileURL(defPath).href);
  if (typeof mod !== 'object' || mod === null) {
    throw new Error(`Agent "${name}": module must export an object`);
  }
  const def = (mod as Record<string, unknown>)['default'];
  if (typeof def !== 'object' || def === null) {
    throw new Error(`Agent "${name}": module must have a default export`);
  }
  return def as AgentDef;
}
