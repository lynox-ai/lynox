/**
 * Online reachability matrix: lazy tool-loading discovery regression test.
 *
 * `LAZY_DEFERRED_TOOLS` (src/core/agent.ts) removes ~17 heavy/long-tail tool
 * schemas from the cached prompt prefix and hands their discovery to
 * Anthropic's native tool-search (`tool_search_tool_regex_20251119`) instead —
 * the model searches for a tool by keyword when it suspects one exists, and
 * the API appends the real schema inline. Every deferred tool is SUPPOSED to
 * stay reachable; the risk this suite guards against is a SILENT regression
 * where the model never thinks to search for a given deferred tool (a stale/
 * un-keyword-rich description, a curation mistake, an eager cousin winning by
 * default) and the tool becomes invisible to the user with no error anywhere.
 *
 * For every tool in `LAZY_DEFERRED_TOOLS` this file drives a REAL Agent
 * (lazy_tools_enabled + provider:'anthropic', so the deferred/tool-search
 * machinery in agent.ts `_callAPI()` actually engages) with a realistic user
 * prompt that should make the model reach for that tool, and asserts the
 * REACHABILITY MECHANISM fired: a `server_tool_use` (tool_search_tool_regex)
 * block followed by a `tool_search_tool_result` block, and — after that — a
 * `tool_use` block for a plausibly-correct tool. Per the task brief, this
 * intentionally does NOT hard-assert the exact tool name every time (a small
 * few cases accept a closely-related sibling in the same tool family) — an
 * over-strict exact-match would flake on legitimate model variance and defeat
 * the point of testing the MECHANISM, not a single output token.
 *
 * Three of the deferred tools (`artifact_delete`, `artifact_history`,
 * `artifact_restore`) only make sense once an artifact already exists — per
 * the curation comment in agent.ts they are "in-context after artifact_save".
 * Two of the mail tools (`mail_read`, `mail_reply`) likewise need a message
 * UID a real user would only have after a search/triage. Those five cases are
 * two-turn conversations: turn 1 establishes realistic context with an EAGER
 * tool (artifact_save) or a DIFFERENT deferred tool (mail_search/mail_triage),
 * turn 2 is the one actually asserted. Every other case is a single, natural
 * user turn.
 *
 * Tool handlers here are STUBS that return realistic canned text — this suite
 * tests DISCOVERY (did the model find + call the tool), not the tool's real
 * side effects, and stubbing keeps it safe to run for real (no live IMAP/
 * Google calls, no shell exec, no ffmpeg, no actual outbound mail) even though
 * the tool DEFINITIONS (name/description/input_schema) are the real,
 * production ones imported straight from source — the tool-search matches
 * against the real description, so a stale copy here would defeat the test.
 *
 * Cost: real Anthropic spend when run with a key — 17 cases, 5 of them
 * two-turn (22 API calls total), Haiku, no thinking. Roughly the same order
 * of magnitude as the rest of tests/online/. NEVER run automatically; gated
 * on ANTHROPIC_API_KEY exactly like every other file in this directory.
 *
 * Run at the gate:
 *   ANTHROPIC_API_KEY=<your-key> npx vitest run tests/online/lazy-tool-reachability.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { Agent, LAZY_DEFERRED_TOOLS } from '../../src/core/agent.js';
import { createToolContext } from '../../src/core/tool-context.js';
import type { ToolEntry } from '../../src/types/index.js';
import { getApiKey, hasApiKey, HAIKU } from './setup.js';

// Real tool definitions — eager core (present so the fixture reflects real
// coexistence with tools that have historically won over a deferred cousin;
// see the "eager near-substitute" rule in agent.ts's LAZY_DEFERRED_TOOLS doc).
import { bashTool } from '../../src/tools/builtin/bash.js';
import { readFileTool, writeFileTool } from '../../src/tools/builtin/fs.js';
import { memoryRecallTool, memoryStoreTool } from '../../src/tools/builtin/memory.js';
import { taskCreateTool, taskListTool } from '../../src/tools/builtin/task.js';
import { dataStoreQueryTool } from '../../src/tools/builtin/data-store.js';
import { contactsSearchTool } from '../../src/tools/builtin/contacts.js';
import { runWorkflowTool } from '../../src/tools/builtin/pipeline.js';

// Real tool definitions — the deferred set (LAZY_DEFERRED_TOOLS), all 17.
import {
  artifactSaveTool, artifactListTool, artifactDeleteTool,
  artifactHistoryTool, artifactRestoreTool,
} from '../../src/tools/builtin/artifact.js';
import { apiSetupTool } from '../../src/tools/builtin/api-setup.js';
import { mediaProcessTool } from '../../src/tools/builtin/media-process.js';
import { subjectsMergeTool } from '../../src/tools/builtin/subjects-merge.js';
import { createMailConnectTool } from '../../src/integrations/mail/tools/mail-connect.js';
import { createMailReadTool } from '../../src/integrations/mail/tools/mail-read.js';
import { createMailReplyTool } from '../../src/integrations/mail/tools/mail-reply.js';
import { createMailSearchTool } from '../../src/integrations/mail/tools/mail-search.js';
import { createMailSendTool } from '../../src/integrations/mail/tools/mail-send.js';
import { createMailTriageTool } from '../../src/integrations/mail/tools/mail-triage.js';
import { InMemoryMailRegistry } from '../../src/integrations/mail/tools/registry.js';
import { createCalendarTool } from '../../src/integrations/google/google-calendar.js';
import { createDocsTool } from '../../src/integrations/google/google-docs.js';
import { createDriveTool } from '../../src/integrations/google/google-drive.js';
import { createSheetsTool } from '../../src/integrations/google/google-sheets.js';
import { GoogleAuth } from '../../src/integrations/google/google-auth.js';

/** Skip assertion if the API returned a transient server error (500/529). Matches agent.test.ts. */
function skipOnServerError(error: unknown): void {
  if (error instanceof APIError && (error.status === 500 || error.status === 529)) {
    // eslint-disable-next-line no-console
    console.warn(`Skipping: Anthropic returned ${error.status} (transient)`);
    return;
  }
  throw error;
}

