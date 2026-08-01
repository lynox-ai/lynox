import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * DK.1 F5 regression: the sticky conversation taint must SURVIVE a compaction.
 *
 * A conversation that ingests untrusted content (a fetched page, a mail body, an
 * http_request result) arms `conversationSawUntrusted`, and a durable `remember`
 * write derives `sourceUntrusted` from it. The latch is meant to be sticky for
 * the life of the conversation.
 *
 * Compaction broke it, silently. `Session.compact()` rewrites the context via
 * `Agent.reset()` — which is the FRESH-conversation path and clears the latch by
 * design — and then `loadMessages()`, which re-derives the latch from the new
 * context. The post-compaction seed is a summary: it carries no wrapped-untrusted
 * marker and no `tool_use` block naming an external-content tool, so the
 * re-derivation lands on FALSE. The durable-write gate then stood open on a
 * conversation that HAD ingested untrusted data.
 *
 * Auto-compaction fires on context pressure, so the threads this hit were exactly
 * the long research ones most likely to be tainted.
 *
 * This spec drives the REAL `Session.compact()` with the summarising LLM stubbed,
 * so it fails on the pre-fix wiring rather than on a hand-fed value.
 *
 * ⚠️ The stub seam is `StreamProcessor`, NOT `messages.create`. The agent
 * summarises through `client.beta.messages.stream(...)` handed to a
 * `StreamProcessor` (`agent.ts:1931`/`:1959`), so the old `messages.create` stub
 * matched nothing the code calls. It was not inert, though — and the difference
 * matters, because the obvious reading is wrong: the SDK mock defined no `beta`
 * at all, so `client.beta.messages` threw a TypeError, `compact()` caught it,
 * and every run landed on `if (!summary)` in ~650ms. No provider was ever
 * reached. The file therefore covered ONE exit while reading as though it drove
 * a summarised compaction.
 *
 * Stubbing the seam the code actually uses lets a summary come back, so the
 * SUCCESSFUL path — reset + seed + re-derivation — runs for the first time. The
 * early-return exit is kept covered by the third case below, which forces an
 * empty summary: reaching the success path must ADD an exit, not trade one.
 *
 * `compact()` has THREE `rearmTaint()` sites, and the two reachable ones are
 * both covered here. The third — after `reset()`, when `summary` has gone falsy
 * — cannot be reached: the `if (!summary)` guard above it already proved the
 * summary non-empty, and the only reassignment in between is
 * `SecretStore.maskSecrets`, whose replacements (`maskValue` → `***…`, or the
 * `[redacted]` fallback) are never empty. So a surviving mutation at that line
 * is dead defensive code, not a hole in this spec.
 *
 * ⚠️ This does NOT explain the intermittent 10s timeout this spec produces on
 * `main` (twice in the twelve main runs before 2026-08-01). That was initially
 * blamed on a live provider call, which the TypeError above rules out. Per-test
 * wall time is unchanged by this file's rewrite. The cause is still open — the
 * remaining suspect is `engine.init()`, which this spec runs and which can block
 * for minutes on a cold data dir.
 */

const mockProcess = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

/** A completed assistant turn carrying `text`. */
function endTurnResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

