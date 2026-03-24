import type {
  ModeConfig,
  OperationalMode,
  CostSnapshot,
  GoalState,
  StreamEvent,
  StreamHandler,
  TriggerEvent,
  ITrigger,
  ModelTier,
  PreApprovalSet,
  TabQuestion,
  InlinePipelineStep,
} from '../types/index.js';
import { MODEL_MAP } from '../types/index.js';
import { getErrorMessage } from './utils.js';
import { buildApprovalSet } from './pre-approve.js';


import { PreApproveAudit } from './pre-approve-audit.js';
import type { RunHistory } from './run-history.js';
import { CostGuard } from './cost-guard.js';
import { GoalTracker } from './goal-tracker.js';
import { createTrigger } from './triggers/index.js';
import { isFeatureEnabled } from './features.js';
import { goalUpdateTool } from '../tools/builtin/goal-update.js';
import { channels } from './observability.js';
import { planDAG } from './dag-planner.js';
import type { DagPlanResult } from './dag-planner.js';

const MAX_PENDING_TRIGGERS = 100;

interface ModeOrchestrator {
  getModelTier(): ModelTier;
  run(task: string): Promise<string>;
  abort(): void;
  registerTool<T>(entry: import('../types/index.js').ToolEntry<T>): void;
  registerPipelineTools(): void;
  onStream: StreamHandler | null;
  getAgent(): import('./agent.js').Agent | null;
  getApiConfig(): { apiKey?: string | undefined; apiBaseURL?: string | undefined };
  getPromptTabs(): ((questions: TabQuestion[]) => Promise<string[]>) | null;
  getRunHistory(): RunHistory | null;
  getToolContext(): import('./tool-context.js').ToolContext;
  _recreateAgent(overrides?: {
    maxIterations?: number | undefined;
    continuationPrompt?: string | undefined;
    excludeTools?: string[] | undefined;
    systemPromptSuffix?: string | undefined;
    autonomy?: import('../types/index.js').AutonomyLevel | undefined;
    preApproval?: import('../types/index.js').PreApprovalSet | undefined;
    audit?: import('../types/index.js').PreApproveAuditLike | undefined;
  }): void;
}

/**
 * Context passed to registered mode handlers.
 * Exposes controller internals needed by Pro modes without making private methods public.
 */
export interface ModeControllerContext {
  readonly modeConfig: ModeConfig;
  wrapStreamHandler(orchestrator: ModeOrchestrator): void;
  startTriggers(orchestrator: ModeOrchestrator, configs: import('../types/index.js').TriggerConfig[]): void;
  buildPreApproval(orchestrator: ModeOrchestrator): Promise<import('../types/index.js').PreApprovalSet | undefined>;
  resolveModel(orchestrator: ModeOrchestrator): string;
  goalSystemPromptSuffix(goal: string): string;
  setCostGuard(guard: CostGuard | null): void;
  setGoalTracker(tracker: GoalTracker | null): void;
  setJournal(journal: Journal | null): void;
  setHeartbeatTimer(timer: ReturnType<typeof setInterval> | null): void;
  setShutdownHandler(handler: (() => void) | null): void;
  getShutdownHandler(): (() => void) | null;
  isQuietHours(): boolean;
  registerGoalTools(orchestrator: ModeOrchestrator): void;
  appendJournal(entry: { timestamp: string; type: string; message: string; source?: string | undefined; metadata?: Record<string, unknown> | undefined }): void;
  requestTeardown(): void;
}

/**
 * Handler for a pluggable operational mode.
 * Pro modes (sentinel, daemon, swarm) can register handlers via ModeController.registerMode().
 */
export interface ModeHandler {
  apply(ctx: ModeControllerContext, orchestrator: ModeOrchestrator): Promise<void>;
  teardown?(ctx: ModeControllerContext): Promise<void>;
}

