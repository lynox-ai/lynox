import type { GoalState, GoalSubtask } from '../types/index.js';

export class GoalTracker {
  private readonly goal: string;
  private readonly subtasks: GoalSubtask[] = [];
  private status: 'active' | 'complete' | 'failed' = 'active';
  private iterations = 0;
  private costUSD = 0;
  private readonly startedAt: string;
  private completedAt: string | undefined;

  constructor(goal: string) {
    this.goal = goal;
    this.startedAt = new Date().toISOString();
  }

  addSubtask(description: string): void {
    this.subtasks.push({ description, status: 'pending' });
  }

  completeSubtask(description: string): void {
    const task = this.subtasks.find(t => t.description === description && t.status !== 'complete');
    if (task) {
      task.status = 'complete';
    }
  }

  markComplete(): void {
    this.status = 'complete';
    this.completedAt = new Date().toISOString();
  }

  markFailed(reason: string): void {
    this.status = 'failed';
    this.completedAt = new Date().toISOString();
    // Add failure reason as a failed subtask
    this.subtasks.push({ description: `FAILED: ${reason}`, status: 'failed' });
  }

  /** Fallback text marker parsing */
  parseResponse(text: string): void {
    if (text.includes('[GOAL_COMPLETE]')) {
      this.markComplete();
    } else if (text.includes('[GOAL_FAILED]') || text.includes('[GOAL_FAILED:')) {
      const match = text.match(/\[GOAL_FAILED(?::\s*(.+?))?\]/);
      this.markFailed(match?.[1] ?? 'Unknown reason');
    }
  }

  recordIteration(): void {
    this.iterations++;
  }

  recordCost(usd: number): void {
    this.costUSD += usd;
  }

  continuationPrompt(): string {
    const completed = this.subtasks.filter(t => t.status === 'complete').length;
    const total = this.subtasks.length;
    const progress = total > 0 ? `Progress: ${completed}/${total} subtasks complete.` : 'No subtasks registered yet.';
    const pending = this.subtasks
      .filter(t => t.status === 'pending')
      .map(t => `- ${t.description}`)
      .join('\n');
    const pendingStr = pending ? `\n\nPending subtasks:\n${pending}` : '';
    return `Your goal: ${this.goal}\n${progress}${pendingStr}\n\nContinue working towards the goal. If complete, call goal_update with action "goal_complete".`;
  }

  isComplete(): boolean {
    return this.status === 'complete' || this.status === 'failed';
  }

  getState(): GoalState {
    return {
      goal: this.goal,
      subtasks: [...this.subtasks],
      status: this.status,
      iterationsUsed: this.iterations,
      costUSD: this.costUSD,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  /** Generate a summary from subtask state (for history truncation) */
  summary(): string {
    const completed = this.subtasks.filter(t => t.status === 'complete');
    if (completed.length === 0) return 'No subtasks completed yet.';
    return completed.map(t => `- Done: ${t.description}`).join('\n');
  }
}
