// === Operational Modes ===

export type AutonomyLevel = 'supervised' | 'guided' | 'autonomous';
export const AUTONOMY_LEVEL_SET: ReadonlySet<AutonomyLevel> = new Set(['supervised', 'guided', 'autonomous']);
export type TriggerSource = 'on-demand' | 'reactive' | 'proactive';
export type PersistenceStrategy = 'bounded' | 'continuous';
export type OperationalMode = 'interactive' | 'autopilot' | 'sentinel' | 'daemon' | 'swarm';

/** Customer-facing display names for modes (internal -> user-visible) */
export const MODE_DISPLAY: Record<OperationalMode, string> = {
  interactive: 'assistant', autopilot: 'autopilot',
  sentinel: 'watchdog', daemon: 'background', swarm: 'team',
};

/** Reverse mapping: customer-facing name -> internal mode */
export const MODE_FROM_DISPLAY: Record<string, OperationalMode> = {
  assistant: 'interactive', autopilot: 'autopilot',
  watchdog: 'sentinel', background: 'daemon', team: 'swarm',
};

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
  goal_update: 'Updating progress',
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
  list_playbooks: 'Listing playbooks',
  suggest_playbook: 'Suggesting playbook',
  extract_playbook: 'Extracting playbook',
  google_gmail: 'Gmail',
  google_sheets: 'Google Sheets',
  google_drive: 'Google Drive',
  google_calendar: 'Google Calendar',
  google_docs: 'Google Docs',
};

export interface FileTriggerConfig { type: 'file'; dir: string; glob?: string | undefined; debounceMs?: number | undefined; }
export interface HttpTriggerConfig { type: 'http'; port: number; path?: string | undefined; hmacSecret?: string | undefined; }
export interface CronTriggerConfig { type: 'cron'; expression: string; }
export interface GitTriggerConfig  { type: 'git'; hook: 'post-commit' | 'post-merge' | 'post-checkout'; repoDir?: string | undefined; }
export type TriggerConfig = FileTriggerConfig | HttpTriggerConfig | CronTriggerConfig | GitTriggerConfig;

export interface TriggerEvent { source: string; payload: unknown; timestamp: string; }
export type TriggerCallback = (event: TriggerEvent) => Promise<void>;
export interface ITrigger { readonly type: string; start(callback: TriggerCallback): void; stop(): void; }

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

export interface GoalSubtask { description: string; status: 'pending' | 'active' | 'complete' | 'failed'; }
export interface GoalState {
  goal: string;
  subtasks: GoalSubtask[];
  status: 'active' | 'complete' | 'failed';
  iterationsUsed: number;
  costUSD: number;
  startedAt: string;
  completedAt?: string | undefined;
}

export interface ModeConfig {
  mode: OperationalMode;
  autonomy?: AutonomyLevel | undefined;
  triggers?: TriggerConfig[] | undefined;
  persistence?: PersistenceStrategy | undefined;
  costGuard?: CostGuardConfig | undefined;
  maxIterations?: number | undefined;  // 0 = unlimited (OpenClaw-style)
  goal?: string | undefined;
  taskTemplate?: string | undefined;
  heartbeatMs?: number | undefined;
  quietHours?: { start: number; end: number } | undefined;
  autoApprovePatterns?: PreApprovalPattern[] | undefined;
  maxWorkers?: number | undefined;
  skipPreApprove?: boolean | undefined;
  autoApproveAll?: boolean | undefined;
  enableAutoDAG?: boolean | undefined;
  skipDagApproval?: boolean | undefined;
  maxDagSteps?: number | undefined;
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
