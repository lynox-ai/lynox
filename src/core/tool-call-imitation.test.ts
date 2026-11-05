import { describe, it, expect } from 'vitest';
import {
  MAX_UNIT_CHARS,
  TOOL_CALL_IMITATION_REPEATS,
  ToolCallImitationDetector,
  imitationToolsFrom,
  type ImitationHit,
} from './tool-call-imitation.js';

const TOOLS = imitationToolsFrom([
  { name: 'http_request', input_schema: { type: 'object', properties: { url: {}, method: {}, body: {}, headers: {} } } },
  { name: 'read_file', input_schema: { type: 'object', properties: { path: {}, offset: {}, limit: {} } } },
  { name: 'web_search', type: 'web_search_20250305' },
]);

/** Feeds `text` in pieces of `step` characters; returns the first hit and the delta index it came on. */
function feed(text: string, step = 7, detector = new ToolCallImitationDetector(TOOLS)): { hit: ImitationHit | null; at: number } {
  let i = 0;
  for (let o = 0; o < text.length; o += step, i++) {
    const hit = detector.push(text.slice(o, o + step));
    if (hit !== null) return { hit, at: o + step };
  }
  return { hit: null, at: -1 };
}

const times = (n: number, unit: (i: number) => string, sep = '\n'): string =>
  Array.from({ length: n }, (_, i) => unit(i)).join(sep) + sep;

const JSON_CALL = '{"url": "https://api.example.com/orders", "method": "POST", "body": "{\\"id\\": 7}"}';

const FORMS: Array<[string, string]> = [
  ['tool_call markup', '<tool_call>\n{"name": "http_request", "arguments": {"url": "https://x.test"}}\n</tool_call>'],
  ['begin/end token markup', '<|tool_call_begin|>functions.http_request:0<|tool_call_argument_begin|>{"url":"https://x.test"}<|tool_call_end|>'],
  ['function= markup', '<function=http_request>\n<parameter=url>https://x.test</parameter>\n</function>'],
  ['invoke markup', '<invoke name="http_request">\n<parameter name="url">https://x.test</parameter>\n</invoke>'],
  ['[TOOL_CALLS] markup', '[TOOL_CALLS][{"name": "read_file", "arguments": {"path": "a.txt"}}]'],
  ['python_tag markup', '<|python_tag|>http.call(url="https://x.test")'],
  ['tool name with parentheses', 'http_request(url="https://x.test", method="GET")'],
  ['tool name with a brace', 'read_file {"path": "notes.md", "limit": 20}'],
  ['JSON with a tool\'s input keys', JSON_CALL],
];

