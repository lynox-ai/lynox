// === Autonomy & Tool Display ===

export type AutonomyLevel = 'supervised' | 'guided' | 'autonomous';

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
  run_workflow: 'Running workflow',
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
  // Durable Knowledge Substrate (DK.1) — the tools that replace the legacy memory_* set.
  remember: 'Remembering',
  recall: 'Recalling',
  memory_block_edit: 'Updating memory',
  memory_retire: 'Retiring memory',
  memory_focus: 'Setting focus',
  archive_search: 'Searching archive',
  data_store_create: 'Setting up table',
  data_store_insert: 'Adding data',
  data_store_query: 'Searching data',
  data_store_list: 'Listing tables',
  save_workflow: 'Saving workflow',
  google_gmail: 'Gmail',
  google_sheets: 'Google Sheets',
  google_drive: 'Google Drive',
  google_calendar: 'Google Calendar',
  google_docs: 'Google Docs',
};

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

/**
 * Result of an admission-control reservation against the persistent (daily/
 * monthly) cap. Unlike {@link PersistentBudgetCheck} — which reads only
 * RECORDED spend — a reservation projects an in-flight estimate so parallel
 * background dispatch can't collectively overshoot the cap.
 */
export interface PersistentBudgetReservation {
  allowed: boolean;
  /** Amount actually held (0 when blocked or when no enforcement is active). */
  reservedUSD: number;
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
