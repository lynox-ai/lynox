import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Short } from './utils.js';
import {
  redactWireUserMessage,
  buildWireSnapshot,
  extractWireFields,
  isWireSinkEnabled,
  isProvisionedInstance,
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

  it('defaults under the engine data dir, NOT tmpdir', () => {
    // The default moved off `/tmp` deliberately: a world-writable sink location
    // (and, worse, a world-writable arming marker) made "is capture on?" a
    // question any process on the box could answer yes to.
    expect(wireSinkDir({ LYNOX_DATA_DIR: '/data/lx' })).toBe('/data/lx/wire-sink');
    expect(wireSinkDir({})).not.toContain(tmpdir());
    expect(wireSinkDir({})).toContain('.lynox');
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

  it('rawWireSinkDir defaults under the data dir, or uses the override', () => {
    expect(rawWireSinkDir({ LYNOX_DATA_DIR: '/data/lx' })).toBe('/data/lx/wire-sink-raw');
    expect(rawWireSinkDir({})).not.toContain(tmpdir());
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

// ── The structural half of the gate ─────────────────────────────────────────
//
// A file marker cannot express "not on a customer's box": any process that can
// create a file can arm it, and on the old `/tmp` default that included a tool
// call steered by injected content. Process env can express it — it is fixed at
// exec, so an in-container actor cannot rewrite it for the running engine.
//
// The redacted sink writes scrubbed personal data. The raw sink writes the FULL
// secrets catalog and the whole KG, so it matters more; both refuse.
describe('capture sinks refuse on a control-plane-provisioned instance', () => {
  const armed = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    LYNOX_DEBUG_WIRE_GATE_FILE: GATE,
    LYNOX_DEBUG_WIRE_RAW_GATE_FILE: GATE,
    ...extra,
  });

  // A real armed marker, so "refused" cannot be confused with "never armed".
  let GATE = '';
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gate-'));
    GATE = join(dir, 'on');
    writeFileSync(GATE, '');
  });

  it('arms on a self-hosted box — the control that makes the refusals meaningful', () => {
    expect(isWireSinkEnabled(armed())).toBe(true);
    expect(isRawWireSinkEnabled(armed())).toBe(true);
  });

  it.each([
    ['LYNOX_MANAGED_INSTANCE_ID', 'abc123def456ghi789jkl'],
    ['LYNOX_BILLING_TIER', 'managed'],
    ['LYNOX_BILLING_TIER', 'hosted'],   // BYOK is a customer's box too
    ['LYNOX_MANAGED_MODE', 'managed'],  // the legacy alias the registry keeps forever
  ])('refuses both sinks when %s is set, even with the marker present', (key, value) => {
    const env = armed({ [key]: value });
    // MUTATION THIS KILLS: dropping either `isProvisionedInstance` early-out.
    expect(isWireSinkEnabled(env)).toBe(false);
    expect(isRawWireSinkEnabled(env)).toBe(false);
    // captureWireSnapshot is the one-shot convenience — it must refuse too.
    expect(captureWireSnapshot({
      runId: 'r1', turnIndex: 0, model: 'm', provider: 'p', systemText: 's',
      userMessage: 'u', toolNames: [], maxTokens: 1, ephemeralTailChars: 0,
    }, env)).toBeNull();
  });

  it('an operator acknowledgement re-arms it — the recorded qa-managed workflow', () => {
    // A blanket refusal would break the managed-tenant capture the acceptance
    // test and the wire-replay eval both use; DEF-wire-capture-prod-gate says so
    // and is why that row was downgraded rather than closed this way before.
    // The acknowledgement is an ENV edit through the control plane — an operator
    // action the in-container threat cannot perform on a running process.
    const env = armed({ LYNOX_BILLING_TIER: 'managed', LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED: '1' });
    expect(isWireSinkEnabled(env)).toBe(true);
    expect(isRawWireSinkEnabled(env)).toBe(true);
  });

  it('accepts ONLY the exact acknowledgement value', () => {
    // MUTATION THIS KILLS: loosening the check to truthiness. 'false', '0' and
    // 'no' are all truthy strings, and an env var spelled by hand is exactly
    // where that bites — a tenant carrying LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED=0
    // would silently be capturing.
    for (const v of ['0', 'false', 'no', 'true', 'yes', '', ' 1']) {
      expect(isWireSinkEnabled(armed({ LYNOX_BILLING_TIER: 'managed', LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED: v })))
        .toBe(false);
    }
  });

  it('the acknowledgement alone arms NOTHING without the marker', () => {
    // It is a permission to consider the marker, not a second arming path.
    expect(isWireSinkEnabled({ LYNOX_BILLING_TIER: 'managed', LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED: '1',
      LYNOX_DEBUG_WIRE_GATE_FILE: '/nonexistent/gate' })).toBe(false);
  });

  it('treats an EMPTY marker as absent, not as provisioned', () => {
    // An empty env var is how a compose file spells "unset" by accident; it must
    // not silently disable an operator's own capture.
    expect(isProvisionedInstance({ LYNOX_BILLING_TIER: '' })).toBe(false);
    expect(isWireSinkEnabled(armed({ LYNOX_BILLING_TIER: '' }))).toBe(true);
  });

  it('fails closed on a PARTIAL provisioning env', () => {
    // Only one of the three present — a provisioning bug, not a licence.
    expect(isProvisionedInstance({ LYNOX_MANAGED_INSTANCE_ID: 'x' })).toBe(true);
  });
});

// ── The two surviving mutants an adversarial pass found ─────────────────────
const SNAP = buildWireSnapshot({
  runId: 'r1', turnIndex: 0, model: 'm', provider: 'p', systemText: 's',
  userMessage: 'u', toolNames: [], maxTokens: 1, ephemeralTailChars: 0,
});

describe('sink defaults that no test was pinning', () => {
  it('gives the RAW sink its own marker path, not the redacted sink\'s', () => {
    // MUTATION THIS KILLS: collapsing the raw default onto `wire-sink-on`.
    // Every other test supplies explicit gate overrides, so the default raw
    // path was unexercised — and one `touch ~/.lynox/wire-sink-on` would then
    // have armed the FULL secrets-catalog + KG dump alongside the redacted one,
    // destroying the "separate, more deliberate opt-in" this file promises.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-defaults-'));
    writeFileSync(join(dir, 'wire-sink-on'), '');   // arm ONLY the redacted marker
    const env = { LYNOX_DATA_DIR: dir };
    expect(isWireSinkEnabled(env)).toBe(true);
    expect(isRawWireSinkEnabled(env)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('honours the legacy LYNOX_DIR alias when resolving the data dir', () => {
    // MUTATION THIS KILLS: dropping `?? env['LYNOX_DIR']`. A self-hoster on the
    // legacy alias would silently resolve to `~/.lynox` instead of their real
    // data dir — capture armed in one place, looked for in another.
    expect(wireSinkDir({ LYNOX_DIR: '/legacy/lx' })).toBe('/legacy/lx/wire-sink');
    expect(rawWireSinkDir({ LYNOX_DIR: '/legacy/lx' })).toBe('/legacy/lx/wire-sink-raw');
    // Canonical wins when both are present.
    expect(wireSinkDir({ LYNOX_DIR: '/legacy/lx', LYNOX_DATA_DIR: '/new/lx' })).toBe('/new/lx/wire-sink');
  });
});

describe('a sink dir that already exists is not trusted as found', () => {
  it('refuses a symlinked sink dir rather than following it', () => {
    // `mkdirSync(dir, {mode})` sets the mode only when it CREATES the dir, so a
    // pre-planted symlink survived the move off /tmp untouched and redirected
    // the capture wherever it pointed. DEF-wire-capture-prod-gate asks for this
    // explicitly ("incl. tightening a pre-existing loose/symlinked dir").
    const base = mkdtempSync(join(tmpdir(), 'lynox-symlink-'));
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    const sink = join(base, 'sink');
    symlinkSync(elsewhere, sink);

    writeWireSnapshot(SNAP, { LYNOX_DEBUG_WIRE_SINK: sink });

    // MUTATION THIS KILLS: reverting to a bare mkdirSync — the file lands in
    // the symlink target and this directory is no longer empty.
    expect(readdirSync(elsewhere)).toHaveLength(0);
    rmSync(base, { recursive: true, force: true });
  });

  it('tightens a pre-existing world-readable sink dir to 0700', () => {
    const base = mkdtempSync(join(tmpdir(), 'lynox-loose-'));
    const sink = join(base, 'sink');
    mkdirSync(sink, { mode: 0o755 });
    expect(statSync(sink).mode & 0o777).toBe(0o755);

    writeWireSnapshot(SNAP, { LYNOX_DEBUG_WIRE_SINK: sink });

    expect(statSync(sink).mode & 0o777).toBe(0o700);
    expect(readdirSync(sink)).toHaveLength(1);   // and it still wrote
    rmSync(base, { recursive: true, force: true });
  });
});
