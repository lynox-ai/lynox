/**
 * The 6 evidence scenarios from PRD-AGENT-EFFICIENCY §2.
 *
 * Each scenario reproduces one row of the §2 evidence table on the live
 * lynox engine loop (not a static model bench). Scenarios sharing a
 * `threadKey` run sequentially in one engine thread so a follow-up turn
 * inherits the prior turn's context and cache state — that is the whole
 * point of measuring the engine loop rather than isolated model calls.
 *
 * Prompts are in German where the original chat export was German (the
 * §2 evidence conversation), per `feedback_native_language`.
 *
 * FIDELITY CAVEATS — read before trusting the numbers:
 *  - Scenario `build-api-workflow` cannot be faithfully reproduced. The
 *    original §2 turn hit 11 real, pre-configured API profiles ($0.405 /
 *    460k input tokens). Without those exact profiles on the staging
 *    tenant, this scenario instead exercises the SAME cost path — a
 *    tool-heavy, multi-step planning turn — with a best-effort prompt.
 *    Its absolute numbers will differ from §2; treat it as a relative
 *    baseline for Phases 2-3, not a §2 reproduction.
 *  - Scenario `promote-attempt` deliberately drives the BROKEN
 *    capture_process / promote_process path (the bug PRD Phase 1.4
 *    fixes). The baseline legitimately captures the broken-state cost;
 *    once Phase 1.4 lands, re-baseline this scenario.
 */
import type { Scenario } from './types.js';

const MINUTE = 60_000;