describe('a compaction keeps the durable-write gate armed', () => {
  let dataDir = '';
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    // Reaching the SUCCESSFUL compaction path means Session persists — a
    // compaction event, thread rows, the summary. On the developer's machine
    // that lands in the REAL `~/.lynox` (measured: +2 `compaction_events` rows
    // per run) purely because this spec now gets that far. Redirect the data
    // dir the way `untrusted-cause-log.test.ts` does.
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    dataDir = await mkdtemp(join(tmpdir(), 'lynox-taint-spec-'));
    process.env['LYNOX_DATA_DIR'] = dataDir;

    mockProcess.mockReset();
    // Whatever the summariser is asked, hand back a clean summary — i.e. one with
    // no untrusted marker in it. That is the realistic case and the dangerous one:
    // nothing in the seed lets `loadMessages` re-derive the latch.
    mockProcess.mockResolvedValue(
      endTurnResponse('Summary: the user asked about pricing and we compared two vendors.'),
    );
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('carries conversationSawUntrusted across compact()', async () => {
    const { Engine } = await import('./engine.js');
    const engine = new Engine({
      model: 'balanced',
      context: { id: 'taint-spec', name: 'taint-spec', source: 'cli', workspaceDir: '' },
    });
    await engine.init();
    const session = engine.createSession?.() ?? (engine as unknown as { session: unknown }).session;
    const s = session as {
      agent: { noteUntrustedData(): void; conversationSawUntrusted: boolean } | null;
      loadMessages(m: unknown[]): void;
      compact(focus?: string): Promise<{ success: boolean }>;
    };

    // Enough history that compaction has something to summarise.
    s.loadMessages([
      { role: 'user', content: 'Please read the vendor page and compare.' },
      { role: 'assistant', content: 'I read it; here is the comparison.' },
    ]);

    // The conversation ingests untrusted content.
    s.agent?.noteUntrustedData();
    expect(s.agent?.conversationSawUntrusted).toBe(true);

    const result = await s.compact();

    // Pin WHICH exit was taken, rather than asserting it in a comment. The
    // docstring's claim that this file now covers the successful path is only
    // true while this holds; if the seam ever stops feeding a summary, compact()
    // silently reverts to the `if (!summary)` early return and the taint
    // assertion below would still pass — covering half of what it says it does.
    expect(result.success).toBe(true);

    // THE ASSERTION. Pre-fix this is false: reset() cleared the latch and the
    // summary seed gave loadMessages nothing to re-derive it from.
    expect(s.agent?.conversationSawUntrusted).toBe(true);
  });

  it('does not invent a taint where there was none', async () => {
    // The carry is one-way. A clean conversation must stay clean, or the gate
    // becomes noise and every durable write gets flagged.
    const { Engine } = await import('./engine.js');
    const engine = new Engine({
      model: 'balanced',
      context: { id: 'taint-spec-2', name: 'taint-spec-2', source: 'cli', workspaceDir: '' },
    });
    await engine.init();
    const s = (engine.createSession?.() ?? (engine as unknown as { session: unknown }).session) as {
      agent: { conversationSawUntrusted: boolean } | null;
      loadMessages(m: unknown[]): void;
      compact(focus?: string): Promise<{ success: boolean }>;
    };

    s.loadMessages([
      { role: 'user', content: 'What is two plus two?' },
      { role: 'assistant', content: 'Four.' },
    ]);
    expect(s.agent?.conversationSawUntrusted).toBe(false);

    const result = await s.compact();

    // Same exit pin as above: without it this case would also pass on the
    // early-return path, where reset()/loadMessages never run and so cannot
    // invent anything — the property would hold for the wrong reason.
    expect(result.success).toBe(true);
    expect(s.agent?.conversationSawUntrusted).toBe(false);
  });

  it('re-arms on the FAILED-summary exit too (the path that leaves the thread intact)', async () => {
    // The second exit, and the one this file used to cover exclusively — by
    // accident, because the SDK mock made every summariser run throw. It is a
    // real path: a guard block or a provider failure lands here, and compaction
    // deliberately keeps the full history. The latch must survive that too,
    // because the summariser run has ALREADY cleared it by the time compact()
    // decides to bail (session.ts — the `rearmTaint()` inside `if (!summary)`).
    //
    // Without this case, reaching the success path above would TRADE coverage
    // rather than add it: deleting that early-return `rearmTaint()` leaves the
    // rest of this file green.
    mockProcess.mockResolvedValue(endTurnResponse(''));

    const { Engine } = await import('./engine.js');
    const engine = new Engine({
      model: 'balanced',
      context: { id: 'taint-spec-3', name: 'taint-spec-3', source: 'cli', workspaceDir: '' },
    });
    await engine.init();
    const s = (engine.createSession?.() ?? (engine as unknown as { session: unknown }).session) as {
      agent: { noteUntrustedData(): void; conversationSawUntrusted: boolean } | null;
      loadMessages(m: unknown[]): void;
      compact(focus?: string): Promise<{ success: boolean }>;
    };

    s.loadMessages([
      { role: 'user', content: 'Please read the vendor page and compare.' },
      { role: 'assistant', content: 'I read it; here is the comparison.' },
    ]);
    s.agent?.noteUntrustedData();

    const result = await s.compact();

    // The bail-out exit, pinned — otherwise a summary sneaking through would
    // silently move this case onto the path the two above already cover.
    expect(result.success).toBe(false);
    expect(s.agent?.conversationSawUntrusted).toBe(true);
  });
});
