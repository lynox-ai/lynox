/**
 * Set-Bench scenarios — narrow set, deterministic mock-tools, regex-pinned
 * pass-checks. Each scenario maps to one of the two axes (tool-chain /
 * orchestration) so the report can group results without re-tagging.
 *
 * Mock-tool design rationale: the bench has to be reproducible across
 * runs and CI. Real `web_search` + real sub-agents would introduce
 * network-dependent flake AND charge real money on every CI tick. Each
 * scenario ships a real-tool variant (for the headline report) plus a
 * mocked-tool variant (for nightly regression). The mock-vs-real toggle
 * lives in the runner, not the scenario file.
 */

import type { SetBenchScenario, PassResult, ToolCallTrace } from './types.js';

// ── TOOL_CHAIN: lookup + compute, deterministic answer ─────────
// Mirrors the live mistral-demo smoke (Zurich population doubled). The
// mock `lookup_population` returns a frozen value, so we get a single
// correct final answer regardless of when the bench runs.

const ZURICH_POPULATION = 436_551;
const ZURICH_X2 = ZURICH_POPULATION * 2;

export const TOOL_CHAIN_ZURICH_X2: SetBenchScenario = {
  id: 'tool-chain.zurich-x2',
  axis: 'tool-chain',
  description: 'Two-tool agent loop: lookup_population("Zurich") then compute the result times 2. Regex-checked final answer.',
  prompt: [
    'Use the lookup_population tool to find the population of Zurich.',
    'Then use the compute tool to multiply that number by 2.',
    'Reply with exactly: ZURICH_X2=<number>',
    'Do not add anything else. Do not call lookup_population more than once.',
  ].join('\n'),
  passCheck: (finalText: string, toolCalls: readonly ToolCallTrace[]): PassResult => {
    // Both tools must be called. A model that hallucinates the
    // multiplication without calling compute passes the textual regex but
    // silently fails the routing claim, so it should fail here too.
    const lookups = toolCalls.filter((t) => t.name === 'lookup_population');
    const computes = toolCalls.filter((t) => t.name === 'compute');
    if (lookups.length === 0) return { pass: false, reason: 'never called lookup_population' };
    if (computes.length === 0) return { pass: false, reason: 'never called compute' };
    if (lookups.length > 3) return { pass: false, reason: `called lookup_population ${lookups.length}x (loop)` };
    const match = finalText.match(/ZURICH_X2=(\d+)/);
    if (!match) return { pass: false, reason: 'final answer missing ZURICH_X2=<n>' };
    const got = parseInt(match[1]!, 10);
    if (got !== ZURICH_X2) return { pass: false, reason: `wrong number: got ${got}, want ${ZURICH_X2}` };
    return { pass: true };
  },
  maxIterations: 10,
  timeoutMs: 120_000,
};

// ── ORCHESTRATION: email classification batch ──────
// Tests the haiku-replacement claim. The classifier runs on the same model
// (sub-agent inherits the parent's model in lynox unless overridden), so
// we are measuring orchestration plus classification jointly.

const EMAILS = [
  'Hi! When is the next product update? - Anna',
  'I want to unsubscribe from all your emails. Please.',
  'Can you confirm my payment was received? Order #4521.',
  'I love your product! 5 stars on Trustpilot - Marc',
  'You charged me twice this month. Refund please. URGENT.',
];

const EXPECTED_LABELS = ['question', 'unsubscribe', 'support', 'praise', 'complaint'];

export const ORCHESTRATION_EMAIL_TRIAGE: SetBenchScenario = {
  id: 'orchestration.email-triage',
  axis: 'orchestration',
  description: 'Classify 5 short emails into {question, unsubscribe, support, praise, complaint}. Tests batch orchestration on small models.',
  prompt: [
    'Below are 5 short customer emails. For each one, output exactly one label from',
    'this set: {question, unsubscribe, support, praise, complaint}.',
    '',
    'Reply with exactly 5 lines, formatted as:',
    '  email1: <label>',
    '  email2: <label>',
    '  email3: <label>',
    '  email4: <label>',
    '  email5: <label>',
    '',
    'Do not add commentary, do not call any tools, do not invent extra emails.',
    '',
    ...EMAILS.map((e, i) => `email${i + 1}: ${e}`),
  ].join('\n'),
  passCheck: (finalText: string, _toolCalls: readonly ToolCallTrace[]): PassResult => {
    // Parse one label per line. Tolerant of leading/trailing whitespace and
    // markdown bold formatting (small models love **unsubscribe**).
    const labels: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const line = new RegExp(`email${i}:\\s*\\**\\s*([a-z]+)\\s*\\**`, 'i').exec(finalText);
      if (!line) return { pass: false, reason: `missing or malformed line for email${i}` };
      labels.push(line[1]!.toLowerCase());
    }
    let correct = 0;
    for (let i = 0; i < 5; i++) {
      if (labels[i] === EXPECTED_LABELS[i]) correct++;
    }
    // Pass-bar: 4/5 correct. Email classification has ambiguity (e.g.
    // "complaint" vs "support" for the double-charge case), and strict
    // 5/5 would fail Anthropic Haiku ~20% of the time too, masking the
    // replacement-candidate signal we care about.
    if (correct < 4) return { pass: false, reason: `${correct}/5 correct: ${labels.join(', ')}` };
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 60_000,
};