export const SCENARIOS: readonly Scenario[] = [
  // ── Thread A: weather (simple + follow-up) ──
  {
    id: 'weather-simple',
    label: 'Weather — simple',
    evidenceRow: '§2 row 1 — Weather "morgen?" ($0.083 / 37,718 in)',
    threadKey: 'weather',
    prompt: 'Wie wird das Wetter morgen?',
    qualityRubric:
      'A good answer either gives a tomorrow forecast (after asking for / inferring a ' +
      'location) or asks one concise clarifying question for the location. It must NOT ' +
      'recommend Telegram or any removed feature, and must not hallucinate a forecast ' +
      'without a data source.',
    timeoutMs: 4 * MINUTE,
  },
  {
    id: 'weather-hourly',
    label: 'Weather — hourly follow-up',
    evidenceRow: '§2 row 2 — Weather hourly ($0.096 / 40,107 in)',
    // Same thread as weather-simple — this is the cold-cache-gap follow-up.
    threadKey: 'weather',
    prompt: 'Und stündlich?',
    qualityRubric:
      'A good answer continues the SAME location/day context from the previous turn ' +
      'and provides (or offers) an hour-by-hour breakdown. It must not re-ask for the ' +
      'location already established in turn 1.',
    timeoutMs: 4 * MINUTE,
  },

  // ── Thread B: build+run API workflow + cost/limits follow-ups ──
  {
    id: 'build-api-workflow',
    label: 'Build + run API-health-check workflow',
    evidenceRow: '§2 row 3 — Build+run API workflow ($0.405 / 460,386 in)',
    threadKey: 'workflow',
    // FIDELITY CAVEAT: the original hit 11 real API profiles. We cannot
    // reproduce that without those profiles; this prompt exercises the
    // same cost path (a tool-heavy, multi-step turn). The instructions are
    // deliberately BOUNDED — exactly 3 named URLs, one GET each, no
    // workflow persistence — because an open-ended "build me a workflow"
    // prompt let the agent loop into multi-minute deep-planning that blew
    // past the wall cap non-deterministically (Phase-0 measurement, 2026-05-21).
    prompt:
      'Prüfe die Erreichbarkeit dieser drei APIs mit je EINEM GET-Request: ' +
      'https://api.github.com , https://httpbin.org/get und ' +
      'https://jsonplaceholder.typicode.com/todos/1 . Gib mir danach eine ' +
      'kurze Tabelle mit Statuscode und ungefährer Antwortzeit pro API. ' +
      'Baue KEINEN gespeicherten Workflow und stelle KEINE Rückfragen — ' +
      'führe die drei Checks direkt aus und fasse zusammen.',
    qualityRubric:
      'A good answer executes one HTTP GET against each of the three named ' +
      'APIs and reports per-API status code + approximate latency in a short ' +
      'table. Partial coverage still counts as OK for the cost signal; the ' +
      'quality note records how many APIs were reached.',
    fidelityCaveat:
      'Best-effort substitute for the §2 11-real-profile turn — exercises a ' +
      'tool-heavy multi-step cost path but is intentionally bounded (3 fixed ' +
      'GETs, no workflow persistence) so it completes deterministically. ' +
      'Absolute tokens/cost differ from the §2 460k-token workflow turn.',
    timeoutMs: 8 * MINUTE,
  },
  {
    id: 'cost-qa',
    label: 'Cost Q&A follow-up',
    evidenceRow: '§2 row 4 — "why 41 cent?" Q&A ($0.204 / 65,406 in)',
    // Same thread as build-api-workflow — the cost question is about it.
    threadKey: 'workflow',
    prompt: 'Warum hat das gerade so viel gekostet?',
    qualityRubric:
      'A good answer explains the cost drivers of the previous turn honestly. Per ' +
      'PRD §3 the agent has no cost model, so a candid "I cannot precisely attribute ' +
      'the cost" is acceptable; an invented precise breakdown is not.',
    timeoutMs: 4 * MINUTE,
  },
  {
    id: 'limits-qa',
    label: 'Limits Q&A follow-up',
    evidenceRow: '§2 row 5 — "HEAD limits?" Q&A ($0.253 / 65,975 in, cache_read 0)',
    // Same thread — keeps the cold-cache follow-up shape from §2.
    threadKey: 'workflow',
    prompt: 'Welche Limits gelten eigentlich für HEAD-Requests?',
    qualityRubric:
      'A good answer states the engine HTTP-tool rate limits (per CLAUDE.md: 200 ' +
      'req/hr, 2000 req/day, 100 HTTP requests per session) accurately, or honestly ' +
      'says it is unsure rather than inventing numbers.',
    timeoutMs: 4 * MINUTE,
  },

  // ── Thread C: capture + promote (known-broken path) ──
  {
    id: 'promote-attempt',
    label: 'Capture + promote process (broken path)',
    evidenceRow: '§2 row 6 — promote attempt ($0.094 / 333,361 in, Haiku)',
    threadKey: 'promote',
    prompt:
      'Mach zuerst zwei, drei kleine Tool-Schritte: rufe die aktuelle Uhrzeit ab und ' +
      'prüfe per HTTP-Request https://httpbin.org/get. Erfasse danach diesen Ablauf ' +
      'als wiederverwendbaren Prozess (capture_process) und befördere ihn anschließend ' +
      'zu einer Pipeline (promote_process).',
    qualityRubric:
      'EXPECTED-BROKEN: per PRD Phase 1.4 the capture/promote path currently fails ' +
      '(capture_process hits the zero-tool-calls branch). A faithful baseline RECORDS ' +
      'that failure. "OK" here means the turn completed and a usage signal was read — ' +
      'not that promotion succeeded. The quality note records whether a Process / ' +
      'Pipeline was actually produced (expected: no).',
    fidelityCaveat:
      'Drives the known-broken capture_process/promote_process path (PRD Phase 1.4). ' +
      'The baseline intentionally captures the broken-state cost; re-baseline after ' +
      'Phase 1.4 lands.',
    timeoutMs: 6 * MINUTE,
  },
];

/** Scenarios grouped by `threadKey`, preserving array order within each group. */
export function groupByThread(scenarios: readonly Scenario[]): Map<string, Scenario[]> {
  const groups = new Map<string, Scenario[]>();
  for (const s of scenarios) {
    const existing = groups.get(s.threadKey);
    if (existing) existing.push(s);
    else groups.set(s.threadKey, [s]);
  }
  return groups;
}
