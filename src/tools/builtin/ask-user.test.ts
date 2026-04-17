import { describe, it, expect, vi } from 'vitest';
import { askUserTool } from './ask-user.js';
import type { IAgent } from '../../types/index.js';
import type { ToolContext } from '../../core/tool-context.js';

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
    activePlan: null,
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

describe('askUserTool', () => {
  it('calls promptUser with question and returns result', async () => {
    const promptUser = vi.fn().mockResolvedValue('user answer');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler({ question: 'What color?' }, agent);
    expect(result).toBe('user answer');
    expect(promptUser).toHaveBeenCalledWith('What color?', undefined);
  });

  it('passes string options to promptUser', async () => {
    const promptUser = vi.fn().mockResolvedValue('blue');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler(
      { question: 'Pick a color', options: ['red', 'blue', 'green'] },
      agent,
    );
    expect(result).toBe('blue');
    expect(promptUser).toHaveBeenCalledWith('Pick a color', ['red', 'blue', 'green', '\x00']);
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
    expect(promptUser).toHaveBeenCalledWith('Q1', undefined);
    expect(promptUser).toHaveBeenCalledWith('Q2', undefined);
  });

  // --- StepHint tests ---

  it('extracts labels from object options and passes to promptUser', async () => {
    const promptUser = vi.fn().mockResolvedValue('Deep analysis');
    const agent = makeAgent({ promptUser });

    const result = await askUserTool.handler({
      question: 'How to proceed?',
      options: [
        { label: 'Quick summary', hint: { model: 'haiku', effort: 'low' } },
        { label: 'Deep analysis', hint: { model: 'opus', effort: 'high' } },
      ],
    }, agent);

    expect(result).toBe('Deep analysis');
    expect(promptUser).toHaveBeenCalledWith(
      'How to proceed?',
      ['Quick summary', 'Deep analysis', '\x00'],
    );
  });

  it('stores pendingStepHint on toolContext when user selects option with hint', async () => {
    const promptUser = vi.fn().mockResolvedValue('Deep analysis');
    const toolContext = makeToolContext();
    const agent = makeAgent({ promptUser, toolContext });

    await askUserTool.handler({
      question: 'How to proceed?',
      options: [
        { label: 'Quick summary', hint: { model: 'haiku', effort: 'low' } },
        { label: 'Deep analysis', hint: { model: 'opus', thinking: 'enabled', effort: 'high' } },
      ],
    }, agent);

    expect(toolContext.pendingStepHint).toEqual({
      model: 'opus',
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
        { label: 'Analyze', hint: { model: 'opus' } },
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
        { label: 'No', hint: { model: 'haiku' } },
      ],
    }, agent);

    expect(result).toBe('Yes');
    expect(promptUser).toHaveBeenCalledWith('Proceed?', ['Yes', 'No', '\x00']);
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
      .mockResolvedValueOnce('Opus mode');
    const toolContext = makeToolContext();
    const agent = makeAgent({ promptUser, toolContext });

    await askUserTool.handler({
      question: 'Multi',
      questions: [
        { question: 'Q1' },
        { question: 'Q2', options: [{ label: 'Opus mode', hint: { model: 'opus' } }] },
      ],
    }, agent);

    expect(toolContext.pendingStepHint).toEqual({ model: 'opus' });
  });
});
