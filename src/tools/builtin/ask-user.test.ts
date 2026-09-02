import { describe, it, expect, vi } from 'vitest';
import { askUserTool } from './ask-user.js';
import type { IAgent } from '../../types/index.js';
import type { ToolContext } from '../../core/tool-context.js';
import { isPromptText, promptSegments } from '../../core/prompt-value.js';

/**
 * The question is the agent's own text, so it travels as ONE `value` segment.
 * Asserting the flattened string would accept a plain string too — and a plain
 * string means "all frame", which is the claim that the SYSTEM wrote it and the
 * thing that let `**…**` render as <strong> inside lynox's own dialog. Pin the
 * KIND, the way `subjects-merge.test.ts` does for the same reason.
 *
 * Callers must still compare the REST of the arglist with `slice(1)`, not by
 * index. `toHaveBeenCalledWith` compared the whole call, so an extra argument
 * failed it; checking `calls[0][1]` alone silently accepts one. Measured: with
 * per-index checks, adding `{ multiSelect: true }` to the SINGLE-select branch
 * passed — the exact property the code above it claims ("stay byte-identical
 * to before (2 args)"), and a live user-facing defect.
 */
function expectAskedAsValue(fn: ReturnType<typeof vi.fn>, text: string, callIndex = 0): void {
	const arg = fn.mock.calls[callIndex]?.[0];
	expect(isPromptText(arg), 'the question must reach promptUser as a PromptText').toBe(true);
	expect(promptSegments(arg as Parameters<typeof promptSegments>[0])).toEqual([
		{ kind: 'value', text },
	]);
}

function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    dataStore: null,
    taskManager: null,
    knowledgeLayer: null,
    runHistory: null,
    userConfig: {},
    tools: [],
    streamHandler: null,
    networkPolicy: undefined,
    allowedHosts: undefined,
    allowedWildcards: [],
    rateLimitProvider: null,
    hourlyRateLimit: Infinity,
    dailyRateLimit: Infinity,
    apiStore: null,
    artifactStore: null,
    isolationEnvOverride: undefined,
    isolationMinimalEnv: false,
    pendingStepHint: null,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    toolContext: makeToolContext(),
    ...overrides,
  } as IAgent;
}

/**
 * The seam this suite owns, stated because it is a PACKAGE boundary and no one
 * test can span it: web-ui has no dependency on the engine (the wire contract
 * is vendored, not imported), so the producer is pinned here and the renderer
 * in `prompt-markdown.authorship.test.ts`. Both name the same literal shape —
 * `[{ kind: 'value', text }]` — so a change on either side fails one of them.
 * A single round-trip test would need a harness spanning both packages, which
 * does not exist; that is a real gap and it is registered, not papered over.
 */