// ── KG_EXTRACTION: named-entity extraction into structured JSON ──────
// Probes haiku-tier capability — lynox `entity-extractor-v2.ts` runs on
// Haiku by default. PassCheck parses JSON (tolerant of ```json fences)
// and asserts >=7/8 known entities present with correct type. Tier bar:
// Haiku 4.5.

const KG_PARAGRAPH = [
  'Maria Sanchez, the CTO of Acme Robotics, announced at the Berlin Tech Summit',
  'that her team will partner with Northwind Logistics on a pilot launching in Munich.',
  'The partnership was negotiated by Liam OConnor, head of operations at Northwind,',
  'after a kickoff meeting at the Acme office in Zurich. Funding comes from the',
  'Helios Ventures fund, whose managing partner Priya Kapoor signed the term sheet',
  'last week. Maria noted that the rollout will reach Hamburg by Q3.',
].join(' ');

interface KgEntity {
  readonly name: string;
  /** Lowercase aliases the model might emit. */
  readonly aliases: readonly string[];
  readonly type: 'person' | 'organization' | 'location';
}

const KG_EXPECTED: readonly KgEntity[] = [
  { name: 'Maria Sanchez', aliases: ['maria sanchez', 'maria'], type: 'person' },
  { name: 'Liam OConnor', aliases: ["liam oconnor", "liam o'connor", 'liam'], type: 'person' },
  { name: 'Priya Kapoor', aliases: ['priya kapoor', 'priya'], type: 'person' },
  { name: 'Acme Robotics', aliases: ['acme robotics', 'acme'], type: 'organization' },
  { name: 'Northwind Logistics', aliases: ['northwind logistics', 'northwind'], type: 'organization' },
  { name: 'Helios Ventures', aliases: ['helios ventures', 'helios'], type: 'organization' },
  { name: 'Berlin', aliases: ['berlin', 'berlin tech summit'], type: 'location' },
  { name: 'Munich', aliases: ['munich', 'münchen'], type: 'location' },
];

/**
 * Strip ```json / ``` fences and pull the first JSON array out of a
 * model response. Pure string ops — no eval, no Function. Returns null
 * when no parseable array is found so the passCheck can report it
 * explicitly rather than throw.
 */
