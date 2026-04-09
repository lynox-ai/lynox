import type { CostGuardConfig, CostSnapshot } from '../types/index.js';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { getPricing } from './pricing.js';

export class CostGuard {
  private readonly maxBudgetUSD: number;
  private readonly warnAtUSD: number;
  private readonly maxIterations: number;
  private readonly pricePerM: { input: number; output: number; cacheWrite: number; cacheRead: number };
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  private iterations = 0;
  private warned = false;

  constructor(config: CostGuardConfig, model: string) {
    this.maxBudgetUSD = config.maxBudgetUSD ?? Infinity;
    this.warnAtUSD = config.warnAtUSD ?? this.maxBudgetUSD * 0.8;
    this.maxIterations = config.maxIterations ?? 200;
    this.pricePerM = getPricing(model);
  }

  /** Record a turn's usage. Returns true if budget is exceeded. */
  recordTurn(usage: BetaUsage): boolean {
    this.inputTokens += usage.input_tokens;
    this.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.outputTokens += usage.output_tokens;
    this.iterations++;
    return this.isExceeded();
  }

  shouldWarn(): boolean {
    if (this.warned) return false;
    const cost = this.estimateCost();
    if (cost >= this.warnAtUSD) {
      this.warned = true;
      return true;
    }
    return false;
  }

  isExceeded(): boolean {
    return this.estimateCost() >= this.maxBudgetUSD || this.iterations >= this.maxIterations;
  }

  snapshot(): CostSnapshot {
    const cost = this.estimateCost();
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUSD: cost,
      iterationsUsed: this.iterations,
      budgetPercent: this.maxBudgetUSD === Infinity ? 0 : Math.round((cost / this.maxBudgetUSD) * 100),
    };
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheReadTokens = 0;
    this.iterations = 0;
    this.warned = false;
  }

  private estimateCost(): number {
    return (this.inputTokens / 1_000_000) * this.pricePerM.input
         + (this.outputTokens / 1_000_000) * this.pricePerM.output
         + (this.cacheWriteTokens / 1_000_000) * this.pricePerM.cacheWrite
         + (this.cacheReadTokens / 1_000_000) * this.pricePerM.cacheRead;
  }
}