/** Generic journal interface for mode handlers (e.g. DaemonJournal in Pro). */
export interface Journal {
  append(entry: { timestamp: string; type: string; message: string; source?: string | undefined; metadata?: Record<string, unknown> | undefined }): Promise<void>;
}

export { type ModeOrchestrator };

export class ModeController {
  private readonly modeConfig: ModeConfig;
  private costGuard: CostGuard | null = null;
  private goalTracker: GoalTracker | null = null;
  private journal: Journal | null = null;
  private _audit: PreApproveAudit | null = null;
  private triggers: ITrigger[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingTriggers: TriggerEvent[] = [];
  private running = false;
  private originalStreamHandler: StreamHandler | null = null;
  private orchestrator: ModeOrchestrator | null = null;
  private shutdownHandler: (() => void) | null = null;
  private dagPlan: DagPlanResult | null = null;
  private dagResults: string | null = null;
  private _activeHandler: ModeHandler | null = null;

  // --- Mode Registry ---

  private static _modeHandlers = new Map<string, ModeHandler>();

  /**
   * Register a pluggable mode handler.
   * Pro modes call this at startup to register sentinel/daemon/swarm.
   */
  static registerMode(mode: string, handler: ModeHandler): void {
    ModeController._modeHandlers.set(mode, handler);
  }

  /** Get all registered mode names. */
  static getRegisteredModes(): string[] {
    return [...ModeController._modeHandlers.keys()];
  }

  /** Clear all registered modes (for tests). */
  static clearModes(): void {
    ModeController._modeHandlers.clear();
  }

  constructor(config: ModeConfig) {
    this.modeConfig = config;
  }

  getMode(): OperationalMode {
    return this.modeConfig.mode;
  }

  getCostSnapshot(): CostSnapshot | null {
    return this.costGuard?.snapshot() ?? null;
  }

  getGoalState(): GoalState | null {
    return this.goalTracker?.getState() ?? null;
  }

  async apply(orchestrator: ModeOrchestrator): Promise<void> {
    this.orchestrator = orchestrator;
    this.originalStreamHandler = orchestrator.onStream;

    const mode = this.modeConfig.mode;
    channels.modeChange.publish({ mode, config: this.modeConfig });

    // Check registry for pluggable modes (Pro modes register here)
    const registeredHandler = ModeController._modeHandlers.get(mode);
    if (registeredHandler) {
      await registeredHandler.apply(this._buildContext(), orchestrator);
      this._activeHandler = registeredHandler;
    } else {
      // Core modes
      switch (mode) {
        case 'interactive':
          await this._applyInteractive(orchestrator);
          break;
        case 'autopilot':
          await this._applyAutopilot(orchestrator);
          break;
        default:
          throw new Error(`Mode "${mode}" is not registered. Install nodyn-pro for sentinel/daemon/swarm modes, or register a handler via ModeController.registerMode().`);
      }
    }
  }

  async teardown(): Promise<void> {
    for (const trigger of this.triggers) {
      trigger.stop();
    }
    this.triggers = [];

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.shutdownHandler) {
      process.removeListener('SIGINT', this.shutdownHandler);
      process.removeListener('SIGTERM', this.shutdownHandler);
      this.shutdownHandler = null;
    }

    if (this.journal) {
      await this.journal.append({
        timestamp: new Date().toISOString(),
        type: 'heartbeat',
        message: 'Mode teardown — daemon stopped.',
      });
    }

    // Teardown registered handler if active
    if (this._activeHandler?.teardown) {
      await this._activeHandler.teardown(this._buildContext());
    }
    this._activeHandler = null;

    if (this.orchestrator) {
      this.orchestrator.getToolContext().goalTracker = null;
    }
    this.goalTracker = null;
    this.costGuard = null;
    this.journal = null;
    this.pendingTriggers = [];
    this.running = false;

    if (this.orchestrator) {
      this.orchestrator.onStream = this.originalStreamHandler;
    }
  }