export function extractJsonArray(text: string): unknown[] | null {
  // Drop common fence shapes the model might wrap output in.
  const stripped = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  // Find the first `[` and walk to its matching `]` with depth-1 string
  // awareness — handles `[` inside string values without exploding.
  const start = stripped.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (Array.isArray(parsed)) return parsed;
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function kgEntityMatches(actual: { name?: unknown; type?: unknown }, expected: KgEntity): boolean {
  const name = String(actual.name ?? '').trim().toLowerCase();
  const type = String(actual.type ?? '').trim().toLowerCase();
  if (!name) return false;
  // Match on canonical name OR any alias; tolerate substring (model often
  // includes a title like "CTO Maria Sanchez").
  const nameHit = expected.aliases.some((alias) => name.includes(alias));
  if (!nameHit) return false;
  // Type may come back as "person"/"people"/"PER" — accept the singular
  // canonical token only; bench is about adherence, not synonym resolution.
  if (!type.includes(expected.type)) return false;
  return true;
}

export const KG_EXTRACTION_ENTITIES: SetBenchScenario = {
  id: 'kg-extraction.entities',
  axis: 'kg-extraction',
  description: 'Extract 8 named entities (people / organizations / locations) from a fixed paragraph into a JSON array. Tests the haiku-tier KG-extractor replacement claim.',
  prompt: [
    'Read the paragraph below and extract every named entity that appears.',
    'Output a JSON array. Each item has exactly two fields:',
    '  - name (string, the canonical surface form)',
    '  - type (string, one of: person, organization, location)',
    '',
    'Output ONLY the JSON array — no prose, no markdown fences, no commentary.',
    '',
    'Paragraph:',
    KG_PARAGRAPH,
  ].join('\n'),
  passCheck: (finalText, _toolCalls): PassResult => {
    const arr = extractJsonArray(finalText);
    if (arr === null) return { pass: false, reason: 'final output did not contain a parseable JSON array' };
    // Track claimed arr indices so a single hallucinated item ("Acme Helios
    // Robotics") can't satisfy two expected entries (Acme AND Helios).
    // Each expected entity must bind to a distinct actual item.
    const claimed = new Set<number>();
    let matched = 0;
    const missing: string[] = [];
    for (const expected of KG_EXPECTED) {
      const idx = arr.findIndex((item, i) => !claimed.has(i) && typeof item === 'object' && item !== null && kgEntityMatches(item as { name?: unknown; type?: unknown }, expected));
      if (idx >= 0) {
        claimed.add(idx);
        matched++;
      } else {
        missing.push(expected.name);
      }
    }
    if (matched < 7) return { pass: false, reason: `only ${matched}/8 entities matched; missing: ${missing.join(', ')}` };
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 60_000,
};

// ── DAG_PLANNING: topologically valid step graph ──────
// Probes haiku-tier capability — lynox `dag-planner.ts` builds plan
// graphs on Haiku. PassCheck parses JSON, asserts the 3 known steps are
// present with valid depends_on arrays that form a DAG (no cycles).
// Tier bar: Haiku 4.5.

const DAG_STEPS_EXPECTED: readonly { id: string; mustDependOn: readonly string[] }[] = [
  // `cut_tag` is the root, has no required upstream.
  { id: 'cut_tag', mustDependOn: [] },
  // `run_tests` must depend on cut_tag (we tag, then run the tests on the tagged commit).
  { id: 'run_tests', mustDependOn: ['cut_tag'] },
  // `deploy` must depend on run_tests (deployment gated by green tests).
  { id: 'deploy', mustDependOn: ['run_tests'] },
];

interface DagStep {
  readonly id: string;
  readonly depends_on: readonly string[];
}

function parseDagSteps(arr: unknown[]): DagStep[] | null {
  const out: DagStep[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) return null;
    const rec = item as { id?: unknown; depends_on?: unknown };
    if (typeof rec.id !== 'string') return null;
    const deps = rec.depends_on;
    if (!Array.isArray(deps)) return null;
    const depStrings: string[] = [];
    for (const d of deps) {
      if (typeof d !== 'string') return null;
      depStrings.push(d);
    }
    out.push({ id: rec.id, depends_on: depStrings });
  }
  return out;
}

/**
 * Topological-sort check via Kahn's algorithm. Returns true if every
 * node's depends_on resolves AND no cycle exists. Exported so the test
 * suite can pin the contract directly (cycle detection is the silent
 * failure mode we worry about).
 */
export function isValidDag(steps: readonly DagStep[]): boolean {
  const byId = new Map(steps.map((s) => [s.id, s] as const));
  // Every dependency must point to a known node.
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (!byId.has(dep)) return false;
    }
  }
  const indegree = new Map<string, number>();
  for (const s of steps) indegree.set(s.id, s.depends_on.length);
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const s of steps) {
      if (s.depends_on.includes(id)) {
        const next = (indegree.get(s.id) ?? 0) - 1;
        indegree.set(s.id, next);
        if (next === 0) queue.push(s.id);
      }
    }
  }
  return visited === steps.length;
}

