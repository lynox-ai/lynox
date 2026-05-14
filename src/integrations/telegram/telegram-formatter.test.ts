import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  friendlyError,
  markdownToTelegramHtml,
  splitMessage,
  formatStatus,
  formatToolGroup,
  buildAnswerKeyboard,
  buildStopKeyboard,
  formatThinkingSummary,
  buildRichStatus,
  toolInputPreview,
  parseFollowUps,
  fallbackFollowUps,
  formatFollowUpKeyboard,
} from './telegram-formatter.js';
import { friendlyToolName } from './telegram-i18n.js';
import type { PendingTool } from './telegram-formatter.js';

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes <, >, &', () => {
    expect(escapeHtml('<b>test</b> & "quotes"')).toBe('&lt;b&gt;test&lt;/b&gt; &amp; "quotes"');
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('leaves safe text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// friendlyToolName
// ---------------------------------------------------------------------------

describe('friendlyToolName', () => {
  it('maps known tools to EN labels', () => {
    expect(friendlyToolName('bash', 'en')).toBe('Running command');
    expect(friendlyToolName('read_file', 'en')).toBe('Reading file');
    expect(friendlyToolName('spawn_agent', 'en')).toBe('Delegating');
    expect(friendlyToolName('memory_store', 'en')).toBe('Remembering');
  });

  it('maps known tools to DE labels', () => {
    expect(friendlyToolName('bash', 'de')).toBe('Befehl ausf\u00FChren');
    expect(friendlyToolName('read_file', 'de')).toBe('Datei lesen');
    expect(friendlyToolName('spawn_agent', 'de')).toBe('Delegieren');
    expect(friendlyToolName('memory_store', 'de')).toBe('Merken');
  });

  it('falls back to raw name for unknown tools', () => {
    expect(friendlyToolName('custom_plugin_tool', 'en')).toBe('custom_plugin_tool');
    expect(friendlyToolName('custom_plugin_tool', 'de')).toBe('custom_plugin_tool');
  });

  it('DE falls back to EN label when DE missing', () => {
    // Google tools are the same in both languages
    expect(friendlyToolName('google_gmail', 'de')).toBe('Gmail');
  });
});

// ---------------------------------------------------------------------------
// friendlyError
// ---------------------------------------------------------------------------

describe('friendlyError', () => {
  it('translates ENOENT to business language', () => {
    expect(friendlyError('ENOENT: no such file or directory, open \'/workspace/missing.txt\'')).toBe('File or folder not found.');
    expect(friendlyError('ENOENT: no such file', 'de')).toBe('Datei oder Ordner nicht gefunden.');
  });

  it('translates permission errors', () => {
    expect(friendlyError('EACCES: permission denied')).toBe('Permission denied \u2014 cannot access that resource.');
    expect(friendlyError('EPERM: operation not permitted', 'de')).toContain('Zugriff verweigert');
  });

  it('translates network errors', () => {
    expect(friendlyError('connect ETIMEDOUT 1.2.3.4:443')).toContain('timed out');
    expect(friendlyError('connect ECONNREFUSED 127.0.0.1:3000')).toContain('not responding');
    expect(friendlyError('read ECONNRESET')).toContain('interrupted');
  });

  it('translates HTTP status errors', () => {
    expect(friendlyError('401 Unauthorized')).toContain('Authentication failed');
    expect(friendlyError('403 Forbidden')).toContain('Access denied');
    expect(friendlyError('429 Too Many Requests')).toContain('Too many requests');
    expect(friendlyError('500 Internal Server Error')).toContain('server encountered an error');
    expect(friendlyError('502 Bad Gateway')).toContain('server encountered an error');
    expect(friendlyError('503 Service Unavailable')).toContain('server encountered an error');
  });

  it('returns original message for unknown errors', () => {
    const msg = 'Something completely unexpected happened';
    expect(friendlyError(msg)).toBe(msg);
  });

  it('returns German for known patterns with lang=de', () => {
    expect(friendlyError('401 Unauthorized', 'de')).toContain('Authentifizierung fehlgeschlagen');
    expect(friendlyError('429 Too Many Requests', 'de')).toContain('Zu viele Anfragen');
  });
});

// ---------------------------------------------------------------------------
// markdownToTelegramHtml
// ---------------------------------------------------------------------------

describe('markdownToTelegramHtml', () => {
  it('converts headers to bold uppercase', () => {
    expect(markdownToTelegramHtml('# Hello World')).toBe('<b>HELLO WORLD</b>');
    expect(markdownToTelegramHtml('## Sub Header')).toBe('<b>SUB HEADER</b>');
    expect(markdownToTelegramHtml('### Third')).toBe('<b>THIRD</b>');
  });

  it('converts bold text', () => {
    expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>');
    expect(markdownToTelegramHtml('__bold__')).toBe('<b>bold</b>');
  });

  it('converts italic text', () => {
    expect(markdownToTelegramHtml('*italic*')).toBe('<i>italic</i>');
    expect(markdownToTelegramHtml('_italic_')).toBe('<i>italic</i>');
  });

  it('converts inline code', () => {
    expect(markdownToTelegramHtml('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('converts code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it('converts code blocks without language', () => {
    const input = '```\nplain code\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>plain code</pre>');
  });

  it('converts links', () => {
    expect(markdownToTelegramHtml('[Google](https://google.com)')).toBe('<a href="https://google.com">Google</a>');
  });

  it('converts blockquotes', () => {
    expect(markdownToTelegramHtml('> quoted text')).toBe('<blockquote>quoted text</blockquote>');
  });

  it('escapes HTML in user text', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('handles empty string', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('handles plain text', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world');
  });

  it('converts tables to pre-formatted ASCII', () => {
    const input = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('<pre>');
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('</pre>');
  });

  it('escapes HTML inside code blocks', () => {
    const input = '```\n<div>test</div>\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre>&lt;div&gt;test&lt;/div&gt;</pre>');
  });

  it('converts strikethrough', () => {
    expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>');
  });
});

// ---------------------------------------------------------------------------
// splitMessage
// ---------------------------------------------------------------------------

describe('splitMessage', () => {
  it('returns single message if under limit', () => {
    const result = splitMessage('short message');
    expect(result).toEqual(['short message']);
  });

  it('returns empty array for empty string', () => {
    const result = splitMessage('');
    expect(result).toEqual(['']);
  });

  it('splits at paragraph boundary', () => {
    const p1 = 'a'.repeat(30);
    const p2 = 'b'.repeat(30);
    const text = `${p1}\n\n${p2}`;
    const result = splitMessage(text, 50);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(p1);
    expect(result[1]).toBe(p2);
  });

  it('splits at line boundary when no paragraph break', () => {
    const l1 = 'a'.repeat(30);
    const l2 = 'b'.repeat(30);
    const text = `${l1}\n${l2}`;
    const result = splitMessage(text, 50);
    expect(result.length).toBe(2);
  });

  it('handles pre tag closure on split', () => {
    const text = '<pre>' + 'x'.repeat(100) + '</pre>';
    const result = splitMessage(text, 50);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toContain('</pre>');
    expect(result[1]).toContain('<pre>');
  });
});

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

describe('formatStatus', () => {
  it('formats thinking status', () => {
    const result = formatStatus('thinking');
    expect(result).toContain('<b>');
    expect(result).toContain('Thinking');
  });

  it('formats done with elapsed and tools', () => {
    const result = formatStatus('done', 5000, 3);
    expect(result).toContain('Done');
    expect(result).toContain('5.0s');
    expect(result).toContain('3 tools');
  });

  it('formats error status', () => {
    const result = formatStatus('error');
    expect(result).toContain('Error');
  });

  it('formats stopped status', () => {
    const result = formatStatus('stopped');
    expect(result).toContain('Stopped');
  });

  it('handles singular tool count', () => {
    const result = formatStatus('working', 1000, 1);
    expect(result).toContain('1 tool');
    expect(result).not.toContain('tools');
  });
});

// ---------------------------------------------------------------------------
// formatToolGroup
// ---------------------------------------------------------------------------

describe('formatToolGroup', () => {
  it('returns empty for no tools', () => {
    expect(formatToolGroup([])).toBe('');
  });

  it('formats single tool', () => {
    const result = formatToolGroup([{ name: 'bash' }]);
    expect(result).toContain('bash');
  });

  it('groups duplicate tools with count', () => {
    const result = formatToolGroup([
      { name: 'bash' },
      { name: 'bash' },
      { name: 'read_file' },
    ]);
    expect(result).toContain('bash');
    expect(result).toContain('\u00D72');
    expect(result).toContain('read_file');
  });

  it('escapes HTML in tool names', () => {
    const result = formatToolGroup([{ name: '<script>' }]);
    expect(result).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// buildAnswerKeyboard
// ---------------------------------------------------------------------------

describe('buildAnswerKeyboard', () => {
  it('creates buttons for each option plus stop', () => {
    const kb = buildAnswerKeyboard(['Allow', 'Deny']);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.length).toBe(3); // Allow, Deny, Stop
    expect(allButtons[0]!.text).toBe('Allow');
    expect(allButtons[1]!.text).toBe('Deny');
    expect(allButtons[2]!.text).toContain('Stop');
  });

  it('encodes the option index (not the full string) into callback_data', () => {
    const kb = buildAnswerKeyboard(['Yes']);
    const button = kb.inline_keyboard[0]![0]!;
    const parsed = JSON.parse(button.callback_data);
    expect(parsed.t).toBe('a');
    expect(parsed.i).toBe(0);
    // No `v` — the runner resolves the index against run.pendingInput.options.
    expect(parsed.v).toBeUndefined();
  });

  it('keeps callback_data under Telegram\'s 64-byte limit for long options (audit K-LE-06)', () => {
    const longOption = 'A very long answer that previously blew past Telegram\'s 64-byte callback_data hard limit';
    const kb = buildAnswerKeyboard([longOption]);
    const button = kb.inline_keyboard[0]![0]!;
    expect(button.text).toBe(longOption);
    // Encoded payload should be tiny — `{"t":"a","i":0}` is 15 bytes.
    expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('arranges buttons in rows', () => {
    const kb = buildAnswerKeyboard(['A', 'B', 'C']);
    // 4 buttons total (3 + stop), max 2 per row = 2 rows
    expect(kb.inline_keyboard.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildStopKeyboard
// ---------------------------------------------------------------------------

describe('buildStopKeyboard', () => {
  it('creates single stop button', () => {
    const kb = buildStopKeyboard();
    expect(kb.inline_keyboard.length).toBe(1);
    expect(kb.inline_keyboard[0]!.length).toBe(1);
    const parsed = JSON.parse(kb.inline_keyboard[0]![0]!.callback_data);
    expect(parsed.t).toBe('s');
  });
});

// ---------------------------------------------------------------------------
// formatThinkingSummary
// ---------------------------------------------------------------------------

describe('formatThinkingSummary', () => {
  it('wraps text in italic with emoji', () => {
    const result = formatThinkingSummary('Analyzing the code');
    expect(result).toBe('💭 <i>Analyzing the code</i>');
  });

  it('truncates long summaries at 200 chars', () => {
    const long = 'x'.repeat(250);
    const result = formatThinkingSummary(long);
    expect(result).toContain('…');
    expect(result.length).toBeLessThan(250);
  });

  it('escapes HTML in summary', () => {
    const result = formatThinkingSummary('check <div> tag');
    expect(result).toContain('&lt;div&gt;');
  });
});

// ---------------------------------------------------------------------------
// buildRichStatus
// ---------------------------------------------------------------------------

describe('buildRichStatus', () => {
  it('shows thinking status with summary when no tools', () => {
    const result = buildRichStatus(undefined, 'thinking', 2000, 0, 'analyzing code', []);
    expect(result).toContain('Thinking');
    expect(result).toContain('💭');
    expect(result).toContain('analyzing code');
  });

  it('hides thinking summary once tools are tracked', () => {
    const tools: PendingTool[] = [
      { name: 'bash', inputPreview: 'npm test' },
    ];
    const result = buildRichStatus(undefined, 'working', 3000, 1, 'analyzing code', tools);
    expect(result).not.toContain('💭');
    expect(result).toContain('Running command');
    expect(result).toContain('npm test');
  });

  it('shows tool list with status icons and friendly names', () => {
    const tools: PendingTool[] = [
      { name: 'bash', inputPreview: 'npm test', success: true },
      { name: 'read_file', inputPreview: 'src/index.ts', success: false },
      { name: 'write_file', inputPreview: 'out.txt' },
    ];
    const result = buildRichStatus(undefined, 'working', 5000, 3, '', tools);
    expect(result).toContain('✅');
    expect(result).toContain('❌');
    expect(result).toContain('⏳');
    expect(result).toContain('Running command');
    expect(result).toContain('Reading file');
    expect(result).toContain('Writing file');
  });

  it('caps visible tools at 6 and shows hidden count', () => {
    const tools: PendingTool[] = Array.from({ length: 8 }, (_, i) => ({
      name: `tool_${i}`,
      inputPreview: `preview ${i}`,
      success: true,
    }));
    const result = buildRichStatus(undefined, 'working', 10000, 8, '', tools);
    expect(result).toContain('2 earlier tools');
    // Should show last 6 tools
    expect(result).toContain('tool_2');
    expect(result).toContain('tool_7');
    // First 2 should be hidden
    expect(result).not.toContain('tool_0');
    expect(result).not.toContain('tool_1');
  });

  it('uses header override when provided', () => {
    const result = buildRichStatus('🔄 <b>Iteration 2/50</b>', 'working', 5000, 3, '', []);
    expect(result).toContain('Iteration 2/50');
    expect(result).not.toContain('Working');
  });

  it('shows done status with friendly tool names', () => {
    const tools: PendingTool[] = [
      { name: 'bash', inputPreview: 'npm test', success: true },
      { name: 'read_file', inputPreview: 'src/index.ts', success: true },
    ];
    const result = buildRichStatus(undefined, 'done', 5000, 2, '', tools);
    expect(result).toContain('Done');
    expect(result).toContain('✅');
    expect(result).toContain('Running command');
    expect(result).toContain('Reading file');
  });

  it('escapes HTML in tool names and previews', () => {
    const tools: PendingTool[] = [
      { name: '<script>', inputPreview: '<b>bad</b>', success: true },
    ];
    const result = buildRichStatus(undefined, 'working', 1000, 1, '', tools);
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&lt;b&gt;bad&lt;/b&gt;');
  });
});

// ---------------------------------------------------------------------------
// toolInputPreview
// ---------------------------------------------------------------------------

describe('toolInputPreview', () => {
  it('extracts command from bash tool', () => {
    expect(toolInputPreview('bash', { command: 'npm test' })).toBe('npm test');
  });

  it('skips comment lines in bash', () => {
    expect(toolInputPreview('bash', { command: '# comment\nnpm test' })).toBe('npm test');
  });

  it('extracts path from read_file', () => {
    expect(toolInputPreview('read_file', { path: 'src/index.ts' })).toBe('src/index.ts');
  });

  it('extracts path from write_file', () => {
    expect(toolInputPreview('write_file', { path: 'out.txt' })).toBe('out.txt');
  });

  it('extracts method + url from http_request', () => {
    expect(toolInputPreview('http_request', { method: 'POST', url: 'https://api.example.com' }))
      .toBe('POST https://api.example.com');
  });

  it('extracts question from ask_user', () => {
    expect(toolInputPreview('ask_user', { question: 'Do you approve?' })).toBe('Do you approve?');
  });

  it('handles spawn_agent with agents array', () => {
    const result = toolInputPreview('spawn_agent', {
      agents: [{ name: 'researcher' }, { name: 'writer' }],
    });
    expect(result).toContain('2 roles');
    expect(result).toContain('researcher');
    expect(result).toContain('writer');
  });

  it('falls back to first string value for unknown tools', () => {
    expect(toolInputPreview('custom_tool', { foo: 42, bar: 'hello' })).toBe('hello');
  });

  it('handles non-object input', () => {
    expect(toolInputPreview('bash', null)).toBe('');
    expect(toolInputPreview('bash', 'raw')).toBe('raw');
  });
});

// ---------------------------------------------------------------------------
// parseFollowUps
// ---------------------------------------------------------------------------

describe('parseFollowUps', () => {
  it('extracts valid follow-ups from response', () => {
    const response = 'Here is the result.\n\n<follow_ups>[{"label":"Run tests","task":"Run the test suite"}]</follow_ups>';
    const { suggestions, cleanText } = parseFollowUps(response);
    expect(suggestions).toEqual([{ label: 'Run tests', task: 'Run the test suite' }]);
    expect(cleanText).toBe('Here is the result.');
  });

  it('returns empty suggestions when no block present', () => {
    const { suggestions, cleanText } = parseFollowUps('Just a normal response.');
    expect(suggestions).toEqual([]);
    expect(cleanText).toBe('Just a normal response.');
  });

  it('handles multiple suggestions', () => {
    const response = 'Done.\n<follow_ups>[{"label":"Commit","task":"Commit changes"},{"label":"Push","task":"Push to remote"}]</follow_ups>';
    const { suggestions } = parseFollowUps(response);
    expect(suggestions.length).toBe(2);
    expect(suggestions[0]!.label).toBe('Commit');
    expect(suggestions[1]!.label).toBe('Push');
  });

  it('caps at 4 suggestions', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ label: `Action ${i}`, task: `Do ${i}` }));
    const response = `Result\n<follow_ups>${JSON.stringify(items)}</follow_ups>`;
    const { suggestions } = parseFollowUps(response);
    expect(suggestions.length).toBe(4);
  });

  it('truncates long labels at 24 chars', () => {
    const response = `Ok\n<follow_ups>[{"label":"This is a very long label that exceeds","task":"do something"}]</follow_ups>`;
    const { suggestions } = parseFollowUps(response);
    expect(suggestions[0]!.label.length).toBeLessThanOrEqual(24);
  });

  it('returns empty on malformed JSON', () => {
    const response = 'Result\n<follow_ups>not valid json</follow_ups>';
    const { suggestions, cleanText } = parseFollowUps(response);
    expect(suggestions).toEqual([]);
    expect(cleanText).toBe('Result');
  });

  it('skips items with missing label or task', () => {
    const response = 'Ok\n<follow_ups>[{"label":"Good","task":"do it"},{"label":"","task":"empty label"},{"task":"no label"}]</follow_ups>';
    const { suggestions } = parseFollowUps(response);
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]!.label).toBe('Good');
  });

  it('deduplicates by label', () => {
    const response = 'Ok\n<follow_ups>[{"label":"Run","task":"run a"},{"label":"Run","task":"run b"}]</follow_ups>';
    const { suggestions } = parseFollowUps(response);
    expect(suggestions.length).toBe(1);
  });

  it('handles non-array JSON', () => {
    const response = 'Ok\n<follow_ups>{"label":"Not array","task":"oops"}</follow_ups>';
    const { suggestions, cleanText } = parseFollowUps(response);
    expect(suggestions).toEqual([]);
    expect(cleanText).toBe('Ok');
  });

  it('strips whitespace around the block', () => {
    const response = 'Result text\n\n  <follow_ups>  [{"label":"Next","task":"do next"}]  </follow_ups>  ';
    const { suggestions, cleanText } = parseFollowUps(response);
    expect(suggestions.length).toBe(1);
    expect(cleanText).toBe('Result text');
  });
});

// ---------------------------------------------------------------------------
// fallbackFollowUps
// ---------------------------------------------------------------------------

describe('fallbackFollowUps', () => {
  it('returns retry for abort', () => {
    const result = fallbackFollowUps('do something');
    expect(result.length).toBe(1);
    expect(result[0]!.label).toBe('Retry');
    expect(result[0]!.task).toBe('do something');
  });

  it('returns retry + explain for error', () => {
    const result = fallbackFollowUps('do something', 'en', 'Network timeout');
    expect(result.length).toBe(2);
    expect(result[0]!.label).toBe('Retry');
    expect(result[1]!.label).toBe('Explain');
    expect(result[1]!.task).toContain('Network timeout');
  });

  it('uses German labels when lang=de', () => {
    const result = fallbackFollowUps('mach was', 'de', 'Fehler');
    expect(result[0]!.label).toBe('Nochmal');
    expect(result[1]!.label).toBe('Erklären');
  });
});

// ---------------------------------------------------------------------------
// formatFollowUpKeyboard
// ---------------------------------------------------------------------------

describe('formatFollowUpKeyboard', () => {
  it('creates buttons with index-based callback data', () => {
    const kb = formatFollowUpKeyboard([
      { label: 'Run tests', task: 'run tests' },
      { label: 'Show diff', task: 'show diff' },
    ]);
    expect(kb.inline_keyboard.length).toBe(1); // 2 buttons in 1 row
    const btn0 = kb.inline_keyboard[0]![0]!;
    const btn1 = kb.inline_keyboard[0]![1]!;
    expect(btn0.text).toBe('Run tests');
    expect(JSON.parse(btn0.callback_data)).toEqual({ t: 'f', i: 0 });
    expect(btn1.text).toBe('Show diff');
    expect(JSON.parse(btn1.callback_data)).toEqual({ t: 'f', i: 1 });
  });

  it('arranges in rows of 2', () => {
    const kb = formatFollowUpKeyboard([
      { label: 'A', task: 'a' },
      { label: 'B', task: 'b' },
      { label: 'C', task: 'c' },
    ]);
    expect(kb.inline_keyboard.length).toBe(2); // row1: [A,B], row2: [C]
    expect(kb.inline_keyboard[0]!.length).toBe(2);
    expect(kb.inline_keyboard[1]!.length).toBe(1);
  });

  it('handles empty suggestions', () => {
    const kb = formatFollowUpKeyboard([]);
    expect(kb.inline_keyboard.length).toBe(0);
  });
});