  /**
   * Build a ModeControllerContext that exposes private methods to registered mode handlers.
   */
  private _buildContext(): ModeControllerContext {
    return {
      modeConfig: this.modeConfig,
      wrapStreamHandler: (orch: ModeOrchestrator) => this._wrapStreamHandler(orch),
      startTriggers: (orch: ModeOrchestrator, configs: import('../types/index.js').TriggerConfig[]) => this._startTriggers(orch, configs),
      buildPreApproval: (orch: ModeOrchestrator) => this._buildPreApproval(orch),
      resolveModel: (orch: ModeOrchestrator) => this._resolveModel(orch),
      goalSystemPromptSuffix: (goal: string) => this._goalSystemPromptSuffix(goal),
      setCostGuard: (guard: CostGuard | null) => { this.costGuard = guard; },
      setGoalTracker: (tracker: GoalTracker | null) => { this.goalTracker = tracker; },
      setJournal: (journal: Journal | null) => { this.journal = journal; },
      setHeartbeatTimer: (timer: ReturnType<typeof setInterval> | null) => { this.heartbeatTimer = timer; },
      setShutdownHandler: (handler: (() => void) | null) => { this.shutdownHandler = handler; },
      getShutdownHandler: () => this.shutdownHandler,
      isQuietHours: () => this._isQuietHours(),
      registerGoalTools: (orch: ModeOrchestrator) => {
        this.goalTracker = new GoalTracker(this.modeConfig.goal!);
        orch.getToolContext().goalTracker = this.goalTracker;
        orch.registerTool(goalUpdateTool);
      },
      appendJournal: (entry) => {
        if (this.journal) {
          void this.journal.append(entry);
        }
      },
      requestTeardown: () => { void this.teardown(); },
    };
  }

  // === Mode implementations ===

  private async _applyInteractive(orchestrator: ModeOrchestrator): Promise<void> {
    const costConfig = this.modeConfig.costGuard;
    if (costConfig) {
      const model = this._resolveModel(orchestrator);
      this.costGuard = new CostGuard(costConfig, model);
      this._wrapStreamHandler(orchestrator);
    }
    const maxIter = this.modeConfig.maxIterations ?? 20;
    const preApproval = await this._buildPreApproval(orchestrator);
    orchestrator._recreateAgent({
      maxIterations: maxIter,
      autonomy: this.modeConfig.autonomy,
      preApproval,
      audit: this._audit ?? undefined,
    });
  }

  private async _applyAutopilot(orchestrator: ModeOrchestrator): Promise<void> {
    const goal = this.modeConfig.goal;
    if (!goal) throw new Error('Autopilot mode requires a goal.');

    const model = this._resolveModel(orchestrator);
    this.costGuard = new CostGuard(
      this.modeConfig.costGuard ?? { maxBudgetUSD: 5 },
      model,
    );

    this.goalTracker = new GoalTracker(goal);
    orchestrator.getToolContext().goalTracker = this.goalTracker;

    orchestrator.registerTool(goalUpdateTool);
    this._wrapStreamHandler(orchestrator);

    const maxIter = this.modeConfig.maxIterations ?? 50;
    let goalPromptSuffix = this._goalSystemPromptSuffix(goal);
    const preApproval = await this._buildPreApproval(orchestrator);

    // Auto-DAG: decompose goal into pipeline if enabled
    if (this.modeConfig.enableAutoDAG) {
      orchestrator.registerPipelineTools();
      const dagResult = await this._buildAutoDAG(orchestrator, goal);
      if (dagResult) {
        this.dagPlan = dagResult;
        // Register subtasks from DAG steps
        for (const step of dagResult.steps) {
          this.goalTracker.addSubtask(step.task.slice(0, 100));
        }

        goalPromptSuffix += `\n\n## Auto-DAG Pipeline
Dein Ziel wurde in eine DAG-Pipeline zerlegt und wird automatisch ausgefuehrt.
- Ergebnisse pruefen. Goal complete markieren wenn alle Schritte erfolgreich.
- Fehlgeschlagene Schritte manuell behandeln.
- Do NOT repeat already-completed steps.`;
      }
    }

    orchestrator._recreateAgent({
      maxIterations: maxIter,
      continuationPrompt: this.goalTracker.continuationPrompt(),
      excludeTools: ['ask_user'],
      systemPromptSuffix: goalPromptSuffix,
      autonomy: this.modeConfig.autonomy,
      preApproval,
      audit: this._audit ?? undefined,
    });
  }