export const DAG_PLANNING_RELEASE: SetBenchScenario = {
  id: 'dag-planning.release',
  axis: 'dag-planning',
  description: 'Plan a 3-step release pipeline (cut_tag → run_tests → deploy) as a topologically valid JSON DAG. Tests the haiku-tier DAG-planner replacement claim.',
  prompt: [
    'Plan a small release pipeline as a directed acyclic graph (DAG).',
    'The pipeline has exactly these 3 steps:',
    '  - cut_tag    — cut a release tag from main',
    '  - run_tests  — run the test suite against the tagged commit',
    '  - deploy     — deploy the tagged build to production',
    '',
    'Output a JSON array. Each item has exactly two fields:',
    '  - id (string, one of the step names above)',
    '  - depends_on (array of strings — step ids this step waits on)',
    '',
    'Constraints:',
    '  - run_tests must wait on cut_tag.',
    '  - deploy must wait on run_tests.',
    '  - The graph MUST be acyclic.',
    '',
    'Output ONLY the JSON array — no prose, no markdown fences, no commentary.',
  ].join('\n'),
  passCheck: (finalText, _toolCalls): PassResult => {
    const arr = extractJsonArray(finalText);
    if (arr === null) return { pass: false, reason: 'final output did not contain a parseable JSON array' };
    const steps = parseDagSteps(arr);
    if (steps === null) return { pass: false, reason: 'steps did not match {id: string, depends_on: string[]} shape' };
    if (!isValidDag(steps)) return { pass: false, reason: 'graph is not a valid DAG (cycle or unresolved dependency)' };
    // Each canonical step must be present with at least the required upstream.
    for (const expected of DAG_STEPS_EXPECTED) {
      const step = steps.find((s) => s.id === expected.id);
      if (!step) return { pass: false, reason: `missing required step: ${expected.id}` };
      for (const required of expected.mustDependOn) {
        if (!step.depends_on.includes(required)) {
          return { pass: false, reason: `step '${expected.id}' must depend on '${required}'` };
        }
      }
    }
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 60_000,
};

// ── MEMORY_EXTRACTION: pull memorable facts from a chat snippet ──────
// Probes haiku-tier capability — lynox `memory.ts` extraction runs on
// Haiku. PassCheck parses JSON array, asserts >=3/4 known anchor facts
// are present via string-contains match. Tier bar: Haiku 4.5.

const MEMORY_CHAT = [
  'user: Hi, my name is Jordan and I run a small bakery in Vienna.',
  'assistant: Nice to meet you, Jordan. What do you bake?',
  'user: Mostly sourdough and rye. I prefer email over phone for any updates.',
  'assistant: Got it — I will reach out by email then.',
  'user: Thanks. Also, my partner Sam handles the wholesale orders.',
].join('\n');

interface MemoryFact {
  readonly anchor: string;
  /** Lowercase substrings — at least one must be present in some fact field. */
  readonly mustContain: readonly string[];
}

const MEMORY_EXPECTED: readonly MemoryFact[] = [
  { anchor: 'name is Jordan', mustContain: ['jordan'] },
  { anchor: 'runs a bakery in Vienna', mustContain: ['bakery', 'vienna'] },
  { anchor: 'prefers email over phone', mustContain: ['email'] },
  { anchor: 'partner Sam handles wholesale', mustContain: ['sam'] },
];

/**
 * Flatten any nested fact value to a single lowercase string for
 * substring matching. Tolerates string facts, {key, value} objects, and
 * arrays of strings — the model formats memory facts differently from
 * run to run.
 */
function flattenFact(item: unknown): string {
  if (typeof item === 'string') return item.toLowerCase();
  if (typeof item !== 'object' || item === null) return '';
  const parts: string[] = [];
  for (const value of Object.values(item as Record<string, unknown>)) {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) {
      // Stringify non-string array items (e.g. `mentions: [{name: 'Sam'}]`)
      // instead of dropping them — models legitimately emit structured
      // sub-objects and the substring anchor match should still see the
      // canonical names inside.
      for (const v of value) {
        if (typeof v === 'string') parts.push(v);
        else if (v !== null && v !== undefined) parts.push(JSON.stringify(v));
      }
    } else if (typeof value === 'object' && value !== null) {
      parts.push(JSON.stringify(value));
    } else if (value !== null && value !== undefined) {
      parts.push(String(value));
    }
  }
  return parts.join(' ').toLowerCase();
}

