/**
 * Extracted batch processing functions for the Lynox orchestrator.
 * Pure functions operating on explicit parameters — no class state.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageBatchIndividualResponse } from '@anthropic-ai/sdk/resources/messages/batches.js';
import { sleep } from './utils.js';
import type { BatchRequest, BatchResult, ModelTier } from '../types/index.js';
import { MODEL_MAP } from '../types/index.js';
import type { RunHistory } from './run-history.js';
import type { BatchIndex } from './batch-index.js';
import { hashPrompt } from './prompt-hash.js';
import { SYSTEM_PROMPT } from './prompts.js';

/**
 * Batching is wired ONLY for the Anthropic-shaped `client.messages.batches`
 * API today. The OpenAIAdapter (Mistral / openai-compat) and the Vertex client
 * do not expose that shape, so calling into this module with them would throw a
 * cryptic `Cannot read properties of undefined (reading 'create')`.
 *
 * This is a not-yet-implemented state, NOT a permanent design choice: Mistral
 * has its own Batch API (api.mistral.ai/v1/batch/jobs) with a different shape.
 * Making batching provider-agnostic — wiring the Mistral batch path alongside
 * Anthropic and switching MODEL_MAP→getModelId(tier, provider) — is a tracked
 * follow-up. `batch.ts` has no live caller yet, so this guard just turns the
 * cryptic crash into a clear signpost until that work lands.
 */
function assertBatchingSupported(client: Anthropic): void {
  const batches = (client as { messages?: { batches?: unknown } }).messages?.batches;
  if (batches === undefined || batches === null) {
    throw new Error(
      'Message batching is not yet wired for the active provider — only the ' +
      'Anthropic Batches API shape is implemented. Mistral and other providers ' +
      'have their own batch APIs that need a provider-specific path.',
    );
  }
}

export function parseBatchItem(item: MessageBatchIndividualResponse): BatchResult {
  const { custom_id, result } = item;
  switch (result.type) {
    case 'succeeded': {
      const parts: string[] = [];
      for (const block of result.message.content) {
        if (block.type === 'text') {
          parts.push(block.text);
        }
      }
      return { id: custom_id, status: 'succeeded', result: parts.join('') };
    }
    case 'errored':
      return { id: custom_id, status: 'errored', error: result.error.error.message };
    case 'canceled':
      return { id: custom_id, status: 'canceled' };
    case 'expired':
      return { id: custom_id, status: 'expired' };
  }
}

export interface BatchConfig {
  modelTier: ModelTier;
  maxTokens: number;
  systemPrompt: string | undefined;
  systemPromptSuffix: string | undefined;
}

export async function submitBatch(
  client: Anthropic,
  reqs: BatchRequest[],
  config: BatchConfig,
  runHistory: RunHistory | null,
  batchIndex: BatchIndex,
  contextId: string,
): Promise<{ batchId: string; parentRunId: string | null }> {
  assertBatchingSupported(client);
  const model = MODEL_MAP[config.modelTier] ?? MODEL_MAP['deep'];
  const basePrompt = config.systemPrompt ?? SYSTEM_PROMPT;
  const effectivePrompt = config.systemPromptSuffix
    ? basePrompt + config.systemPromptSuffix
    : basePrompt;
  const batchPromptHash = hashPrompt(effectivePrompt);

  // Create parent run record
  let parentRunId: string | null = null;
  if (runHistory) {
    try {
      parentRunId = runHistory.insertRun({
        taskText: `Batch: ${reqs.length} items`,
        modelTier: config.modelTier,
        modelId: model,
        promptHash: batchPromptHash,
        runType: 'batch_parent',
        contextId,
      });
      runHistory.insertPromptSnapshot(batchPromptHash, 'default', effectivePrompt);
    } catch { /* fire-and-forget */ }
  }

  const batch = await client.messages.batches.create({
    requests: reqs.map(req => ({
      custom_id: req.id,
      params: {
        model,
        max_tokens: config.maxTokens,
        system: req.system ?? SYSTEM_PROMPT,
        messages: [{ role: 'user' as const, content: req.task }],
      },
    })),
  });

  // Create child run records
  if (runHistory && parentRunId) {
    for (const req of reqs) {
      try {
        runHistory.insertRun({
          taskText: req.task,
          modelTier: config.modelTier,
          modelId: model,
          promptHash: batchPromptHash,
          runType: 'batch_item',
          batchParentId: parentRunId,
          contextId,
        });
      } catch { /* fire-and-forget */ }
    }
  }

  await batchIndex.save(batch.id, {
    submitted_at: new Date().toISOString(),
    request_count: reqs.length,
    label: reqs[0]?.label ?? reqs[0]?.id ?? 'batch',
  });

  return { batchId: batch.id, parentRunId };
}

export async function pollBatch(
  client: Anthropic,
  batchId: string,
): Promise<BatchResult[]> {
  assertBatchingSupported(client);
  let delay = 30_000;
  const maxDelay = 300_000;

  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === 'ended') {
      break;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }

  const results: BatchResult[] = [];
  const decoder = await client.messages.batches.results(batchId);
  for await (const item of decoder) {
    results.push(parseBatchItem(item));
  }
  return results;
}