const SKIP = !hasApiKey();

// === Fixture tool registry ==================================================

/**
 * Wrap a REAL tool entry in a side-effect-free stub handler. The `definition`
 * (name/description/input_schema — what the tool-search regex actually
 * matches against) is passed through byte-identical to production; only the
 * handler is replaced so this suite never shells out, hits IMAP/Google, or
 * sends real mail. `requiresConfirmation` and `destructive.mode` are carried
 * over for fidelity (the per-input `destructive.check` closure is dropped —
 * it's specific to the tool's real TInput and can't cross into a homogeneous
 * `ToolEntry[]` without an unsound cast; dropping it just makes the
 * permission guard slightly more conservative for that tool, never less).
 */
function stubbed<T>(entry: ToolEntry<T>, canned: string): ToolEntry {
  return {
    definition: entry.definition,
    handler: async () => canned,
    ...(entry.requiresConfirmation !== undefined ? { requiresConfirmation: entry.requiresConfirmation } : {}),
    ...(entry.destructive !== undefined ? { destructive: { mode: entry.destructive.mode } } : {}),
  };
}

const MAIL_TRIAGE_CANNED =
  'Inbox overview (3 unread):\n' +
  '- "Invoice #4521" — UID 4521, from billing@acme.com, 2026-07-08\n' +
  '- "Re: Q3 contract" — UID 4519, from sales@acme.com, 2026-07-07\n' +
  '- "Weekly Digest" — UID 4501, from news@example.com (likely noise)';

const MAIL_SEARCH_CANNED =
  'Found 1 message:\n' +
  '[UID 4521] "Invoice #4521" from billing@acme.com, 2026-07-08 — "Please find attached your invoice for July…"';

const ARTIFACT_SAVE_CANNED =
  'Saved artifact "Launch Checklist" (id: art_lc001, v1). File: /workspace/artifacts/art_lc001.md';

