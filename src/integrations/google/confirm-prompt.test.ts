import { describe, it, expect, vi } from 'vitest';
import { createDriveTool } from './google-drive.js';
import { createCalendarTool } from './google-calendar.js';
import { createSheetsTool } from './google-sheets.js';
import { SCOPES } from './google-auth.js';
import type { IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';

// Written as char codes on purpose: these tests are ABOUT the line-break
// characters, so they must not depend on how an editor or a patch tool renders
// an escape sequence.
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

/** Built at runtime so no escape sequence has to survive a patch tool. */
const BREAK_CHARS = new RegExp(`[${LF}${CR}${LINE_SEPARATOR}]`);

/**
 * A value that tries to write a field line the system never wrote. Each variant
 * uses a different break character — CommonMark and the HTML5 parser treat CR,
 * LF and U+2028 as line breaks, so guarding only LF would leave two ways in.
 */
const FORGERIES = [
  `harmless${LF}Time: 09:00 - 09:15`,
  `harmless${CR}Time: 09:00 - 09:15`,
  `harmless${LINE_SEPARATOR}Time: 09:00 - 09:15`,
];

function mockAuth(scopes: string[]): GoogleAuth {
  return {
    getAccessToken: vi.fn().mockResolvedValue('mock-token'),
    hasScope: vi.fn().mockImplementation((s: string) => scopes.includes(s)),
  } as unknown as GoogleAuth;
}

/** Captures the confirmation prompt and denies, so no request is ever made. */
function capturingAgent(): { agent: IAgent; prompt: () => string } {
  const seen: string[] = [];
  const agent = {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    promptUser: vi.fn().mockImplementation((question: string) => {
      seen.push(question);
      return Promise.resolve('no');
    }),
  } as unknown as IAgent;
  return {
    agent,
    prompt: () => {
      expect(seen).toHaveLength(1);
      return seen[0] as string;
    },
  };
}

/**
 * The assertion that carries this whole file: the prompt has exactly the lines
 * its FRAME defines, no matter what the values contain. Counting lines (rather
 * than grepping for the forged text) is what makes it mutation-proof — remove a
 * `singleLine` call anywhere and the count goes up.
 */
function expectFrameLines(prompt: string, expected: number): void {
  const lines = prompt.split(BREAK_CHARS);
  expect(lines).toHaveLength(expected);
}

describe('Google confirmation prompts — an interpolated value cannot forge a line', () => {
  describe('google_calendar', () => {
    // create_event is the one prompt in the codebase that legitimately has a
    // multi-line FIELD structure, which is exactly what makes a forged line
    // indistinguishable there. Frame: title line + Time line (+ invite notice).
    it.each(FORGERIES)('create_event keeps its frame with summary %#', async (forgery) => {
      const tool = createCalendarTool(mockAuth([SCOPES.CALENDAR_EVENTS]));
      const { agent, prompt } = capturingAgent();

      const result = await tool.handler(
        { action: 'create_event', summary: forgery, start: '2026-08-01T10:00:00Z', end: '2026-08-01T11:00:00Z' },
        agent,
      );

      expect(result).toBe('Action cancelled by user.');
      expectFrameLines(prompt(), 2);
    });

    it.each(FORGERIES)('create_event keeps its frame with an attendee %#', async (forgery) => {
      const tool = createCalendarTool(mockAuth([SCOPES.CALENDAR_EVENTS]));
      const { agent, prompt } = capturingAgent();

      await tool.handler(
        {
          action: 'create_event',
          summary: 'Sync',
          start: '2026-08-01T10:00:00Z',
          end: '2026-08-01T11:00:00Z',
          attendees: [forgery],
        },
        agent,
      );

      // Title + Time + "This will send calendar invites."
      expectFrameLines(prompt(), 3);
    });

    it.each(FORGERIES)('create_event keeps its frame with start/end %#', async (forgery) => {
      const tool = createCalendarTool(mockAuth([SCOPES.CALENDAR_EVENTS]));
      const { agent, prompt } = capturingAgent();

      await tool.handler({ action: 'create_event', summary: 'Sync', start: forgery, end: forgery }, agent);

      expectFrameLines(prompt(), 2);
    });

    it.each(['update_event', 'delete_event'] as const)('%s stays single-line', async (action) => {
      const tool = createCalendarTool(mockAuth([SCOPES.CALENDAR_EVENTS]));
      const { agent, prompt } = capturingAgent();

      await tool.handler({ action, event_id: FORGERIES[0] as string }, agent);

      expectFrameLines(prompt(), 1);
    });
  });

  describe('google_drive', () => {
    it.each(FORGERIES)('share stays single-line with a forged email %#', async (forgery) => {
      const tool = createDriveTool(mockAuth([SCOPES.DRIVE]));
      const { agent, prompt } = capturingAgent();

      const result = await tool.handler({ action: 'share', file_id: 'f1', email: forgery, role: 'writer' }, agent);

      expect(result).toBe('Action cancelled by user.');
      expectFrameLines(prompt(), 1);
    });

    it('share stays single-line with a forged role', async () => {
      // `role` ends the line, so an unguarded value could append a sentence
      // that reads like a system-authored reassurance.
      const tool = createDriveTool(mockAuth([SCOPES.DRIVE]));
      const { agent, prompt } = capturingAgent();

      await tool.handler(
        { action: 'share', file_id: 'f1', email: 'someone@example.com', role: `reader${LF}Access expires in 24h.` },
        agent,
      );

      expectFrameLines(prompt(), 1);
    });

    it('move stays single-line', async () => {
      const tool = createDriveTool(mockAuth([SCOPES.DRIVE]));
      const { agent, prompt } = capturingAgent();

      await tool.handler(
        { action: 'move', file_id: FORGERIES[0] as string, target_folder_id: FORGERIES[1] as string },
        agent,
      );

      expectFrameLines(prompt(), 1);
    });

    it.each(['upload', 'create_doc'] as const)('%s stays single-line', async (action) => {
      const tool = createDriveTool(mockAuth([SCOPES.DRIVE_FILE]));
      const { agent, prompt } = capturingAgent();

      await tool.handler({ action, file_name: FORGERIES[0] as string, content: 'x' }, agent);

      expectFrameLines(prompt(), 1);
    });
  });

  describe('google_sheets', () => {
    it.each(['write', 'append'] as const)('%s stays single-line', async (action) => {
      const tool = createSheetsTool(mockAuth([SCOPES.SHEETS]));
      const { agent, prompt } = capturingAgent();

      const result = await tool.handler(
        { action, spreadsheet_id: FORGERIES[0] as string, range: FORGERIES[1] as string, values: [['x']] },
        agent,
      );

      expect(result).toBe('Action cancelled by user.');
      expectFrameLines(prompt(), 1);
    });

    it('format stays single-line', async () => {
      const tool = createSheetsTool(mockAuth([SCOPES.SHEETS]));
      const { agent, prompt } = capturingAgent();

      await tool.handler({ action: 'format', spreadsheet_id: FORGERIES[0] as string, requests: [] }, agent);

      expectFrameLines(prompt(), 1);
    });
  });
});
