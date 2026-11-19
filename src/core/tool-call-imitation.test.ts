import { describe, it, expect } from 'vitest';
import {
  MAX_COPY_GAP,
  MAX_NEAR_COPY_GAP,
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

    it('reads a reply that shows a call as an example to the end', () => {
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

  it('reads a requested list of example requests to the end', () => {
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

  it('reads a long ordinary answer without stopping it, and the characters scanned grow linearly with its length', () => {
    const para = 'The quarterly report shows revenue of 1.2M, up 4% on the year (see table 3). '
      + 'Costs {fixed and variable} were flat; the http_request budget line is unchanged. '
      + 'Example config: {"region": "eu", "tier": "pro"}. Next steps follow below.\n';
    const code = 'function f(a) { if (a) { return { x: a, y: [1, 2, 3] }; } return null; }\n';
    const answer = (n: number): string => { let t = ''; while (t.length < n) t += para + code; return t; };
    const work = (text: string): number => {
      const d = new ToolCallImitationDetector(TOOLS);
      expect(feed(text, 4, d).hit).toBeNull();
      return d.charsExamined();
    };
    const small = work(answer(100_000));
    const large = work(answer(400_000));
    // Every character is handled at least once, prose included.
    expect(work('Plain prose without any brackets at all. '.repeat(2_500))).toBeGreaterThanOrEqual(100_000);
    // Four times the text, about four times the characters examined. Re-reading the whole
    // reply on every delta made it about sixteen.
    expect(large / small).toBeGreaterThan(3.5);
    expect(large / small).toBeLessThan(4.5);
  });

  it.each([['<tool_call>'], ['<|tool_calls_section_begin|>'], ['read_file(']])('reads one large piece of %s openers without a closer to the end, and the characters scanned grow linearly with its size', (opener) => {
    const work = (n: number): number => {
      const d = new ToolCallImitationDetector(TOOLS);
      expect(d.push(opener.repeat(Math.ceil(n / opener.length)).slice(0, n))).toBeNull();
      return d.charsExamined();
    };
    const small = work(25_000);
    const large = work(100_000);
    expect(small).toBeGreaterThanOrEqual(25_000);
    // Four times the text, about four times the characters examined.
    expect(large / small).toBeLessThan(6);
  });

  it('keeps only the runs that a later copy can still extend', () => {
    const d = new ToolCallImitationDetector(TOOLS);
    let text = '';
    for (let i = 0; text.length < 1_000_000; i++) text += `read_file("f${i}")\n`;
    let most = 0;
    for (let o = 0; o < text.length; o += 7) {
      expect(d.push(text.slice(o, o + 7))).toBeNull();
      most = Math.max(most, d.trackedRuns());
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(300);
  });
});

describe('ToolCallImitationDetector on templates, code and provider call formats', () => {
  const SCHEMAS = imitationToolsFrom([
    { name: 'contacts_save', input_schema: { properties: { company: {}, email: {}, name: {}, notes: {}, phone: {}, tags: {}, type: {} } } },
    { name: 'read_file', input_schema: { properties: { path: {} } } },
    { name: 'write_file', input_schema: { properties: { path: {}, content: {} } } },
    { name: 'bash', input_schema: { properties: { command: {}, timeout_ms: {} } } },
    { name: 'save_workflow', input_schema: { properties: { description: {}, name: {}, workflow_id: {} } } },
    { name: 'task_create', input_schema: { properties: { assignee: {}, description: {}, due_date: {}, priority: {}, title: {}, tags: {} } } },
    { name: 'http_request', input_schema: { properties: { body: {}, headers: {}, method: {}, timeout_ms: {}, url: {} } } },
    { name: 'web_search', input_schema: { properties: { query: {}, limit: {} } } },
  ]);
  const run = (text: string, step = 5): ImitationHit | null => feed(text, step, new ToolCallImitationDetector(SCHEMAS)).hit;

  describe.each([[''], ['...'], ['…'], ['TBD'], [' xxx '], ['String'], ['example'], ['todo'], ['<url>'], [null]])('a schema whose fields all hold %j', (slot) => {
    it('is read to the end', () => {
      const row = JSON.stringify({ url: slot, method: slot });
      expect(run([row, row, row].join('\n') + '\n')).toBeNull();
    });
  });

  it('a request with concrete values in the same shape is a call', () => {
    const row = JSON.stringify({ url: 'https://x.test/a', method: 'GET' });
    expect(run([row, row, row].join('\n') + '\n')?.toolName).toBe('http_request');
    // One concrete field is enough.
    const mixed = JSON.stringify({ url: 'https://x.test/a', method: '' });
    expect(run([mixed, mixed, mixed].join('\n') + '\n')?.toolName).toBe('http_request');
  });

  it('reads an import template to the end', () => {
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

  it('reads a format description to the end', () => {
    const row = '{"name": "...", "description": "..."}';
    expect(run(`Format:\n[${[row, row, row].join(', ')}]`)).toBeNull();
    expect(run(['{"name": "<name>", "description": "<text>"}', '{"name": "<name>", "description": "<text>"}', '{"name": "<name>", "description": "<text>"}'].join('\n'))).toBeNull();
    const filled = '{"name": "Weekly report", "description": "Collects the numbers"}';
    expect(run(`[${[filled, filled, filled].join(', ')}]`)?.toolName).toBe('save_workflow');
  });

  it('reads a list of records that share a nested object to the end', () => {
    const text = '[{"title":"A","x":{"priority":"high","description":"Fix login"}},{"title":"B","x":{"priority":"high","description":"Fix login"}},{"title":"C","x":{"priority":"high","description":"Fix login"}}]';
    expect(run(text)).toBeNull();
    // The nested object on its own, three times in a row, stops.
    const own = '{"priority":"high","description":"Fix login"}';
    expect(run([own, own, own].join('\n') + '\n')?.toolName).toBe('task_create');
  });

  it('reads code that defines and uses a function of a tool\'s name to the end', () => {
    const filler = '# ' + 'read the configuration and validate every field before use. '.repeat(36) + '\n';
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

  it('reads code that defines a function of a tool\'s name and calls it nearby to the end', () => {
    const python = 'def read_file(path):\n    with open(path) as f:\n        return f.read()\n\nif os.path.exists(path):\n    data = read_file(path)\nelse:\n    log(path)\nprint(len(read_file(path)))\n';
    expect(run(python)).toBeNull();
    expect(run(python, 1)).toBeNull();
    const js = 'function bash(cmd) { return exec(cmd); }\nbash("ls");\nbash("ls");\n';
    expect(run(js)).toBeNull();
    // The same calls without the definition, back to back, stop.
    expect(run('read_file(path)\nread_file(path)\nread_file(path)\n')?.toolName).toBe('read_file');
    expect(run('x = 1\nbash("ls");\nbash("ls");\nbash("ls");\n')?.toolName).toBe('bash');
  });

  it('reads code that calls a method of that name on another object to the end', () => {
    expect(run('client.read_file(path)\nclient.read_file(path)\nclient.read_file(path)\n')).toBeNull();
    expect(run('fs . read_file(path)\nfs . read_file(path)\nfs . read_file(path)\n', 1)).toBeNull();
    for (const line of ['data = self.tools.read_file("config.json")', 'result = tool.bash(command="ls")']) {
      const code = [line, line, line].join('\n') + '\n';
      expect(run(code)).toBeNull();
      expect(run(code, 1)).toBeNull();
    }
  });

  describe.each([
    ['default_api.', 'print(default_api.read_file(path="a.txt"))', 'read_file'],
    ['to=functions.', 'to=functions.bash {"command":"ls"}', 'bash'],
    ['functions.', 'functions.read_file(path="a.txt")', 'read_file'],
  ])('a call through the tool namespace %s', (_ns, unit, tool) => {
    it('stops on the third copy', () => {
      expect(run([unit, unit, unit].join('\n') + '\n')?.toolName).toBe(tool);
      expect(run([unit, unit, unit].join('\n') + '\n', 1)?.toolName).toBe(tool);
    });
  });

  describe.each([
    ['a call wrapped in a list', '{"calls":[{"path":"a.txt","content":"hi"}]}', 'write_file'],
    ['a named call in a tool_calls list', '{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}', 'bash'],
    ['a function call in a tool_calls list', '{"tool_calls":[{"type":"function","function":{"name":"bash","arguments":"{}"}}]}', 'bash'],
  ])('%s', (_label, unit, tool) => {
    it('stops ten copies, one per line and on one line', () => {
      expect(run(Array.from({ length: 10 }, () => unit).join('\n'))?.toolName).toBe(tool);
      expect(run(unit.repeat(10), 1)?.toolName).toBe(tool);
    });
  });

  it('stops a call that comes back after a long made-up result each time', () => {
    const copy = `<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>\n<tool_response>\n${'lorem ipsum '.repeat(35)}\n</tool_response>`;
    expect(run(Array.from({ length: 6 }, () => copy).join('\n'))?.toolName).toBe('read_file');
    expect(run(Array.from({ length: 6 }, () => copy).join('\n'), 1)?.toolName).toBe('read_file');
  });

  it('stops a call that comes back between other, different calls each time', () => {
    const call = '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
    let others = '';
    for (let i = 0; others.length < 1800; i++) others += `\n<tool_call>{"name":"read_file","arguments":{"path":"n${i}.txt"}}</tool_call>`;
    for (let lead = 0; lead <= 2000; lead += 100) {
      const text = `${'~'.repeat(lead)}${call}${others}\n${call}${others}\n${call}\n`;
      expect(run(text)?.signature).toBe(call);
    }
  });

  it('stops two long calls that alternate', () => {
    const a = `<tool_call>{"name":"write_file","arguments":{"path":"a","content":"${'x'.repeat(500)}"}}</tool_call>`;
    const b = `<tool_call>{"name":"write_file","arguments":{"path":"b","content":"${'x'.repeat(500)}"}}</tool_call>`;
    expect(run(Array.from({ length: 5 }, () => `${a}\n${b}`).join('\n'))?.toolName).toBe('write_file');
    expect(run(Array.from({ length: 5 }, () => `${a}\n${b}`).join('\n'), 1)?.toolName).toBe('write_file');
  });

  it('counts copies that follow each other closely as one run', () => {
    const gap = '~'.repeat(MAX_NEAR_COPY_GAP + 1);
    const call = 'bash("ls")';
    expect(run(`${call}\n${call}\n${gap}${call}\n${call}\n`)).toBeNull();
    expect(run(`${call}\n${call}\n${gap}${call}\n${call}\n${call}\n`)?.count).toBe(3);
    expect(run(`${call}${'~'.repeat(MAX_NEAR_COPY_GAP)}${call}${'~'.repeat(MAX_NEAR_COPY_GAP)}${call}\n`)?.count).toBe(3);
    const keys = '{"command": "ls", "timeout_ms": 500}';
    expect(run(`${keys}${'~'.repeat(MAX_NEAR_COPY_GAP)}${keys}${'~'.repeat(MAX_NEAR_COPY_GAP)}${keys}\n`)?.toolName).toBe('bash');
    expect(run(`${keys}${gap}${keys}${gap}${keys}\n`)).toBeNull();
    // A short note between the copies keeps them one run; a paragraph does not.
    const note = (n: number): string => `\n${'Running it again to be sure. '.repeat(20).slice(0, n)}\n`;
    expect(run(`${call}${note(250)}${call}${note(250)}${call}\n`)?.toolName).toBe('bash');
    expect(run(`${call}${note(400)}${call}${note(400)}${call}\n`)).toBeNull();
  });

  describe.each([
    ['a call in markup', '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>'],
    ['a call object that names the tool', '{"name": "bash", "arguments": {"command": "ls"}}'],
  ])('%s', (_label, unit) => {
    it('counts copies with a long stretch of text between them as one run', () => {
      const near = '~'.repeat(MAX_COPY_GAP);
      const far = '~'.repeat(MAX_COPY_GAP + 1);
      expect(run(`${unit}${near}${unit}${near}${unit}\n`)?.toolName).toBe('bash');
      expect(run(`${unit}${near}${unit}${near}${unit}\n`, 1)?.toolName).toBe('bash');
      expect(run(`${unit}${far}${unit}${far}${unit}\n`)).toBeNull();
    });
  });

  describe('an answer that shows the same request more than once', () => {
    const prose = (n: number): string => 'The request body below is the same in every language; only the client changes. '.repeat(Math.ceil(n / 80)).slice(0, n);
    const body = '{"url": "https://api.acme.ch/v1/orders", "method": "POST"}';
    const config = '{"server": {"url": "https://a.ch", "method": "GET", "timeout_ms": 5000}, "retries": 3}';
    const search = '{"query": "lynox pricing", "limit": 5}';
    it.each([
      ...[600, 1200, 1900].map((g): [string, string] => [`in curl, Python and JavaScript, ${g} characters apart`,
        `curl -X POST -d '${body}'\n${prose(g)}\nrequests.post(json=${body})\n${prose(g)}\nfetch(u, {body: JSON.stringify(${body})})\n`]),
      ['as a nested configuration, three times', [config, config, config].join(`\n${prose(1200)}\n`)],
      ['as a shell command between explanations', ['bash("ls")', 'bash("ls")', 'bash("ls")'].join(`\n${prose(800)}\n`)],
      ['as the same search, three times', [search, search, search].join(`\n${prose(1500)}\n`)],
    ])('%s is read to the end', (_label, text) => {
      expect(run(text)).toBeNull();
      expect(run(text, 1)).toBeNull();
    });
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

  it('reads data objects that have a name field to the end', () => {
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