/** Fresh fixture tool array per test case — real definitions, stub handlers. */
function buildFixtureTools(): ToolEntry[] {
  const mailRegistry = new InMemoryMailRegistry();
  const googleAuth = new GoogleAuth({
    clientId: 'reachability-test-client-id',
    clientSecret: 'reachability-test-client-secret',
  });

  return [
    // -- Eager core --
    stubbed(bashTool, 'stub: command not actually executed in this reachability test'),
    stubbed(readFileTool, 'stub: file contents unavailable in this reachability test'),
    stubbed(writeFileTool, 'stub: file written (simulated)'),
    stubbed(memoryRecallTool, 'stub: no memories found'),
    stubbed(memoryStoreTool, 'stub: memory stored (simulated)'),
    stubbed(taskCreateTool, 'stub: task created (simulated)'),
    stubbed(taskListTool, 'stub: no open tasks'),
    stubbed(dataStoreQueryTool, 'stub: no rows'),
    stubbed(contactsSearchTool, 'stub: no matching contacts'),
    stubbed(runWorkflowTool, 'stub: workflow not actually run in this reachability test'),

    // -- Deferred set (LAZY_DEFERRED_TOOLS) --
    stubbed(apiSetupTool, 'stub: API profile configured (simulated)'),
    stubbed(mediaProcessTool, 'stub: media processed (simulated)'),
    stubbed(subjectsMergeTool, 'stub: subjects merged (simulated)'),
    stubbed(artifactSaveTool, ARTIFACT_SAVE_CANNED),
    stubbed(artifactListTool, 'stub: no artifacts saved yet'),
    stubbed(artifactDeleteTool, 'stub: artifact deleted (simulated)'),
    stubbed(artifactHistoryTool, 'stub: no earlier versions stored'),
    stubbed(artifactRestoreTool, 'stub: artifact restored (simulated)'),
    stubbed(createMailConnectTool(), 'stub: mailbox connected (simulated)'),
    stubbed(createMailReadTool(mailRegistry), 'stub: "Invoice #4521" — full body unavailable in this reachability test'),
    stubbed(createMailReplyTool(mailRegistry), 'stub: reply sent (simulated)'),
    stubbed(createMailSearchTool(mailRegistry), MAIL_SEARCH_CANNED),
    stubbed(createMailSendTool(mailRegistry), 'stub: email sent (simulated)'),
    stubbed(createMailTriageTool(mailRegistry), MAIL_TRIAGE_CANNED),
    stubbed(createCalendarTool(googleAuth), 'stub: calendar checked (simulated)'),
    stubbed(createDocsTool(googleAuth), 'stub: doc content unavailable in this reachability test'),
    stubbed(createDriveTool(googleAuth), 'stub: no matching files (simulated)'),
    stubbed(createSheetsTool(googleAuth), 'stub: sheet content unavailable in this reachability test'),
  ];
}

// === Reachability analysis helpers =========================================

type ContentBlockParam = Exclude<BetaMessageParam['content'], string>[number];

/** All content blocks of assistant messages at/after `fromIndex` in the agent's history. */
function collectAssistantBlocks(messages: BetaMessageParam[], fromIndex: number): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const msg of messages.slice(fromIndex)) {
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string') continue;
    blocks.push(...content);
  }
  return blocks;
}

interface ReachabilityResult {
  /** A tool-search actually fired: server_tool_use(tool_search_tool_regex) + an inline result. */
  searched: boolean;
  /** Names of every real (client) tool_use block emitted after the snapshot point. */
  invokedToolNames: string[];
}

function analyzeReachability(blocks: ContentBlockParam[]): ReachabilityResult {
  const searched =
    blocks.some(b => b.type === 'server_tool_use' && b.name === 'tool_search_tool_regex') &&
    blocks.some(b => b.type === 'tool_search_tool_result');
  const invokedToolNames = blocks
    .filter((b): b is Extract<ContentBlockParam, { type: 'tool_use' }> => b.type === 'tool_use')
    .map(b => b.name);
  return { searched, invokedToolNames };
}

// === The matrix ==============================================================

interface ReachabilityCase {
  /** The LAZY_DEFERRED_TOOLS member this case targets. */
  readonly tool: string;
  /**
   * Conversation turns, in order. Only the LAST turn is asserted (search +
   * invoke must happen in response to it); earlier turns exist purely to
   * establish realistic context a user would actually have (an artifact just
   * saved, a message UID from a prior search/triage).
   */
  readonly turns: readonly string[];
  /**
   * Tool names that count as a correct catch for this case. Usually just
   * `tool` itself; a couple of cases tolerate one closely-related sibling in
   * the same family so the assertion tests the MECHANISM (search → discover
   * → invoke a plausible tool) rather than flaking on legitimate model
   * variance in which exact family member it reaches for first.
   */
  readonly acceptableToolNames: readonly string[];
}

