import { Agent } from '../../src/core/agent.js';
import { calculateCost } from '../../src/core/pricing.js';
import type { StreamEvent, ThinkingMode } from '../../src/types/index.js';
import type { BenchConfig, BenchRun, BenchScenario, BenchUsage } from './types.js';

const EMPTY_USAGE: BenchUsage = {
  inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
};

export interface RunOneOptions {
  readonly scenario: BenchScenario;
  readonly config: BenchConfig;
  readonly iteration: number;
  readonly apiKey: string;
}

export async function runOne({ scenario, config, iteration, apiKey }: RunOneOptions): Promise<BenchRun> {
  const usage: { input: number; output: number; cacheW: number; cacheR: number } = {
    input: 0, output: 0, cacheW: 0, cacheR: 0,
  };
  let toolCallCount = 0;
  let iterationsUsed = 0;

  const thinking: ThinkingMode = config.thinking === 'disabled'
    ? { type: 'disabled' }
    : { type: 'adaptive' };

  const onStream = (event: StreamEvent): void => {
    if (event.type === 'tool_call') toolCallCount++;
    if (event.type === 'turn_end') {
      iterationsUsed++;
      usage.input  += event.usage.input_tokens;
      usage.output += event.usage.output_tokens;
      usage.cacheW += event.usage.cache_creation_input_tokens ?? 0;
      usage.cacheR += event.usage.cache_read_input_tokens     ?? 0;
    }
  };

  const agent = new Agent({
    name: `bench-${config.label}`,
    model: config.modelId,
    apiKey,
    onStream,
    maxIterations: scenario.maxIterations ?? 3,
    thinking,
    ...(config.effort !== 'none' ? { effort: config.effort } : {}),
  });

  const started = Date.now();
  const timeoutMs = scenario.timeoutMs ?? 60_000;

  let output = '';
  let error: string | undefined;
  try {
    output = await Promise.race([
      agent.send(scenario.prompt),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const latencyMs = Date.now() - started;
  const finalUsage: BenchUsage = usage.input === 0 && usage.output === 0 ? EMPTY_USAGE : {
    inputTokens:      usage.input,
    outputTokens:     usage.output,
    cacheWriteTokens: usage.cacheW,
    cacheReadTokens:  usage.cacheR,
  };
  const costUSD = calculateCost(config.modelId, {
    input_tokens: finalUsage.inputTokens,
    output_tokens: finalUsage.outputTokens,
    cache_creation_input_tokens: finalUsage.cacheWriteTokens,
    cache_read_input_tokens: finalUsage.cacheReadTokens,
  });

  return {
    scenarioId: scenario.id,
    configLabel: config.label,
    iteration,
    output,
    usage: finalUsage,
    costUSD,
    latencyMs,
    toolCallCount,
    iterationsUsed,
    ...(error ? { error } : {}),
  };
}
