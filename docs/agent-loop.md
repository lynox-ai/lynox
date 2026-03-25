# Agent Loop & Streaming

## Agentic Loop Lifecycle

The `Agent` class (`src/core/agent.ts`) implements the core agentic loop. Each call to `agent.send(message)` runs up to **20 iterations** (configurable via `maxIterations` in `AgentConfig`).

```
send(userMessage)
    │
    ▼
messages.push({ role: 'user', content: userMessage })
    │
    ▼
┌── _loop() ─────────────────────────────────────┐
│                                                 │
│   for (i = 0; i < maxIterations; i++) {        │
│       response = _callAPI()  // with retry     │
│       messages.push(assistant content)          │
│                                                 │
│       if stop_reason == "end_turn":            │
│           memory.maybeUpdate(text)              │
│           return text                          │
│                                                 │
│       if stop_reason == "tool_use":            │
│           results = _dispatchTools(content)    │
│           messages.push(tool_results)          │
│           continue                             │
│                                                 │
│       if stop_reason == "max_tokens":          │
│           if continuationPrompt:               │
│               continue (auto-recurse)          │
│   }                                            │
│                                                 │
│   if continuationPrompt && continuations < 10: │
│       auto-recurse with continuation prompt    │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Continuation & Iteration Limits

When `continuationPrompt` is set (applied through `Session`):

- **Iteration limit exceeded**: Agent auto-recurses with the continuation prompt
- **`max_tokens` stop reason**: Falls through to continuation logic (not silently truncated)
- **Hard cap**: `MAX_CONTINUATIONS` per model (Opus: 20, Sonnet: 10, Haiku: 5) prevents infinite loops regardless of mode

Without `continuationPrompt`, the loop simply returns after `maxIterations`.

## API Retry

`_callAPI()` implements exponential backoff for transient errors:

- **Retries**: Up to 3 attempts
- **Base delay**: 2s (2s → 4s → 8s)
- **Retryable errors**: 429 (rate limit), 529 (overloaded), 5xx (server error)
- **Network errors**: `ECONNRESET`, `ETIMEDOUT`, `fetch failed`
- **Non-retryable**: 400, 401, 403, 404, 422 -- thrown immediately
- **Retry progress**: Emitted as `error` stream events so CLI can display status

## Adaptive Thinking

By default, NODYN uses **adaptive thinking**:

```typescript
thinking: { type: 'adaptive' }
```

Claude decides the reasoning depth per request. This replaces static `budget_tokens` allocation and is the recommended mode.

Alternatively, explicit thinking can be configured:

```typescript
thinking: { type: 'enabled', budget_tokens: 10000 }
```

## Effort Levels

The `effort` parameter controls global reasoning depth:

| Level | Description |
|-------|-------------|
| `low` | Minimal reasoning |
| `medium` | Moderate depth |
| `high` | Thorough (default) |
| `max` | Maximum depth |

Set via `AgentConfig.effort` or `/thinking` command in the CLI.

## Stream Processing

`StreamProcessor` (`src/core/stream.ts`) is a pure stream transformer with no dependencies on other modules. It processes raw SDK events into `StreamEvent`s:

| SDK Event | Action |
|-----------|--------|
| `message_start` | Captures initial usage (includes cache fields) |
| `content_block_start` | Initializes new content block |
| `content_block_delta` | Appends text/thinking/JSON deltas, emits events |
| `content_block_stop` | Parses accumulated tool input JSON, emits `tool_call` |
| `message_delta` | Merges usage, emits `turn_end` |

### StreamEvent Types

```typescript
type StreamEvent =
  | { type: 'text';          text: string;            agent: string }
  | { type: 'thinking';      thinking: string;        agent: string }
  | { type: 'tool_call';     name: string; input: unknown; agent: string }
  | { type: 'tool_result';   name: string; result: string; agent: string }
  | { type: 'spawn';         agents: string[];        agent: string }
  | { type: 'turn_end';      stop_reason: string; usage: BetaUsage; agent: string }
  | { type: 'error';         message: string;         agent: string }
  | { type: 'trigger';       trigger: string;         agent: string }
  | { type: 'cost_warning';  snapshot: CostSnapshot;  agent: string }
  | { type: 'continuation';  iteration: number;       agent: string }

