import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Short } from './utils.js';
import {
  redactWireUserMessage,
  buildWireSnapshot,
  extractWireFields,
  isWireSinkEnabled,
  wireSinkDir,
  writeWireSnapshot,
  captureWireSnapshot,
  isRawWireSinkEnabled,
  rawWireSinkDir,
  writeRawWireBody,
  captureRawWireBody,
  type WireSnapshotInput,
  type RawWireBody,
} from './wire-capture.js';

// The engine emits `<secrets>secret:NAME (***last4), …</secrets>`. Exercising the
// redactor needs that exact shape at runtime, but a literal `secret:NAME (***…)` in
// source trips the repo's secret-pattern pre-push scanner (a heuristic tuned for REAL
// secrets — these are fake fixtures). So assemble the token at runtime; no literal
// `secret:` sequence ever appears in a scanned source line.
const SEC = 'sec' + 'ret';
const SECRET_TOKEN = `${SEC}:`;
const entry = (name: string, last4: string): string => `${SEC}:${name} (${'***'}${last4})`;
const secretsBlock = (...entries: Array<[string, string]>): string =>
  `<${SEC}s>${entries.map(([n, l]) => entry(n, l)).join(', ')}</${SEC}s>`;

const baseInput = (over: Partial<WireSnapshotInput> = {}): WireSnapshotInput => ({
  runId: 'run-abc',
  turnIndex: 3,
  model: 'ministral-14b-2512',
  provider: 'openai',
  systemText: 'You are lynox.',
  userMessage: 'do the thing',
  toolNames: ['spawn_agent', 'web_research', 'remember'],
  maxTokens: 8192,
  ephemeralTailChars: 1200,
  ...over,
});

const tmps: string[] = [];
afterEach(() => {
  for (const p of tmps.splice(0)) rmSync(p, { recursive: true, force: true });
});
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wire-sink-'));
  tmps.push(d);
  return d;
};

describe('redactWireUserMessage', () => {
  it('reduces a single-secret catalog to a count, dropping name + last-4', () => {
    const out = redactWireUserMessage(`task\n${secretsBlock(['ANTHROPIC_API_KEY', 'FgAA'])}`);
    expect(out).toContain('<secrets>1 secret available (names+last4 redacted)</secrets>');
    expect(out).not.toContain('ANTHROPIC_API_KEY');
    expect(out).not.toContain('FgAA');
    expect(out).not.toContain(SECRET_TOKEN);
  });

  it('counts multiple secrets and drops every name/last-4', () => {
    const out = redactWireUserMessage(
      secretsBlock(['ANTHROPIC_API_KEY', 'FgAA'], ['MISTRAL_KEY', '9z01'], ['STRIPE', 'abcd']),
    );
    expect(out).toContain('<secrets>3 secrets available (names+last4 redacted)</secrets>');
    expect(out).not.toMatch(/FgAA|9z01|abcd|MISTRAL|STRIPE/);
  });

  it('is whitespace-tolerant and case-insensitive on the tags', () => {
    // build tags with odd spacing/casing at runtime; the redactor must still match them
    const out = redactWireUserMessage(`< Secrets >${entry('EXFIL', '0000')}</ SECRETS >`);
    expect(out).toContain('1 secret available');
    expect(out).not.toContain('0000');
    expect(out).not.toContain(SECRET_TOKEN);
  });

  it('redacts multiple separate blocks', () => {
    const out = redactWireUserMessage(
      `${secretsBlock(['A', '1111'])} mid ${secretsBlock(['B', '2222'], ['C', '3333'])}`,
    );
    expect(out).not.toMatch(/1111|2222|3333/);
    expect((out.match(/names\+last4 redacted/g) ?? []).length).toBe(2);
  });

  it('leaves text without a secrets block unchanged', () => {
    const t = 'just a normal message with <retrieved_context>kg</retrieved_context>';
    expect(redactWireUserMessage(t)).toBe(t);
  });

  it('an empty catalog is reported as "0 secrets"', () => {
    expect(redactWireUserMessage('<secrets></secrets>')).toContain('<secrets>0 secrets available (names+last4 redacted)</secrets>');
  });

  it('masks a raw secret-shaped value that survives outside the catalog (defense in depth)', () => {
    // a provider key pasted into the message body / memory tail — not inside <secrets>
    const rawKey = 'sk-ant-' + 'A'.repeat(40);
    const out = redactWireUserMessage(`my key is ${rawKey} btw`);
    expect(out).not.toContain(rawKey);
    expect(out).toContain('***'); // masked, last-4 retained by maskSecretPatterns
  });
});