  /** Build auto-DAG plan for autopilot mode */
  private async _buildAutoDAG(
    orchestrator: ModeOrchestrator,
    goal: string,
  ): Promise<DagPlanResult | null> {
    const apiConfig = orchestrator.getApiConfig();
    const maxSteps = this.modeConfig.maxDagSteps ?? 10;

    const plan = await planDAG(goal, {
      apiKey: apiConfig.apiKey,
      apiBaseURL: apiConfig.apiBaseURL,
      maxSteps,
    });

    if (!plan || plan.steps.length === 0) return null;

    // Show approval dialog unless skipped
    if (!this.modeConfig.skipDagApproval) {
      const promptTabs = orchestrator.getPromptTabs();
      if (promptTabs) {
        const stepSummary = plan.steps.map((s, i) => `${i + 1}. [${s.id}] ${s.task.slice(0, 80)}`).join('\n');
        const answers = await promptTabs([{
          question: `Auto-DAG plan (${plan.steps.length} steps, ~$${plan.estimatedCost.toFixed(4)}):\n${stepSummary}\n\nApprove?`,
          header: 'Auto-DAG Pipeline',
          options: ['Approve', 'Skip DAG'],
        }]);
        if (answers[0] !== 'Approve') return null;
      }
    }

    return plan;
  }

  /** Execute auto-DAG plan and return results string for injection */
  async executeAutoDAG(orchestrator: ModeOrchestrator): Promise<string | null> {
    if (!this.dagPlan) return null;

    try {
      const { runManifest } = await import('../orchestrator/runner.js');
      const config = orchestrator.getApiConfig();
      const userConfig: import('../types/index.js').NodynUserConfig = {
        api_key: config.apiKey,
        api_base_url: config.apiBaseURL,
      };

      const manifest = {
        manifest_version: '1.1' as const,
        name: 'auto-dag',
        triggered_by: 'autopilot',
        context: {},
        agents: this.dagPlan.steps.map((s: InlinePipelineStep) => ({
          id: s.id,
          agent: s.id,
          runtime: 'inline' as const,
          task: s.task,
          model: s.model,
          input_from: s.input_from,
        })),
        gate_points: [],
        on_failure: 'continue' as const,
        execution: 'parallel' as const,
      };

      const agent = orchestrator.getAgent();
      const parentTools = agent?.tools ?? [];
      const state = await runManifest(manifest, userConfig, { parentTools, autonomy: this.modeConfig.autonomy });

      const results: string[] = [];
      for (const [id, output] of state.outputs) {
        const status = output.skipped ? 'skipped' : output.error ? 'failed' : 'completed';
        results.push(`[${id}] ${status}: ${output.result.slice(0, 500) || output.error || output.skipReason || ''}`);

        // Mark subtasks complete in goal tracker
        if (!output.skipped && !output.error && this.goalTracker) {
          this.goalTracker.completeSubtask(output.result.slice(0, 100));
        }
      }

      this.dagResults = `<auto_dag_results>\nPipeline status: ${state.status}\n${results.join('\n')}\n</auto_dag_results>`;
      return this.dagResults;
    } catch {
      return null;
    }
  }

  getDagResults(): string | null {
    return this.dagResults;
  }

  // === Helpers ===