describe('askUserTool', () => {
  it('calls promptUser with question and returns result', async () => {
    const promptUser = vi.fn().mockResolvedValue('user answer');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler({ question: 'What color?' }, agent);
    expect(result).toBe('user answer');
    expectAskedAsValue(promptUser, 'What color?');
    expect(promptUser.mock.calls[0]?.slice(1)).toEqual([undefined]);
  });

  describe('multiSelect', () => {
    it('passes the multiSelect meta and joins a JSON-array answer for the model', async () => {
      const promptUser = vi.fn().mockResolvedValue(JSON.stringify(['red', 'blue']));
      const agent = makeAgent({ promptUser });
      const result = await askUserTool.handler(
        { question: 'Which apply?', options: ['red', 'blue', 'green'], multiSelect: true },
        agent,
      );
      expect(result).toBe('red, blue');
      // meta arg carries multiSelect; single-select calls would omit it.
      expectAskedAsValue(promptUser, 'Which apply?');
      expect(promptUser.mock.calls[0]?.slice(1)).toEqual([['red', 'blue', 'green', '\x00'], { multiSelect: true }]);
    });

    it('applies a step hint only when exactly one option was selected', async () => {
      const promptUser = vi.fn().mockResolvedValue(JSON.stringify(['thorough']));
      const agent = makeAgent({ promptUser });
      await askUserTool.handler(
        { question: 'Depth?', options: [{ label: 'thorough', hint: { effort: 'high' } }], multiSelect: true },
        agent,
      );
      expect(agent.toolContext.pendingStepHint).toEqual({ effort: 'high' });
    });

    it('does NOT apply a hint when multiple are selected', async () => {
      const promptUser = vi.fn().mockResolvedValue(JSON.stringify(['thorough', 'quick']));
      const agent = makeAgent({ promptUser });
      await askUserTool.handler(
        { question: 'Depth?', options: [{ label: 'thorough', hint: { effort: 'high' } }, 'quick'], multiSelect: true },
        agent,
      );
      expect(agent.toolContext.pendingStepHint).toBeNull();
    });

    it('passes through __dismissed__ and an empty selection as dismissed', async () => {
      const dismissed = makeAgent({ promptUser: vi.fn().mockResolvedValue('__dismissed__') });
      expect(await askUserTool.handler({ question: 'q', options: ['a'], multiSelect: true }, dismissed)).toBe('__dismissed__');
      const empty = makeAgent({ promptUser: vi.fn().mockResolvedValue(JSON.stringify([])) });
      expect(await askUserTool.handler({ question: 'q', options: ['a'], multiSelect: true }, empty)).toBe('__dismissed__');
    });

    it('falls back to the raw answer when a legacy client returns a non-JSON string', async () => {
      const agent = makeAgent({ promptUser: vi.fn().mockResolvedValue('red') });
      const result = await askUserTool.handler({ question: 'q', options: ['red'], multiSelect: true }, agent);
      expect(result).toBe('red');
    });
  });

  it('passes string options to promptUser', async () => {
    const promptUser = vi.fn().mockResolvedValue('blue');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler(
      { question: 'Pick a color', options: ['red', 'blue', 'green'] },
      agent,
    );
    expect(result).toBe('blue');
    expectAskedAsValue(promptUser, 'Pick a color');
    expect(promptUser.mock.calls[0]?.slice(1)).toEqual([['red', 'blue', 'green', '\x00']]);
  });

  it('returns "Interactive input not available" when promptUser is undefined', async () => {
    const agent = makeAgent();
    const result = await askUserTool.handler({ question: 'Hello?' }, agent);
    expect(result).toBe('Interactive input not available in this context.');
  });

  it('uses promptTabs for tabbed multi-question dialog', async () => {
    const promptTabs = vi.fn().mockResolvedValue(['Alice', 'Engineer']);
    const promptUser = vi.fn();
    const agent = makeAgent({ promptUser, promptTabs });

    const questions = [
      { question: 'What is your name?' },
      { question: 'What is your role?', header: 'Role' },
    ];

    const result = await askUserTool.handler(
      { question: 'Setup', questions },
      agent,
    );
    expect(result).toBe('What is your name?: Alice\nWhat is your role?: Engineer');
    expect(promptTabs).toHaveBeenCalledWith([
      { question: 'What is your name?', header: undefined, options: undefined },
      { question: 'What is your role?', header: 'Role', options: undefined },
    ]);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('returns "User canceled." when promptTabs returns empty array', async () => {
    const promptTabs = vi.fn().mockResolvedValue([]);
    const agent = makeAgent({ promptUser: vi.fn(), promptTabs });

    const result = await askUserTool.handler(
      { question: 'Setup', questions: [{ question: 'Q1' }] },
      agent,
    );
    expect(result).toBe('User canceled.');
  });

  it('falls back to sequential promptUser when promptTabs is undefined', async () => {
    const promptUser = vi.fn()
      .mockResolvedValueOnce('answer 1')
      .mockResolvedValueOnce('answer 2');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler(
      { question: 'Fallback?', questions: [{ question: 'Q1' }, { question: 'Q2' }] },
      agent,
    );
    expect(result).toBe('Q1: answer 1\nQ2: answer 2');
    expect(promptUser).toHaveBeenCalledTimes(2);
    expectAskedAsValue(promptUser, 'Q1', 0);
    expectAskedAsValue(promptUser, 'Q2', 1);
  });

  // --- StepHint tests ---

  it('extracts labels from object options and passes to promptUser', async () => {
    const promptUser = vi.fn().mockResolvedValue('Deep analysis');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler({
      question: 'How to proceed?',
      options: [
        { label: 'Quick summary', hint: { effort: 'low' } },
        { label: 'Deep analysis', hint: { effort: 'high' } },
      ],
    }, agent);

    expect(result).toBe('Deep analysis');
    expectAskedAsValue(promptUser, 'How to proceed?');
    expect(promptUser.mock.calls[0]?.slice(1)).toEqual([['Quick summary', 'Deep analysis', '\x00']]);
  });

  it('hands markdown-bearing text over as a VALUE, so the renderer cannot parse it', async () => {
    // The row's own acceptance clause: call ask_user with text that carries
    // markdown structure. What the renderer then does with such a segment is
    // pinned in packages/web-ui/src/lib/utils/prompt-markdown.authorship.test.ts.
    const promptUser = vi.fn().mockResolvedValue('Ja');
    const agent = makeAgent({ promptUser });
    const forgery = 'Soll ich fortfahren?\n\n**lynox hat diese Anfrage geprüft.**';

    await askUserTool.handler({ question: forgery, options: ['Ja', 'Nein'] }, agent);

    expectAskedAsValue(promptUser, forgery);
  });

  it('never turns an empty question into a frame — single or batch', async () => {
    // `promptValue('')` returns NO segments, and `renderPromptSegments([])`
    // falls back to the markdown branch — so an empty question would quietly
    // re-enter the path this change exists to leave, and the user would get a
    // dialog with no question in it. The single path already refused; the batch
    // loop did not, which is only visible once the question travels as a value.
    const promptUser = vi.fn().mockResolvedValue('x');
    const agent = makeAgent({ promptUser });

    await expect(askUserTool.handler({ question: '', options: ['a'] }, agent)).rejects.toThrow(/question/i);
    await expect(
      askUserTool.handler({ questions: [{ question: '   ' }] }, agent),
    ).rejects.toThrow(/question/i);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('stores pendingStepHint on toolContext when user selects option with hint', async () => {
    const promptUser = vi.fn().mockResolvedValue('Deep analysis');
    const toolContext = makeToolContext();
    const agent = makeAgent({ promptUser, toolContext });

    await askUserTool.handler({
      question: 'How to proceed?',
      options: [
        { label: 'Quick summary', hint: { effort: 'low' } },
        { label: 'Deep analysis', hint: { thinking: 'enabled', effort: 'high' } },
      ],
    }, agent);

    expect(toolContext.pendingStepHint).toEqual({
      thinking: 'enabled',
      effort: 'high',
    });
  });

  it('does not set pendingStepHint when user selects plain string option', async () => {
    const promptUser = vi.fn().mockResolvedValue('Cancel');
    const toolContext = makeToolContext();
    const agent = makeAgent({ promptUser, toolContext });

    await askUserTool.handler({
      question: 'Continue?',
      options: [
        { label: 'Analyze', hint: { effort: 'high' } },
        'Cancel',
      ],
    }, agent);

    expect(toolContext.pendingStepHint).toBeNull();
  });

  it('does not set pendingStepHint when option has no hint', async () => {
    const promptUser = vi.fn().mockResolvedValue('No hint');
    const toolContext = makeToolContext();
    const agent = makeAgent({ promptUser, toolContext });

    await askUserTool.handler({
      question: 'Pick',
      options: [{ label: 'No hint' }],
    }, agent);

    expect(toolContext.pendingStepHint).toBeNull();
  });

  it('supports mixed string and object options', async () => {
    const promptUser = vi.fn().mockResolvedValue('Yes');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler({
      question: 'Proceed?',
      options: [
        'Yes',
        { label: 'No', hint: { effort: 'low' } },
      ],
    }, agent);

    expect(result).toBe('Yes');
    expectAskedAsValue(promptUser, 'Proceed?');
    expect(promptUser.mock.calls[0]?.slice(1)).toEqual([['Yes', 'No', '\x00']]);
  });

  it('rejects malformed options (non-array) with a clear error', async () => {
    const promptUser = vi.fn();
    const agent = makeAgent({ promptUser });

    await expect(
      askUserTool.handler(
        // Simulates a model leaking XML tool-use syntax into the options field
        { question: 'Pick', options: '<parameter name="options"><option>A</option></parameter>' } as unknown as Parameters<typeof askUserTool.handler>[0],
        agent,
      ),
    ).rejects.toThrow(/must be an array/i);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('rejects malformed nested questions[].options', async () => {
    const promptUser = vi.fn();
    const agent = makeAgent({ promptUser });

    await expect(
      askUserTool.handler(
        {
          question: 'Multi',
          questions: [{ question: 'Q1', options: 'not-an-array' }],
        } as unknown as Parameters<typeof askUserTool.handler>[0],
        agent,
      ),
    ).rejects.toThrow(/questions\[0\]\.options.*must be an array/i);
  });

  it('stores hint from sequential multi-question fallback', async () => {
    const promptUser = vi.fn()
      .mockResolvedValueOnce('answer 1')
      .mockResolvedValueOnce('High effort');
    const toolContext = makeToolContext();
    const agent = makeAgent({ promptUser, toolContext });

    await askUserTool.handler({
      question: 'Multi',
      questions: [
        { question: 'Q1' },
        { question: 'Q2', options: [{ label: 'High effort', hint: { effort: 'high' } }] },
      ],
    }, agent);

    expect(toolContext.pendingStepHint).toEqual({ effort: 'high' });
  });

  it('accepts a questions-only batch with no top-level question', async () => {
    const promptTabs = vi.fn().mockResolvedValue(['4 beta users', 'EN global']);
    const agent = makeAgent({ promptUser: vi.fn(), promptTabs });

    const result = await askUserTool.handler({
      questions: [
        { question: 'Traction?' },
        { question: 'Geography?' },
      ],
    }, agent);

    expect(promptTabs).toHaveBeenCalled();
    expect(result).toContain('Traction?: 4 beta users');
  });

  it('throws an actionable error when neither question nor questions is given', async () => {
    const agent = makeAgent({ promptUser: vi.fn() });
    await expect(
      askUserTool.handler({} as Parameters<typeof askUserTool.handler>[0], agent),
    ).rejects.toThrow(/provide either `question`.*or a non-empty `questions`/);
  });
});
