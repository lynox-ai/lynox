import type { BenchConfig } from './types.js';
import { MODEL_MAP } from '../../src/types/index.js';

/** Phase 1 config matrix: 3 models × 2 effort levels = 6 configs. */
export const PHASE_1_CONFIGS: readonly BenchConfig[] = [
  { label: 'haiku',           tier: 'haiku',  modelId: MODEL_MAP.haiku,  effort: 'none',   thinking: 'disabled' },
  { label: 'sonnet-medium',   tier: 'sonnet', modelId: MODEL_MAP.sonnet, effort: 'medium', thinking: 'adaptive' },
  { label: 'sonnet-high',     tier: 'sonnet', modelId: MODEL_MAP.sonnet, effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-medium',     tier: 'opus',   modelId: MODEL_MAP.opus,   effort: 'medium', thinking: 'adaptive' },
  { label: 'opus-high',       tier: 'opus',   modelId: MODEL_MAP.opus,   effort: 'high',   thinking: 'adaptive' },
  { label: 'opus-max',        tier: 'opus',   modelId: MODEL_MAP.opus,   effort: 'max',    thinking: 'adaptive' },
];

/** Smoke-test config: single cheapest run to validate infra. */
export const SMOKE_CONFIG: BenchConfig = PHASE_1_CONFIGS[0]!;

export function getConfig(label: string): BenchConfig | undefined {
  return PHASE_1_CONFIGS.find(c => c.label === label);
}