  private _initAudit(orchestrator: ModeOrchestrator): void {
    const history = orchestrator.getRunHistory();
    if (history) {
      this._audit = new PreApproveAudit(history);
    }
  }

  private async _buildPreApproval(orchestrator: ModeOrchestrator): Promise<PreApprovalSet | undefined> {
    this._initAudit(orchestrator);

    // If CLI patterns provided → use directly (skip planning)
    const cliPatterns = this.modeConfig.autoApprovePatterns;
    if (cliPatterns?.length) {
      const set = buildApprovalSet(cliPatterns, {
        maxUses: 10,
        ttlMs: 0,
        taskSummary: this.modeConfig.goal ?? 'mode session',
      });
      this._audit?.recordSetCreated(set);
      return set;
    }

    // No CLI patterns and no automatic planning — skip pre-approval
    return undefined;
  }

  private _resolveModel(orchestrator: ModeOrchestrator): string {
    return MODEL_MAP[orchestrator.getModelTier()];
  }

  private _goalSystemPromptSuffix(goal: string): string {
    return `\n\n## Goal-Tracking Mode\nGoal: ${goal}\n\nUse goal_update to track progress:\n- "add_subtask": Register work steps\n- "complete_subtask": Mark steps as done\n- "goal_complete": When the overall goal is achieved\n- "goal_failed": When the goal cannot be reached\n\nWork autonomously. Make decisions yourself — no user questions.`;
  }

  private _wrapStreamHandler(orchestrator: ModeOrchestrator): void {
    const original = orchestrator.onStream;
    const self = this;

    orchestrator.onStream = async (event: StreamEvent) => {
      // Track costs on turn_end
      if (event.type === 'turn_end' && self.costGuard) {
        const costBefore = self.costGuard.snapshot().estimatedCostUSD;
        const exceeded = self.costGuard.recordTurn(event.usage);
        const costAfter = self.costGuard.snapshot().estimatedCostUSD;
        self.goalTracker?.recordIteration();
        self.goalTracker?.recordCost(costAfter - costBefore);

        // Keep continuation prompt in sync with goal state
        if (self.goalTracker) {
          orchestrator.getAgent()?.setContinuationPrompt(self.goalTracker.continuationPrompt());
        }

        if (self.costGuard.shouldWarn() && original) {
          await original({ type: 'cost_warning', snapshot: self.costGuard.snapshot(), agent: event.agent });
        }

        if (exceeded) {
          // Pass through the turn_end event BEFORE aborting, so CLI renders the final output
          if (original) {
            await original(event);
            await original({ type: 'cost_warning', snapshot: self.costGuard.snapshot(), agent: event.agent });
          }
          orchestrator.abort();
          return;
        }
      }

      // Emit goal updates
      if (event.type === 'tool_result' && self.goalTracker) {
        // Check for text-marker fallback
        if (typeof event.result === 'string') {
          self.goalTracker.parseResponse(event.result);
        }

        const state = self.goalTracker.getState();
        if (original) {
          await original({ type: 'goal_update', goal: state, agent: event.agent });
        }
        channels.goalUpdate.publish({ goal: state });

        // Stop agent when goal is complete
        if (self.goalTracker.isComplete()) {
          // Clear continuation prompt so the loop exits cleanly after this turn
          orchestrator.getAgent()?.setContinuationPrompt(undefined);
        }
      }

      // Journal logging for daemon mode
      if (self.journal && event.type === 'turn_end') {
        void self.journal.append({
          timestamp: new Date().toISOString(),
          type: 'response',
          message: `Turn ended (${event.stop_reason})`,
          metadata: { usage: event.usage },
        });
      }

      // Pass through to original handler
      if (original) {
        await original(event);
      }
    };
  }

