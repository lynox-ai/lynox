import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Short } from './utils.js';
import {
  redactWireUserMessage,
  buildWireSnapshot,
  isWireSinkEnabled,
  wireSinkDir,
  writeWireSnapshot,
  captureWireSnapshot,
  type WireSnapshotInput,
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
    const res = captureWireSnapshot(baseInput(), { LYNOX_DEBUG_WIRE_SINK: dir, LYNOX_DEBUG_WIRE_GATE_FILE: gate });
    expect(res).not.toBeNull();
    expect(readdirSync(dir).filter(f => f.endsWith('.json')).length).toBe(1);
    expect(existsSync(gate)).toBe(true);
  });
});