const CASES: readonly ReachabilityCase[] = [
  {
    tool: 'google_calendar',
    turns: ["What's on my calendar tomorrow?"],
    acceptableToolNames: ['google_calendar'],
  },
  {
    tool: 'google_docs',
    turns: ["Open my 'Q3 Planning' Google Doc and tell me what it says."],
    acceptableToolNames: ['google_docs'],
  },
  {
    tool: 'google_drive',
    turns: ["Search my Google Drive for a file called 'Contract Draft'."],
    acceptableToolNames: ['google_drive'],
  },
  {
    tool: 'google_sheets',
    turns: ["Read the data in my 'Budget 2026' Google Sheet."],
    acceptableToolNames: ['google_sheets'],
  },
  {
    tool: 'mail_connect',
    turns: ['Connect my Gmail account so you can read my inbox.'],
    acceptableToolNames: ['mail_connect'],
  },
  {
    tool: 'mail_read',
    // Turn 1 gives the model a real UID to act on (mail_triage), turn 2 needs
    // mail_read specifically — the two tools are distinct deferred members.
    turns: [
      "What's new in my inbox today?",
      'Open the Acme invoice email and show me the full text.',
    ],
    acceptableToolNames: ['mail_read'],
  },
  {
    tool: 'mail_reply',
    turns: [
      'Search my inbox for the message from Acme about the contract.',
      'Reply to that message and say we accept the terms.',
    ],
    acceptableToolNames: ['mail_reply'],
  },
  {
    tool: 'mail_search',
    turns: ['Search my inbox for the invoice from Acme.'],
    acceptableToolNames: ['mail_search'],
  },
  {
    tool: 'mail_send',
    turns: ['Send an email to sarah@example.com letting her know the report is ready.'],
    acceptableToolNames: ['mail_send'],
  },
  {
    tool: 'mail_triage',
    turns: ["What's new in my inbox today? Anything important?"],
    acceptableToolNames: ['mail_triage'],
  },
  {
    tool: 'api_setup',
    turns: ['Connect the Stripe API so you can use it going forward.'],
    acceptableToolNames: ['api_setup'],
  },
  {
    tool: 'media_process',
    turns: ["I have a video file called 'clip.mov' in my files — convert it to mp4 for me."],
    acceptableToolNames: ['media_process'],
  },
  {
    tool: 'subjects_merge',
    turns: ["'Ada' and 'Dr. Ada Lovelace' in my notes are the same person — merge them into one."],
    acceptableToolNames: ['subjects_merge'],
  },
  {
    tool: 'artifact_delete',
    turns: [
      "Save these launch notes as an artifact titled 'Launch Checklist': verify staging, confirm rollback plan, notify support.",
      'Delete the Launch Checklist artifact you just saved.',
    ],
    acceptableToolNames: ['artifact_delete'],
  },
  {
    tool: 'artifact_history',
    turns: [
      "Save these launch notes as an artifact titled 'Launch Checklist': verify staging, confirm rollback plan, notify support.",
      'Show me the version history of the Launch Checklist artifact.',
    ],
    acceptableToolNames: ['artifact_history'],
  },
  {
    tool: 'artifact_restore',
    turns: [
      "Save these launch notes as an artifact titled 'Launch Checklist': verify staging, confirm rollback plan, notify support.",
      'Actually, revert the Launch Checklist artifact to an earlier version.',
    ],
    acceptableToolNames: ['artifact_restore'],
  },
  {
    tool: 'artifact_list',
    turns: ["What documents or artifacts have I saved so far?"],
    acceptableToolNames: ['artifact_list'],
  },
];

// Keeps the matrix honest as LAZY_DEFERRED_TOOLS evolves — no hardcoded count.
// Runs unconditionally (no API key needed): a pure structural check.
describe('lazy-tool-reachability matrix coverage', () => {
  it('has exactly one case per member of LAZY_DEFERRED_TOOLS, no more, no less', () => {
    const covered = new Set(CASES.map(c => c.tool));
    expect(covered.size, 'duplicate tool entries in CASES').toBe(CASES.length);
    expect(covered).toEqual(LAZY_DEFERRED_TOOLS);
  });
});

describe.skipIf(SKIP)('Online: lazy tool-loading reachability matrix', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = getApiKey();
  });

  it.each(CASES)(
    'discovers + invokes the deferred tool "$tool"',
    async ({ tool, turns, acceptableToolNames }) => {
      const agent = new Agent({
        name: `reach-${tool}`,
        model: HAIKU,
        apiKey,
        provider: 'anthropic',
        maxIterations: 6,
        tools: buildFixtureTools(),
        toolContext: createToolContext({ lazy_tools_enabled: true }),
        // Confirmation-gated deferred tools (mail_send/reply, google writes,
        // subjects_merge) must not stall on an unanswered prompt.
        promptUser: async () => 'allow',
      });

      let preFinalTurnLen = 0;
      try {
        for (let i = 0; i < turns.length; i++) {
          if (i === turns.length - 1) preFinalTurnLen = agent.getMessages().length;
          await agent.send(turns[i]!);
        }
      } catch (err) {
        skipOnServerError(err);
        return;
      }

      const blocks = collectAssistantBlocks(agent.getMessages(), preFinalTurnLen);
      const { searched, invokedToolNames } = analyzeReachability(blocks);

      expect(
        searched,
        `expected a tool-search (server_tool_use "tool_search_tool_regex" + tool_search_tool_result) ` +
        `for "${tool}"; assistant blocks emitted: ${JSON.stringify(blocks.map(b => b.type))}`,
      ).toBe(true);
      expect(
        invokedToolNames.some(n => acceptableToolNames.includes(n)),
        `expected a tool_use for one of [${acceptableToolNames.join(', ')}] after the search for "${tool}"; ` +
        `tool_use blocks emitted: ${invokedToolNames.join(', ') || '(none)'}`,
      ).toBe(true);
    },
    60_000,
  );
});
