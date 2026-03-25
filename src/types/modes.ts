// === Autonomy & Tool Display ===

export type AutonomyLevel = 'supervised' | 'guided' | 'autonomous';
export const AUTONOMY_LEVEL_SET: ReadonlySet<AutonomyLevel> = new Set(['supervised', 'guided', 'autonomous']);

/** Customer-facing display names for tools (internal -> user-visible) */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  bash: 'Running command',
  read_file: 'Reading file',
  write_file: 'Writing file',
  batch_files: 'Processing files',
  http_request: 'Making request',
  web_research: 'Searching the web',
  spawn_agent: 'Delegating',
  ask_user: 'Asking you',
  run_pipeline: 'Running workflow',
  plan_task: 'Planning',
  task_create: 'Creating task',
  task_update: 'Updating task',
  task_list: 'Listing tasks',
  memory_store: 'Remembering',
  memory_recall: 'Recalling',
  memory_delete: 'Forgetting',
  memory_update: 'Updating knowledge',
  memory_list: 'Listing knowledge',
  memory_promote: 'Sharing knowledge',
  data_store_create: 'Setting up table',
  data_store_insert: 'Adding data',
  data_store_query: 'Searching data',
  data_store_list: 'Listing tables',
  capture_process: 'Saving workflow',
  promote_process: 'Converting to workflow',
  google_gmail: 'Gmail',
  google_sheets: 'Google Sheets',
  google_drive: 'Google Drive',
  google_calendar: 'Google Calendar',
  google_docs: 'Google Docs',
};

// === Trigger types (FileTrigger used by watchdog) ===

export interface FileTriggerConfig { type: 'file'; dir: string; glob?: string | undefined; debounceMs?: number | undefined; }
export interface TriggerEvent { source: string; payload: unknown; timestamp: string; }
export type TriggerCallback = (event: TriggerEvent) => Promise<void>;
export interface ITrigger { readonly type: string; start(callback: TriggerCallback): void; stop(): void; }

// === Cost ===

export interface CostGuardConfig {
  maxBudgetUSD?: number | undefined;
  warnAtUSD?: number | undefined;
  maxIterations?: number | undefined;
}

export interface PersistentBudgetCheck {
  allowed: boolean;
  todayCostUSD: number;
  monthCostUSD: number;
  dailyLimitUSD: number | null;
  monthlyLimitUSD: number | null;
  reason?: string | undefined;
}

export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number;
  iterationsUsed: number;
  budgetPercent: number;
}

// === Pre-Approval ===

/** A single pre-approved operation pattern */
export interface PreApprovalPattern {
  tool: string;        // 'bash', 'write_file', 'read_file', etc.
  pattern: string;     // Glob pattern: "npm run *", "dist/**"
  label: string;       // Human-readable description
  risk: 'low' | 'medium' | 'high';  // No 'critical' — those can't be approved
}

/** A set of pre-approved patterns for a session */
export interface PreApprovalSet {
  id: string;
  approvedAt: string;
  approvedBy: 'operator';
  taskSummary: string;
  patterns: PreApprovalPattern[];
  maxUses: number;           // 0 = unlimited
  ttlMs: number;             // 0 = session-scoped
  usageCounts: number[];     // Per-pattern usage counter
}
