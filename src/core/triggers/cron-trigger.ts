import type { ITrigger, TriggerCallback, CronTriggerConfig } from '../../types/index.js';

export class CronTrigger implements ITrigger {
  readonly type = 'cron';
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly expression: string;

  constructor(config: CronTriggerConfig) {
    this.expression = config.expression;
    this.intervalMs = parseInterval(config.expression);
  }

  start(callback: TriggerCallback): void {
    this.timer = setInterval(() => {
      void callback({
        source: 'cron',
        payload: { expression: this.expression, time: new Date().toISOString() },
        timestamp: new Date().toISOString(),
      }).catch(() => {
        // Ignore callback failures; the next tick should still be delivered.
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Parse shorthand intervals: "30s", "5m", "1h" */
function parseInterval(expression: string): number {
  const match = expression.match(/^(\d+)\s*(s|m|h)$/i);
  if (!match) {
    throw new Error(`Invalid cron expression: "${expression}". Use shorthand like "30s", "5m", "1h".`);
  }
  const value = parseInt(match[1]!, 10);
  if (value <= 0) {
    throw new Error(`Invalid cron expression: "${expression}". Interval must be greater than 0.`);
  }
  const unit = match[2]!.toLowerCase();
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}
