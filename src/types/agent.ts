// === 4.4 IAgent Interface ===

import type { ToolEntry, StreamHandler } from './tools.js';
import type { IMemory, MemoryScopeRef } from './memory.js';
import type { SecretStoreLike, IsolationConfig } from './security.js';
import type { AutonomyLevel } from './modes.js';

export interface TabQuestion {
  question: string;
  header?: string | undefined;
  options?: string[] | undefined;
}

export interface IAgent {
  readonly name:   string;
  readonly model:  string;
  readonly memory: IMemory | null;
  readonly tools:  ToolEntry[];
  onStream:        StreamHandler | null;
  promptUser?: ((question: string, options?: string[]) => Promise<string>) | undefined;
  promptTabs?: ((questions: TabQuestion[]) => Promise<string[]>) | undefined;
  currentRunId?: string | undefined;
  readonly spawnDepth?: number | undefined;
  readonly secretStore?: SecretStoreLike | undefined;
  readonly userId?: string | undefined;
  readonly activeScopes?: MemoryScopeRef[] | undefined;
  readonly isolation?: IsolationConfig | undefined;
  readonly autonomy?: AutonomyLevel | undefined;
  readonly toolContext: import('../core/tool-context.js').ToolContext;
}