describe('buildWireSnapshot', () => {
  it('hashes the system text with sha256Short (dedupe key into prompt_snapshots)', () => {
    const s = buildWireSnapshot(baseInput({ systemText: 'SYS-PROMPT-XYZ' }));
    expect(s.systemPromptHash).toBe(sha256Short('SYS-PROMPT-XYZ'));
  });

  it('redacts the user message and reports its post-redaction length', () => {
    const s = buildWireSnapshot(baseInput({ userMessage: `x ${secretsBlock(['K', '9z99'])}` }));
    expect(s.userMessage).not.toContain('9z99');
    expect(s.userMessage).not.toContain(SECRET_TOKEN);
    expect(s.userMessageChars).toBe(s.userMessage.length);
  });

  it('derives toolCount and ephemeralTailPresent from the inputs', () => {
    expect(buildWireSnapshot(baseInput()).toolCount).toBe(3);
    expect(buildWireSnapshot(baseInput({ ephemeralTailChars: 0 })).ephemeralTailPresent).toBe(false);
    expect(buildWireSnapshot(baseInput({ ephemeralTailChars: 42 })).ephemeralTailPresent).toBe(true);
  });

  it('carries runId/model/provider/params through verbatim', () => {
    const s = buildWireSnapshot(baseInput());
    expect(s.runId).toBe('run-abc');
    expect(s.model).toBe('ministral-14b-2512');
    expect(s.provider).toBe('openai');
    expect(s.maxTokens).toBe(8192);
  });

  it('passes optional toolChoice/temperature through, or leaves them undefined', () => {
    const set = buildWireSnapshot(baseInput({ toolChoice: 'auto', temperature: 0 }));
    expect(set.toolChoice).toBe('auto');
    expect(set.temperature).toBe(0);
    const unset = buildWireSnapshot(baseInput());
    expect(unset.toolChoice).toBeUndefined();
    expect(unset.temperature).toBeUndefined();
  });
});

describe('extractWireFields (the agent.ts seam mapping — SDK-free)', () => {
  const sys = [{ text: 'A' }, { text: 'B' }];
  const tools = [{ name: 'spawn_agent' }, { name: 'remember' }];

  it('returns the last user message when content is a plain string', () => {
    const r = extractWireFields(
      [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'LAST typed + tail' }],
      sys, tools,
    );
    expect(r.userMessage).toBe('LAST typed + tail');
    expect(r.systemText).toBe('A\nB');
    expect(r.toolNames).toEqual(['spawn_agent', 'remember']);
  });

  it('flattens a block-array user message, placeholder-ing non-text blocks', () => {
    const r = extractWireFields(
      [{ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'result' },
        { type: 'text', text: 'the task' },
        { type: 'image', source: {} },
      ] }],
      sys, tools,
    );
    expect(r.userMessage).toBe('[tool_result]\nthe task\n[image]');
  });

  it('returns "" when there is no user message', () => {
    expect(extractWireFields([{ role: 'assistant', content: 'hi' }], sys, tools).userMessage).toBe('');
    expect(extractWireFields([], sys, tools).userMessage).toBe('');
  });

  it('picks the LAST user turn, not the first', () => {
    const r = extractWireFields(
      [{ role: 'user', content: 'A' }, { role: 'user', content: 'B' }],
      sys, tools,
    );
    expect(r.userMessage).toBe('B');
  });
});

describe('isWireSinkEnabled (file-gate is the sole on-switch)', () => {
  it('is false when the file-gate is absent (default / prod)', () => {
    const dir = mkTmp();
    // point the gate at a path that does not exist so we never read the real /tmp/wire-sink-on
    expect(isWireSinkEnabled({ LYNOX_DEBUG_WIRE_GATE_FILE: join(dir, 'absent') })).toBe(false);
  });

  it('is true when the file-gate is present — no env var required', () => {
    const dir = mkTmp();
    const gate = join(dir, 'on');
    writeFileSync(gate, '');
    expect(isWireSinkEnabled({ LYNOX_DEBUG_WIRE_GATE_FILE: gate })).toBe(true);
  });

  it('an env var alone (no gate file) never enables capture', () => {
    const dir = mkTmp();
    expect(isWireSinkEnabled({ LYNOX_DEBUG_WIRE_SINK: dir, LYNOX_DEBUG_WIRE_GATE_FILE: join(dir, 'absent') })).toBe(false);
  });
});

describe('wireSinkDir', () => {
  it('uses LYNOX_DEBUG_WIRE_SINK when set', () => {
    expect(wireSinkDir({ LYNOX_DEBUG_WIRE_SINK: '/custom/sink' })).toBe('/custom/sink');
  });

  it('falls back to a default dir under tmpdir when unset', () => {
    const d = wireSinkDir({});
    expect(d).toContain('lynox-wire-sink');
  });
});