```

## Parallel Tool Dispatch

When the API returns `stop_reason: "tool_use"`, all tool calls in the response are dispatched in parallel using `Promise.allSettled`:

```typescript
const settled = await Promise.allSettled(
  toolCalls.map(tc => this._executeOne(tc)),
);
```

This means:
- Multiple tool calls execute concurrently
- A single failure doesn't block other tools
- Failed tools return `is_error: true` results to the model
- The model sees all results and can recover from individual failures

## Token Counting & Context Overflow

The Session accumulates token usage across turns:

```typescript
usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
```

The CLI footer shows a context usage bar (green < 50%, yellow < 80%, red >= 80%) based on `CONTEXT_WINDOW[modelId]` (Opus: 1M, Sonnet/Haiku: 200K).

### Context Window Management

Multi-layered guards prevent context overflow and token waste:

**Tool result truncation** — oversized tool results are truncated at execution time (`DEFAULT_MAX_TOOL_RESULT_CHARS = 80,000`, configurable via `max_tool_result_chars`). Publishes `contentTruncation` diagnostic event.

**Knowledge context budget** — `formatContext()` enforces `DEFAULT_MAX_KNOWLEDGE_CONTEXT_CHARS = 12,000`. When exceeded, drops lowest-scored memories (preserves semantic integrity of remaining entries).

**Briefing cap** — `MAX_BRIEFING_CHARS = 8,000`. Manifest diff trimmed first (lowest priority), run history preserved intact. Briefing is one-shot (cleared after turn 1).

**History truncation** — `_truncateHistory()` runs before every `_callAPI()` call:

- **Token estimate**: `JSON.stringify(messages).length / CHARS_PER_TOKEN` where `CHARS_PER_TOKEN = 3.5`
- **Threshold**: 85% of `CONTEXT_WINDOW[model]` (Opus: ~850K, Sonnet/Haiku: ~170K tokens)
- **Strategy**: Keep first message (original task) + last N messages (scaled by context window: Opus keeps up to 100, Sonnet/Haiku up to 20); replace the dropped range with a single placeholder message
- **Content truncation**: Second pass truncates oversized content blocks (Opus: 40K chars, Sonnet/Haiku: 8K chars per message)

**Context budget observability** — `context_budget` stream event emitted when usage exceeds 70%, with per-block breakdown (system/tool/message tokens).

## Prompt Caching

Prompt caching is GA (no beta header needed). NODYN uses three cache control blocks:

1. **System prompt** -- `cache_control: { type: 'ephemeral' }` on the static system prompt
2. **Knowledge context or memory fallback** -- `cache_control: { type: 'ephemeral' }`. Primary path: Knowledge Graph retrieval (HyDE + vector + entity graph expansion + MMR) produces a `<relevant_context>` block with scope-grouped memories and entity subgraph. Legacy fallback: SQLite cosine search when `knowledge_graph_enabled: false`. Cold start fallback: full `<memory>` dump. Empty string = intentionally no block.
3. **Briefing block** -- `cache_control: { type: 'ephemeral' }` on session briefing + advisor recommendations

**Opus requires 4,096+ tokens** for caching to activate. System prompt + tools combined must exceed this threshold.

Top-level `cache_control: { type: 'ephemeral' }` on the API call auto-marks the last cacheable block.

### Cache Field Flow

- `cache_creation_input_tokens` and `cache_read_input_tokens` arrive in `message_start`
- `message_delta` only carries `output_tokens`
- `StreamProcessor` merges delta into existing usage to preserve cache fields

## Proxy Compatibility

Thinking block signatures are invalidated when responses pass through API proxies. The agent strips all `type: 'thinking'` blocks from message history before the next API call:

```typescript
const contentForHistory = response.content.filter(
  (b) => b.type !== 'thinking',
);
this.messages.push({ role: 'assistant', content: contentForHistory });
```

## Memory Integration

After each completed turn (`stop_reason: "end_turn"`), the agent fires off memory extraction:

```typescript
if (this.memory) {
  void this.memory.maybeUpdate(text);  // fire-and-forget
}
```

This uses Claude Haiku to analyze the response and extract facts, skills, context, and error information. It never blocks the response -- failures are silently ignored.

## Cancellation

Each `send()` call creates a new `AbortController`. Calling `agent.abort()` triggers signal propagation to the streaming API call. On abort, the message history is rolled back to the pre-call snapshot.