export const MEMORY_EXTRACTION_CHAT: SetBenchScenario = {
  id: 'memory-extraction.chat',
  axis: 'memory-extraction',
  description: 'Extract memorable facts (name, role, preferences, relationships) from a 5-line chat snippet into a JSON array. Tests the haiku-tier memory-extractor replacement claim.',
  prompt: [
    'Below is a short chat between a user and an assistant. Extract the',
    'memorable facts about the user — things worth remembering for future',
    'conversations. Things like name, location, role, preferences, and',
    'people they mention.',
    '',
    'Output a JSON array of fact objects. The exact shape is up to you,',
    'but each fact should be self-contained and human-readable when rendered.',
    '',
    'Output ONLY the JSON array — no prose, no markdown fences, no commentary.',
    '',
    'Chat:',
    MEMORY_CHAT,
  ].join('\n'),
  passCheck: (finalText, _toolCalls): PassResult => {
    const arr = extractJsonArray(finalText);
    if (arr === null) return { pass: false, reason: 'final output did not contain a parseable JSON array' };
    const flattened = arr.map(flattenFact);
    let matched = 0;
    const missing: string[] = [];
    for (const fact of MEMORY_EXPECTED) {
      const hit = flattened.some((joined) => fact.mustContain.every((needle) => joined.includes(needle)));
      if (hit) matched++;
      else missing.push(fact.anchor);
    }
    // Bar: >=3/4. Memory extraction has natural variance — the model
    // might collapse "partner Sam" and "wholesale orders" into one fact
    // or skip the email preference if it deems it transient. 3/4 is the
    // tier-bar minimum that Haiku reliably clears.
    if (matched < 3) return { pass: false, reason: `only ${matched}/4 facts matched; missing: ${missing.join('; ')}` };
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 60_000,
};

// ── LONG_CONTEXT: 5-bullet summary of a synthetic spec document ──────
// Probes sonnet-tier capability — lynox `summarize` tool runs on Sonnet
// for long-context jobs (200K-window models). PassCheck asserts exactly
// 5 bullets and >=4/5 contain a known anchor phrase from the corpus.
// Tier bar: Sonnet 4.6.

const LONG_DOC = [
  '# Helios Edge Gateway 2.0 — Product Specification',
  '',
  '## 1. Overview',
  'The Helios Edge Gateway 2.0 is an on-premises networking appliance designed for industrial sites that operate without reliable cloud connectivity. The unit ships in a half-rack form factor weighing 4.2 kilograms and draws a maximum of 65 watts under peak load. Mounting hardware supports both DIN-rail and standard 19-inch rack configurations. The gateway is built around a custom ARM-based system-on-chip with eight cores running at 1.8 gigahertz and 16 gigabytes of error-correcting memory. Storage is provided by dual 512-gigabyte NVMe drives configured in a mirrored layout for fault tolerance. Each unit ships with a five-year warranty and a software support contract for the same period.',
  '',
  '## 2. Connectivity',
  'On the network side, the gateway exposes four 2.5-gigabit Ethernet ports and two SFP+ cages capable of 10-gigabit fiber links. Wireless connectivity includes Wi-Fi 6E with tri-band radios and an optional cellular module supporting LTE Cat 18 and 5G sub-6. The cellular module is field-replaceable without removing the main chassis. For legacy industrial protocols, the unit includes two RS-485 serial ports, one CAN bus interface, and a Modbus TCP gateway service that runs on the embedded operating system. A dedicated out-of-band management port provides isolated administrative access on a separate physical interface from production traffic.',
  '',
  '## 3. Security model',
  'The security model is built around a hardware root of trust. Each unit ships with a unique device certificate burned into the security chip at the factory, and the bootloader verifies every stage of the boot chain against this root. Firmware updates require both a vendor signature and a customer counter-signature, eliminating the risk of a single compromised signing key enabling unauthorized rollouts. All persistent storage is encrypted at rest using AES-256-XTS with keys derived from the device certificate. Network traffic between the gateway and the central management plane uses mutual TLS with rotating client certificates issued by the customer’s internal certificate authority. There is no remote management backdoor and no factory-default password.',
  '',
  '## 4. Software',
  'The gateway runs a hardened Linux distribution based on a minimal Yocto image. The container runtime is a stripped-down version of Podman configured to run only signed OCI images. The management plane uses a declarative configuration model: operators push a configuration bundle that the gateway either fully applies or atomically rolls back. There is no imperative configuration mode. The unit exposes a Prometheus-compatible metrics endpoint covering CPU, memory, disk, network throughput, and per-container resource use. Logs are streamed to a syslog endpoint over TLS with a configurable spool size for offline operation.',
  '',
  '## 5. Operating environment',
  'The Helios Edge Gateway 2.0 is rated for operation between minus 20 degrees Celsius and plus 65 degrees Celsius without active cooling. The chassis is rated IP54 against dust and splashing water and has passed shock and vibration testing per the IEC 60068 standard. The unit is certified for industrial use in the European Union under the CE mark and in North America under FCC Part 15B. RoHS 3 compliance is documented for all materials. The expected mean-time-between-failures is 350,000 hours under typical industrial conditions.',
].join('\n');

/**
 * Anchor phrases — each summary bullet should mention something
 * specific to the corpus rather than a generic platitude. We require 4
 * of 5 bullets to hit at least one anchor; a fully generic summary
 * ("the device is rugged and secure") fails the bar.
 */
// Anchor list is compiled to word-boundary regexes — substring `.includes`
// would let short tokens like `arm`, `aes`, `lte`, `5g` falsely satisfy
// generic filler ("alarm", "aesthetic", "alteration", "no 5g coverage").
// The bench is testing whether the model picked up *these specific*
// corpus tokens, not whether English happens to spell them.
const LONG_DOC_ANCHOR_PATTERNS: readonly RegExp[] = [
  /\barm\b/i,                       // SoC reference, not "alarm"
  /\bethernet\b/i,
  /\bsfp\+/i,
  /\bmodbus\b/i,
  /\bcellular\b/i,
  /\blte\b/i,
  /\b5g\b/i,
  /hardware root of trust/i,
  /mutual tls/i,
  /\baes\b/i,
  /\bpodman\b/i,
  /\byocto\b/i,
  /\bprometheus\b/i,
  /\bsyslog\b/i,
  /\bip54\b/i,
  /\bce mark\b/i,
  /\bfcc\b/i,
  /\brohs\b/i,
  /mean-time-between-failures/i,
  /350,000\s*hours/i,
  /65\s*watts/i,
  /din-rail/i,
];

/**
 * Pull bullet lines from a markdown response. Accepts `-`, `*`, `+`
 * markers and numbered `1.` style. Strips the marker and surrounding
 * whitespace. Empty bullets (whitespace-only after the marker) are
 * dropped — a model occasionally emits a trailing blank bullet.
 */
export function extractBullets(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const match = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/);
    if (match) out.push(match[1]!);
  }
  return out;
}