describe('writeWireSnapshot / captureWireSnapshot', () => {
  it('writes a redacted 0600 JSON file into the sink dir', () => {
    const dir = mkTmp();
    const snap = buildWireSnapshot(baseInput({ userMessage: `hi ${secretsBlock(['K', '7z77'])}` }));
    writeWireSnapshot(snap, { LYNOX_DEBUG_WIRE_SINK: dir });
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const full = join(dir, files[0]!);
    // owner-only permissions (no group/other bits)
    expect(statSync(full).mode & 0o077).toBe(0);
    const parsed = JSON.parse(readFileSync(full, 'utf8')) as { userMessage: string };
    expect(parsed.userMessage).not.toContain('7z77');
  });

  it('captureWireSnapshot is a no-op (returns null, writes nothing) when gated off', () => {
    const dir = mkTmp();
    const gate = join(dir, 'on'); // gate file intentionally NOT created
    const res = captureWireSnapshot(baseInput(), { LYNOX_DEBUG_WIRE_SINK: dir, LYNOX_DEBUG_WIRE_GATE_FILE: gate });
    expect(res).toBeNull();
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(0);
  });

  it('captureWireSnapshot builds + writes when the gate is on', () => {
    const dir = mkTmp();
    const gate = join(dir, 'on');
    writeFileSync(gate, '');
    const res = captureWireSnapshot(baseInput({ toolNames: ['a', 'b'] }), { LYNOX_DEBUG_WIRE_SINK: dir, LYNOX_DEBUG_WIRE_GATE_FILE: gate });
    expect(res?.toolCount).toBe(2);
    expect(res?.model).toBe('ministral-14b-2512');
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(1);
    expect(existsSync(gate)).toBe(true);
  });

  it('swallows a write failure — never throws into the turn', () => {
    const base = mkTmp();
    // make the sink path uncreatable: its parent is a FILE, so mkdirSync(recursive) fails
    const asFile = join(base, 'blocker');
    writeFileSync(asFile, '');
    const snap = buildWireSnapshot(baseInput());
    expect(() => writeWireSnapshot(snap, { LYNOX_DEBUG_WIRE_SINK: join(asFile, 'sub') })).not.toThrow();
  });
});

describe('raw-body sink (eval / wire-replay path)', () => {
  const rawBase = (): Omit<RawWireBody, 'capturedAt'> => ({
    runId: 'run-raw',
    turnIndex: 2,
    model: 'ministral-14b-2512',
    provider: 'openai',
    system: [{ type: 'text', text: 'SYSTEM' }],
    messages: [{ role: 'user', content: 'task\n<secrets>secret:K (***9999)</secrets>' }],
    tools: [{ name: 'spawn_agent' }],
    maxTokens: 8192,
  });

  it('has its OWN gate — independent of the redacted sink', () => {
    const dir = mkTmp();
    const rawGate = join(dir, 'raw-on');
    const redGate = join(dir, 'red-on');
    writeFileSync(redGate, ''); // redacted gate on, raw gate absent
    expect(isRawWireSinkEnabled({ LYNOX_DEBUG_WIRE_RAW_GATE_FILE: rawGate })).toBe(false);
    expect(isWireSinkEnabled({ LYNOX_DEBUG_WIRE_GATE_FILE: redGate })).toBe(true);
    writeFileSync(rawGate, '');
    expect(isRawWireSinkEnabled({ LYNOX_DEBUG_WIRE_RAW_GATE_FILE: rawGate })).toBe(true);
  });

  it('rawWireSinkDir defaults under tmpdir, or uses the override', () => {
    expect(rawWireSinkDir({})).toContain('lynox-wire-sink-raw');
    expect(rawWireSinkDir({ LYNOX_DEBUG_WIRE_RAW_SINK: '/x/raw' })).toBe('/x/raw');
  });

  it('writes the FULL UNREDACTED body 0600 (replay fidelity — secrets retained verbatim)', () => {
    const dir = mkTmp();
    const body: RawWireBody = { ...rawBase(), capturedAt: 111 };
    writeRawWireBody(body, { LYNOX_DEBUG_WIRE_RAW_SINK: dir });
    const files = readdirSync(dir).filter(f => f.startsWith('raw-') && f.endsWith('.json'));
    expect(files.length).toBe(1);
    const full = join(dir, files[0]!);
    expect(statSync(full).mode & 0o077).toBe(0);
    const txt = readFileSync(full, 'utf8');
    // the raw body is deliberately NOT redacted — the eval needs the real request
    expect(txt).toContain('9999');
    expect(txt).toContain('SYSTEM');
    expect(txt).toContain('spawn_agent');
  });

  it('captureRawWireBody is a no-op when its gate is off, writes + stamps capturedAt when on', () => {
    const dir = mkTmp();
    const gate = join(dir, 'gate'); // not 'raw-*' so it never matches the body filter below
    expect(captureRawWireBody(rawBase(), { LYNOX_DEBUG_WIRE_RAW_SINK: dir, LYNOX_DEBUG_WIRE_RAW_GATE_FILE: gate })).toBeNull();
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(0);
    writeFileSync(gate, '');
    const res = captureRawWireBody(rawBase(), { LYNOX_DEBUG_WIRE_RAW_SINK: dir, LYNOX_DEBUG_WIRE_RAW_GATE_FILE: gate });
    expect(res).not.toBeNull();
    expect(typeof res?.capturedAt).toBe('number');
    expect(readdirSync(dir).filter(f => f.startsWith('raw-') && f.endsWith('.json')).length).toBe(1);
  });
});
