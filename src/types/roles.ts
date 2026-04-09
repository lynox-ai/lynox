// === Roles ===

export interface ToolScopeConfig {
  allowedTools?: string[] | undefined;
  deniedTools?:  string[] | undefined;
}

export interface BatchRequest {
  id:      string;
  task:    string;
  system?: string | undefined;
  label?:  string | undefined;
}

export type { BatchEntry } from '../core/batch-index.js';

export interface BatchResult {
  id:      string;
  status:  'succeeded' | 'errored' | 'expired' | 'canceled';
  result?: string | undefined;
  error?:  string | undefined;
}