export const LONG_CONTEXT_SPEC_SUMMARY: SetBenchScenario = {
  id: 'long-context.spec-summary',
  axis: 'long-context',
  description: 'Summarize a fixed ~3.5K-token product specification document into exactly 5 bullet points. Tests the sonnet-tier long-context summarizer replacement claim.',
  prompt: [
    'Summarize the product specification document below into EXACTLY 5 bullet',
    'points. Each bullet must capture a distinct aspect of the product (not',
    'a paraphrase of the same point). Aim for one bullet per major section.',
    '',
    'Format requirements:',
    '  - Use a dash ("-") marker for each bullet, one per line.',
    '  - Exactly 5 bullets — no fewer, no more.',
    '  - No preamble, no closing remark, no markdown headings.',
    '',
    'Document:',
    LONG_DOC,
  ].join('\n'),
  passCheck: (finalText, _toolCalls): PassResult => {
    const bullets = extractBullets(finalText);
    if (bullets.length !== 5) return { pass: false, reason: `expected exactly 5 bullets, got ${bullets.length}` };
    let anchored = 0;
    for (const bullet of bullets) {
      if (LONG_DOC_ANCHOR_PATTERNS.some((re) => re.test(bullet))) anchored++;
    }
    if (anchored < 4) {
      return { pass: false, reason: `only ${anchored}/5 bullets contained a corpus-specific anchor phrase` };
    }
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 90_000,
};

// ── CODE_REVIEW: spot 2 planted bugs in a TS diff ──────
// Probes sonnet-tier capability — code review prompts target Sonnet in
// lynox. PassCheck asserts BOTH bug-class keywords (null-deref / SQL
// injection) appear AND BOTH planted line refs (±2 lines tolerance) are
// flagged. Tier bar: Sonnet 4.6.

// Diff is embedded as a single string with stable line numbers. Bug 1
// (null deref) is at line 7; bug 2 (SQL injection) is at line 13. The
// passCheck accepts any line in [5..9] and [11..15] respectively.
const CODE_REVIEW_DIFF = [
  '// File: src/api/user-handler.ts',
  '// Line 1',
  'import { db } from "../db.js";',
  '// Line 3',
  'export async function getUserDisplayName(userId: string | null): Promise<string> {',
  '  // Line 5',
  '  const trimmed = userId.trim();',
  '  const row = await db.queryOne(',
  '    `SELECT name FROM users WHERE id = ${trimmed}`,',
  '  );',
  '  return row?.name ?? "anonymous";',
  '}',
  '// Line 12',
  'export async function searchUsers(query: string): Promise<unknown[]> {',
  '  const sql = "SELECT * FROM users WHERE name LIKE \'%" + query + "%\'";',
  '  return db.queryAll(sql);',
  '}',
].join('\n');

interface CodeBugClaim {
  /** Substrings (any one must match, case-insensitive) describing the bug class. */
  readonly classMatchers: readonly string[];
  /** Acceptable planted-line range; the model should flag a line in this window. */
  readonly lineWindow: readonly number[];
  /** Human-readable label for the failure reason. */
  readonly label: string;
}

const CODE_REVIEW_BUGS: readonly CodeBugClaim[] = [
  {
    label: 'null-deref on userId',
    classMatchers: ['null', 'undefined', 'nullable', 'null-deref', 'null reference', 'nullish'],
    // Bug 1 is at line 7 (`userId.trim()` on a possibly-null arg). Accept
    // 5..9 to absorb the model counting from the function signature.
    lineWindow: [5, 6, 7, 8, 9],
  },
  {
    label: 'SQL injection on query / id',
    classMatchers: ['sql injection', 'sql-injection', 'sqli', 'string concatenation', 'template literal', 'parameterized', 'prepared statement'],
    // Bug 2 (SQL injection) has TWO planted sites: line 9 (template
    // literal in id query) and line 15 (concatenation in searchUsers).
    // Each site gets ±2 tolerance; the union excludes line 12, which is
    // the `// Line 12` structural anchor inside the diff itself — a model
    // echoing prose like "line 12 looks fine" would otherwise hand us a
    // free false-positive. Also dropped the lone word "injection" from
    // classMatchers: "SQL injection" / "sqli" / "sql-injection" already
    // cover real flags without firing on generic prose.
    lineWindow: [7, 8, 9, 10, 11, 13, 14, 15, 16, 17],
  },
];

/**
 * Scan the model's final text for line refs (line N, L7, :13:, etc) and
 * return them as numbers. Strict-ish — we want to match "line 7" but
 * not the literal "5/5" used for grading. Code-fence content is stripped
 * first so a model echoing the diff back (which contains `// Line N`
 * anchors) can't leak structural-anchor numbers into the ref pool.
 */
export function extractLineRefs(text: string): number[] {
  const out: number[] = [];
  // Strip fenced code blocks BEFORE matching so echoed `// Line N`
  // anchors don't pollute the line-ref set. Real model review prose
  // lives outside fences; the planted-bug `lineWindow` test is about
  // what the model *claims*, not what it pasted back.
  const noCode = text.replace(/```[\s\S]*?```/g, ' ');
  const lower = noCode.toLowerCase();
  // Pattern 1: "line 7", "lines 7-9", "line: 7"
  for (const m of lower.matchAll(/line[s]?\s*[:\-]?\s*(\d+)(?:\s*[-,]\s*(\d+))?/g)) {
    out.push(parseInt(m[1]!, 10));
    if (m[2]) out.push(parseInt(m[2], 10));
  }
  // Pattern 2: "L7" / "L13"
  for (const m of lower.matchAll(/\bl(\d+)\b/g)) {
    out.push(parseInt(m[1]!, 10));
  }
  // Pattern 3: ":7:" / ":13:" gitblame-style refs (avoid matching "5/5" grading).
  for (const m of lower.matchAll(/:\s*(\d+)\s*:/g)) {
    out.push(parseInt(m[1]!, 10));
  }
  return out;
}

export const CODE_REVIEW_PLANTED_BUGS: SetBenchScenario = {
  id: 'code-review.planted-bugs',
  axis: 'code-review',
  description: 'Spot both planted bugs (null-deref + SQL injection) in a 16-line TS diff with file:line refs. Tests the sonnet-tier code-review replacement claim.',
  prompt: [
    'Review the TypeScript code below for security and correctness bugs.',
    'For EACH bug you find, output one line in this exact format:',
    '  BUG: <bug class> at line <N> — <one-sentence explanation>',
    '',
    'Use only the bug-class names you see fit (e.g. "null dereference",',
    '"SQL injection"). Use the line numbers from the inline `// Line N`',
    'comments — those are the authoritative line numbers.',
    '',
    'Do not output anything besides the BUG: lines.',
    '',
    'Code:',
    CODE_REVIEW_DIFF,
  ].join('\n'),
  passCheck: (finalText, _toolCalls): PassResult => {
    const lower = finalText.toLowerCase();
    const lines = extractLineRefs(finalText);
    const flagged: string[] = [];
    for (const bug of CODE_REVIEW_BUGS) {
      const classHit = bug.classMatchers.some((m) => lower.includes(m));
      const lineHit = lines.some((n) => bug.lineWindow.includes(n));
      if (classHit && lineHit) flagged.push(bug.label);
    }
    if (flagged.length < 2) {
      const missing = CODE_REVIEW_BUGS.filter((b) => !flagged.includes(b.label)).map((b) => b.label);
      return { pass: false, reason: `only flagged ${flagged.length}/2 planted bugs; missing: ${missing.join(', ')}` };
    }
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 90_000,
};

// ── MULTI_STEP_REASONING: chained-math word problem ──────
// Probes opus / sonnet+thinking tier capability — adaptive thinking
// kicks in for multi-step calculations in lynox. PassCheck asserts
// ANSWER=<integer-cents> matches the known-good value within ±100 cents
// tolerance (the model occasionally rounds compounded interest a
// fraction of a percent off). Tier bar: Opus 4 / Sonnet 4.6 + thinking.

/**
 * Reference compound-interest calculation, computed in cents to keep
 * the test machine-checkable. Scenario: deposit 10000.00 EUR at 6%
 * annual interest compounded annually. After year 1, withdraw 2000.00.
 * Then let the remainder compound for two more years.
 *
 *   Year 1: 10000.00 * 1.06 = 10600.00
 *   After withdrawal: 10600.00 - 2000.00 = 8600.00
 *   Year 2: 8600.00 * 1.06 = 9116.00
 *   Year 3: 9116.00 * 1.06 = 9662.96
 *
 * Final balance: 9662.96 EUR = 966296 cents.
 */
const MULTI_STEP_ANSWER_CENTS = 966_296;
const MULTI_STEP_TOLERANCE_CENTS = 100;

export const MULTI_STEP_REASONING_INTEREST: SetBenchScenario = {
  id: 'multi-step-reasoning.compound-interest',
  axis: 'multi-step-reasoning',
  description: '3-step chained math: compound interest year 1 → mid-period withdrawal → compound years 2 and 3. Tests the opus / sonnet+thinking tier reasoning claim.',
  prompt: [
    'Solve the following problem step by step, then output the final answer.',
    '',
    'A customer deposits 10000.00 EUR into an account that earns 6% annual',
    'interest, compounded annually at the end of each year.',
    '',
    'Year 1: interest is applied to the full balance.',
    'At the START of Year 2 (immediately after the Year 1 interest is credited),',
    'the customer withdraws exactly 2000.00 EUR. The remainder continues to',
    'earn 6% annually for two more full years.',
    '',
    'What is the account balance at the end of Year 3, in EUR?',
    '',
    'Reply with the calculation steps, then on a final line write EXACTLY:',
    '  ANSWER=<value>',
    'where <value> is the balance in EUR cents (no decimal point — multiply',
    'the EUR amount by 100 and round to the nearest cent). For example,',
    '5000.50 EUR would be written ANSWER=500050.',
  ].join('\n'),
  passCheck: (finalText, _toolCalls): PassResult => {
    // Pick the LAST `ANSWER=<n>` occurrence — models sometimes echo the
    // template line ("write ANSWER=<value>") before emitting the real
    // answer. We want the final commitment.
    const matches = [...finalText.matchAll(/ANSWER\s*=\s*(\d+)/gi)];
    if (matches.length === 0) return { pass: false, reason: 'final answer missing ANSWER=<n>' };
    const last = matches[matches.length - 1]!;
    const got = parseInt(last[1]!, 10);
    const delta = Math.abs(got - MULTI_STEP_ANSWER_CENTS);
    if (delta > MULTI_STEP_TOLERANCE_CENTS) {
      return { pass: false, reason: `wrong answer: got ${got} cents, want ${MULTI_STEP_ANSWER_CENTS} (±${MULTI_STEP_TOLERANCE_CENTS})` };
    }
    return { pass: true };
  },
  maxIterations: 3,
  timeoutMs: 120_000,
};

export const SET_BENCH_SCENARIOS: readonly SetBenchScenario[] = [
  TOOL_CHAIN_ZURICH_X2,
  ORCHESTRATION_EMAIL_TRIAGE,
  KG_EXTRACTION_ENTITIES,
  DAG_PLANNING_RELEASE,
  MEMORY_EXTRACTION_CHAT,
  LONG_CONTEXT_SPEC_SUMMARY,
  CODE_REVIEW_PLANTED_BUGS,
  MULTI_STEP_REASONING_INTEREST,
];

/** Frozen Zurich population — exposed for the mocked-tool variant. */
export const ZURICH_POPULATION_PINNED = ZURICH_POPULATION;