  private _startTriggers(orchestrator: ModeOrchestrator, configs: import('../types/index.js').TriggerConfig[]): void {
    if (!isFeatureEnabled('triggers')) {
      throw new Error('Triggers are not enabled. Set NODYN_FEATURE_TRIGGERS=1 to enable daemon/sentinel modes with triggers.');
    }
    for (const tc of configs) {
      const trigger = createTrigger(tc);
      trigger.start(async (event: TriggerEvent) => {
        channels.triggerFire.publish({ event });

        if (this.journal) {
          void this.journal.append({
            timestamp: event.timestamp,
            type: 'trigger',
            source: event.source,
            message: `Trigger fired: ${event.source}`,
            metadata: event.payload as Record<string, unknown> | undefined,
          });
        }

        // Queue if already running
        if (this.running) {
          this._enqueueTrigger(event);
          return;
        }

        await this._drainTriggerQueue(orchestrator, event);
      });
      this.triggers.push(trigger);
    }
  }

  private _enqueueTrigger(event: TriggerEvent): void {
    if (this.pendingTriggers.length >= MAX_PENDING_TRIGGERS) {
      const dropped = this.pendingTriggers.shift();
      if (this.journal) {
        void this.journal.append({
          timestamp: new Date().toISOString(),
          type: 'error',
          source: event.source,
          message: `Trigger queue exceeded ${MAX_PENDING_TRIGGERS} pending events; dropping oldest event.`,
          metadata: dropped
            ? { droppedSource: dropped.source, queued: this.pendingTriggers.length }
            : { queued: this.pendingTriggers.length },
        });
      }
    }
    this.pendingTriggers.push(event);
  }

  private async _drainTriggerQueue(orchestrator: ModeOrchestrator, initialEvent: TriggerEvent): Promise<void> {
    this.running = true;
    try {
      let event: TriggerEvent | undefined = initialEvent;
      while (event) {
        await this._runTrigger(orchestrator, event);
        event = this.pendingTriggers.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async _runTrigger(orchestrator: ModeOrchestrator, event: TriggerEvent): Promise<void> {
    try {
      const original = this.originalStreamHandler ?? orchestrator.onStream;
      if (original) {
        await original({ type: 'trigger', event, agent: 'nodyn' });
      }

      const task = this._expandTemplate(event);
      await orchestrator.run(task);
    } catch (err: unknown) {
      if (this.journal) {
        void this.journal.append({
          timestamp: new Date().toISOString(),
          type: 'error',
          source: event.source,
          message: getErrorMessage(err),
        });
      }
    }
  }

  private _expandTemplate(event: TriggerEvent): string {
    let template = this.modeConfig.taskTemplate ?? '{payload}';
    const payload = event.payload as Record<string, unknown> | undefined;

    template = template.replace(/\{payload\}/g, JSON.stringify(payload));
    template = template.replace(/\{source\}/g, event.source);
    template = template.replace(/\{time\}/g, event.timestamp);

    if (event.source === 'file' && payload) {
      template = template.replace(/\{files\}/g, String(payload['files'] ?? ''));
      template = template.replace(/\{dir\}/g, String(payload['dir'] ?? ''));
    } else if (event.source === 'http' && payload) {
      template = template.replace(/\{body\}/g, JSON.stringify(payload['body']));
      template = template.replace(/\{method\}/g, String(payload['method'] ?? ''));
      template = template.replace(/\{path\}/g, String(payload['path'] ?? ''));
    } else if (event.source === 'cron' && payload) {
      template = template.replace(/\{expression\}/g, String(payload['expression'] ?? ''));
    } else if (event.source === 'git' && payload) {
      template = template.replace(/\{hook\}/g, String(payload['hook'] ?? ''));
    }

    return template;
  }

  private _isQuietHours(): boolean {
    if (!this.modeConfig.quietHours) return false;
    const hour = new Date().getHours();
    const { start, end } = this.modeConfig.quietHours;
    if (start <= end) {
      return hour >= start && hour < end;
    }
    // Wraps midnight (e.g. 22-06)
    return hour >= start || hour < end;
  }
}
