import { describe, it, expect } from 'vitest';
import {
  MAX_COPY_GAP,
  MAX_UNIT_CHARS,
  PLACEHOLDER_VALUES,
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

    it('lets a reply show a call as an example', () => {
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

  it('lets the user\'s requested list of example requests through', () => {
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

  it('reads a long ordinary answer without stopping it, in time that grows linearly with its length', () => {
    const para = 'The quarterly report shows revenue of 1.2M, up 4% on the year (see table 3). '
      + 'Costs {fixed and variable} were flat; the http_request budget line is unchanged. '
      + 'Example config: {"region": "eu", "tier": "pro"}. Next steps follow below.\n';
    const code = 'function f(a) { if (a) { return { x: a, y: [1, 2, 3] }; } return null; }\n';
    const answer = (n: number): string => { let t = ''; while (t.length < n) t += para + code; return t; };
    const best = (text: string): number => {
      let min = Infinity;
      for (let r = 0; r < 3; r++) {
        const started = performance.now();
        expect(feed(text, 4).hit).toBeNull();
        min = Math.min(min, performance.now() - started);
      }
      return min;
    };
    best(answer(50_000)); // warm-up
    const small = best(answer(100_000));
    const large = best(answer(400_000));
    // Four times the text: about four times the time. Re-reading the whole reply on every
    // delta made it about sixteen.
    expect(large / small).toBeLessThan(6);
  });
});

describe('ToolCallImitationDetector on templates, code and provider call formats', () => {
  const SCHEMAS = imitationToolsFrom([
    { name: 'contacts_save', input_schema: { properties: { company: {}, email: {}, name: {}, notes: {}, phone: {}, tags: {}, type: {} } } },
    { name: 'read_file', input_schema: { properties: { path: {} } } },
    { name: 'bash', input_schema: { properties: { command: {}, timeout_ms: {} } } },
    { name: 'save_workflow', input_schema: { properties: { description: {}, name: {}, workflow_id: {} } } },
    { name: 'task_create', input_schema: { properties: { assignee: {}, description: {}, due_date: {}, priority: {}, title: {}, tags: {} } } },
    { name: 'http_request', input_schema: { properties: { body: {}, headers: {}, method: {}, timeout_ms: {}, url: {} } } },
  ]);
  const run = (text: string, step = 5): ImitationHit | null => feed(text, step, new ToolCallImitationDetector(SCHEMAS)).hit;

  it('treats the listed slot values as placeholders', () => {
    expect([...PLACEHOLDER_VALUES]).toEqual(['', '...', '…', 'tbd', 'xxx', 'string', 'example', 'todo']);
  });

  it('lets an import template with empty fields through', () => {
    const row = '  {"name": "", "email": "", "phone": ""}';
    expect(run(`Use this import template:\n\`\`\`json\n[\n${[row, row, row].join(',\n')}\n]\n\`\`\`\n`)).toBeNull();
    const nulls = '{"name": null, "email": null, "phone": null}';
    expect(run([nulls, nulls, nulls].join('\n') + '\n')).toBeNull();
    const todo = '{"name": "TODO", "email": "xxx", "phone": "tbd"}';
    expect(run([todo, todo, todo].join('\n') + '\n')).toBeNull();
    // The same rows with values stop.
    const filled = '  {"name": "Anna Muster", "email": "anna@example.ch", "phone": "+41 44 000 00 00"}';
    expect(run(`[\n${[filled, filled, filled].join(',\n')}\n]\n`)?.toolName).toBe('contacts_save');
  });

  it('lets a format description with placeholder values through', () => {
    const row = '{"name": "...", "description": "..."}';
    expect(run(`Format:\n[${[row, row, row].join(', ')}]`)).toBeNull();
    expect(run(['{"name": "<name>", "description": "<text>"}', '{"name": "<name>", "description": "<text>"}', '{"name": "<name>", "description": "<text>"}'].join('\n'))).toBeNull();
    const filled = '{"name": "Weekly report", "description": "Collects the numbers"}';
    expect(run(`[${[filled, filled, filled].join(', ')}]`)?.toolName).toBe('save_workflow');
  });

  it('lets records that share a nested object through', () => {
    const text = '[{"title":"A","x":{"priority":"high","description":"Fix login"}},{"title":"B","x":{"priority":"high","description":"Fix login"}},{"title":"C","x":{"priority":"high","description":"Fix login"}}]';
    expect(run(text)).toBeNull();
    // The nested object on its own, three times in a row, stops.
    const own = '{"priority":"high","description":"Fix login"}';
    expect(run([own, own, own].join('\n') + '\n')?.toolName).toBe('task_create');
  });

  it('lets code that defines and uses a function of a tool\'s name through', () => {
    const filler = '# ' + 'read the configuration and validate every field before use. '.repeat(6) + '\n';
    expect(filler.length).toBeGreaterThan(MAX_COPY_GAP);
    const code = `def read_file(path):\n    with open(path) as f:\n        return f.read()\n${filler}data = read_file(path)\n${filler}print(len(read_file(path)))\n`;
    expect(run(code)).toBeNull();
    const shell = `bash("ls")\n${filler}bash("ls")\n${filler}bash("ls")\n`;
    expect(run(shell)).toBeNull();
    // The same calls back to back stop.
    expect(run('data = read_file(path)\nread_file(path)\nread_file(path)\n')?.toolName).toBe('read_file');
    expect(run('bash("ls")\nbash("ls")\nbash("ls")\n')?.toolName).toBe('bash');
    expect(run('bash("ls")\nbash("ls")\nbash("ls")\n', 1)?.toolName).toBe('bash');
  });

  it('counts copies that follow each other closely as one run', () => {
    const gap = '.'.repeat(MAX_COPY_GAP + 1);
    const call = 'bash("ls")';
    expect(run(`${call}\n${call}\n${gap}${call}\n${call}\n`)).toBeNull();
    expect(run(`${call}\n${call}\n${gap}${call}\n${call}\n${call}\n`)?.count).toBe(3);
    // A gap of exactly the limit still continues the run.
    expect(run(`${call}${'.'.repeat(MAX_COPY_GAP)}${call}${'.'.repeat(MAX_COPY_GAP)}${call}\n`)?.count).toBe(3);
  });

  describe.each([
    ['Mistral call list on one line', '[TOOL_CALLS][{"name":"read_file","arguments":{"path":"a.txt"}}]', 'read_file'],
    ['Mistral call with [ARGS] on one line', '[TOOL_CALLS]read_file[ARGS]{"path": "a.txt"}', 'read_file'],
    ['tool name with [ARGS]', 'read_file[ARGS]{"path": "a.txt"} ', 'read_file'],
    ['call object that names the tool', '{"name": "bash", "arguments": {"command": "ls -la"}} ', 'bash'],
    ['function object that names the tool', '{"type": "function", "function": {"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}} ', 'bash'],
    ['tool field that names the tool', '{"tool": "read_file", "input": {"path": "a.txt"}} ', 'read_file'],
    ['Llama call tags on one line', '<|python_tag|>web.run(query="opening hours")', undefined],
  ])('%s', (_label, unit, tool) => {
    it('stops 150 copies on one line', () => {
      const hit = run(unit.repeat(150), 4);
      expect(hit).not.toBeNull();
      expect(hit!.toolName).toBe(tool);
    });

    it('stops them when they arrive one character at a time', () => {
      const hit = run(unit.repeat(150), 1);
      expect(hit).not.toBeNull();
      expect(hit!.toolName).toBe(tool);
    });
  });

  it('reads data objects with a name field as data', () => {
    expect(run('{"name": "Anna", "arguments": {"x": 1}} '.repeat(10))).toBeNull();
    expect(run('{"name": "bash", "arguments": {"x": 1}} '.repeat(3))?.toolName).toBe('bash');
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