describe('ToolCallImitationDetector', () => {
  it('stops after the configured number of copies, which is three', () => {
    expect(TOOL_CALL_IMITATION_REPEATS).toBe(3);
  });

  describe.each(FORMS)('%s', (_label, unit) => {
    it('trips on the third identical copy', () => {
      const d = new ToolCallImitationDetector(TOOLS);
      const prose = (i: number): string => `Step ${String(i)}: sending the call now.\n`;
      expect(d.push(prose(1) + unit + '\n')).toBeNull();
      expect(d.push(prose(2) + unit + '\n')).toBeNull();
      const hit = d.push(prose(3) + unit + '\n');
      expect(hit).not.toBeNull();
      expect(hit!.count).toBe(3);
    });

    it('leaves a reply that shows the call twice alone', () => {
      expect(feed(times(2, () => unit)).hit).toBeNull();
    });

    it('trips when the copies arrive one character at a time', () => {
      const text = times(3, () => unit);
      const { hit, at } = feed(text, 1);
      expect(hit).not.toBeNull();
      // On the third copy, not later: the stop comes while that copy is being written.
      expect(at).toBeGreaterThan(text.length - unit.length - 2);
    });
  });

  it('names the tool whose input the JSON carries', () => {
    expect(feed(times(3, () => JSON_CALL)).hit?.toolName).toBe('http_request');
  });

  it('names the tool a markup unit calls', () => {
    expect(feed(times(3, () => '<function=read_file>{"path":"a"}</function>')).hit?.toolName).toBe('read_file');
  });

  it('treats copies that differ only in whitespace as the same unit', () => {
    const a = '{"url": "https://x.test",  "method": "GET"}';
    const b = '{"url":\n  "https://x.test",\n  "method": "GET"}';
    const c = '{ "url": "https://x.test", "method": "GET" }';
    // a and c differ in where the spaces are, not only how many: collapsing is not deleting.
    const d = new ToolCallImitationDetector(TOOLS);
    expect(d.push(`${a}\n${b}\n`)).toBeNull();
    expect(d.push(`${a}\n`)).not.toBeNull();
    expect(feed(`${a}\n${b}\n${c}\n`).hit).toBeNull();
  });

  it('does not stop a list of different requests the user asked for', () => {
    // Same tool, same keys, a different value each time: an answer, not a loop.
    const text = times(6, (i) => `Example ${String(i + 1)}:\n{"url": "https://api.example.com/items/${String(i)}", "method": "GET"}`);
    expect(feed(text).hit).toBeNull();
    expect(feed(text, 1).hit).toBeNull();
  });

  it('does not stop on repeated JSON whose keys belong to no sent tool', () => {
    const unit = '{"name": "Anna", "city": "Bern", "url_slug": "anna"}';
    expect(feed(times(5, () => unit)).hit).toBeNull();
  });

  it('does not stop repeated data that shares a single field name with a tool', () => {
    const unit = '{"url": "https://x.test", "title": "Home"}';
    expect(feed(times(5, () => unit)).hit).toBeNull();
    // Positive control on the same machinery: a second key of the tool makes it a unit.
    expect(feed(times(3, () => '{"url": "https://x.test", "method": "GET"}')).hit).not.toBeNull();
  });

  it('does not stop a reply that has already started a real tool call', () => {
    const d = new ToolCallImitationDetector(TOOLS);
    d.noteToolUse();
    expect(feed(times(5, () => JSON_CALL), 7, d).hit).toBeNull();
  });

  it('does not stop prose that mentions a tool as name()', () => {
    expect(feed(times(5, () => 'Use http_request() for this.')).hit).toBeNull();
  });

  it('does not take a longer identifier ending in a tool name for the tool', () => {
    expect(feed(times(5, () => 'my_http_request(url="https://x.test")')).hit).toBeNull();
  });

  it('reads very long data objects without stopping the reply', () => {
    const big = `{"url": "https://x.test", "method": "POST", "body": "${'x'.repeat(MAX_UNIT_CHARS)}"}`;
    expect(feed(times(4, () => big), 97).hit).toBeNull();
  });

  it('still finds copies after an unclosed brace earlier in the reply', () => {
    const text = `Here is a fragment { that never closes. ${'Filler text. '.repeat(200)}\n${times(3, () => JSON_CALL)}`;
    expect(feed(text, 5).hit).not.toBeNull();
  });

  it('a long ordinary answer does not trip and is read in linear time', () => {
    const para = 'The quarterly report shows revenue of 1.2M, up 4% on the year (see table 3). '
      + 'Costs {fixed and variable} were flat; the http_request budget line is unchanged. '
      + 'Example config: {"region": "eu", "tier": "pro"}. Next steps follow below.\n';
    const code = 'function f(a) { if (a) { return { x: a, y: [1, 2, 3] }; } return null; }\n';
    let text = '';
    while (text.length < 200_000) text += para + code;
    const started = performance.now();
    const { hit } = feed(text, 4);
    const ms = performance.now() - started;
    expect(hit).toBeNull();
    // Linear: about 0.1 s here. Re-reading the whole reply on every delta took over 2 s.
    expect(ms).toBeLessThan(1000);
  });
});

describe('imitationToolsFrom', () => {
  it('reads each named tool with its top-level input properties', () => {
    expect(TOOLS).toEqual([
      { name: 'http_request', properties: ['url', 'method', 'body', 'headers'] },
      { name: 'read_file', properties: ['path', 'offset', 'limit'] },
      { name: 'web_search', properties: [] },
    ]);
  });
});
