#!/usr/bin/env node
/**
 * Decide whether an osv-scanner report blocks the build.
 *
 * WHY THIS EXISTS, and it is not a refactor of the jq one-liner it replaces.
 * That one-liner classified a finding by `.database_specific.severity` alone and
 * treated everything else as "moderate/low — not blocking". Measured 2026-09-02
 * end to end, with osv-scanner 2.5.1 against a lockfile pinning
 * `@ledgerhq/connect-kit@1.1.7` (the December 2023 supply-chain compromise):
 *
 *     total=1 high_or_critical=0
 *     ::warning::1 moderate/low vulnerability(ies) reported (not blocking)
 *
 * The finding is `MAL-2023-8697`. Its `database_specific` holds
 * `malicious-packages-origins` and no `severity` key, its `severity` array is
 * `null`, and the scanner's own `groups[].max_severity` is `""`. Nothing in it
 * can be classified, and unclassifiable meant green. One entry was measured,
 * not the feed — but a `MAL-` record describes a malicious package rather than
 * a scored weakness, so having no CVSS band is what the record IS, and the
 * class this scan is most valuable for is the class it could not act on. Not a
 * crash anyone would notice: the output looks complete and says "not blocking".
 *
 * The inversion is the point. An unresolvable severity now BLOCKS. That is the
 * fail-closed direction, and the measurement that makes it cheap is that core's
 * own tree resolves cleanly: 13 findings on 2026-09-02, all 13 carrying
 * `database_specific.severity` (11 MODERATE, 2 LOW), zero unresolvable. The
 * guard costs nothing today and refuses the case it exists for.
 *
 * The other two rules are defensive rather than observed, and are labelled so:
 *
 *  - `results` must be an ARRAY. Go marshals a nil slice to `null`, and
 *    `[.results[]?...] | length` reads `null` as zero findings. osv-scanner
 *    2.5.1 was not seen to emit it — a scan with nothing to report exits 128 and
 *    writes no file at all — so this refuses an envelope drift, not a bug in
 *    today's scanner.
 *  - The scanner's EXIT CODE must be handed in and must be 0 or 1. Measured on
 *    2.5.1: an unreadable lockfile exits 127, a lockfile yielding zero packages
 *    exits 128, and NEITHER writes the report. Today that makes the old
 *    `|| true` survivable by accident — the missing file breaks jq and the step
 *    fails. The accident is the thing being removed: a scan that did not
 *    complete must not be distinguishable from a clean one only by whether a
 *    later command happened to trip.
 *
 * Usage:
 *   node scripts/osv-report-gate.mjs --report <path> --rc <scanner exit code>
 *
 * Exits 0 when nothing blocks, 1 otherwise.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Bands that block. core's policy is high+critical hard-fail, the rest warn. */
const BLOCKING_BANDS = new Set(['HIGH', 'CRITICAL']);
const KNOWN_BANDS = new Set(['LOW', 'MODERATE', 'MEDIUM', 'HIGH', 'CRITICAL']);

/**
 * CVSS v3 base-score bands. Reached whenever a NAME is absent or unrecognised —
 * from a numeric `severity[].score` and from `groups[].max_severity` alike. The
 * boundaries are the published ones; `0.0` is NONE and is not a finding anyone
 * files, so it resolves LOW rather than inventing a band. A value that is not a
 * number at all returns `null`, which the caller reads as "does not say".
 */
export function bandForScore(score) {
  const n = typeof score === 'number' ? score : Number.parseFloat(String(score ?? ''));
  if (!Number.isFinite(n)) return null;
  if (n >= 9.0) return 'CRITICAL';
  if (n >= 7.0) return 'HIGH';
  if (n >= 4.0) return 'MODERATE';
  return 'LOW';
}

/**
 * The severity of one vulnerability, or `null` when the report does not say.
 *
 * `null` is a verdict, not a gap to paper over — it is what MAL-2023-8697
 * returns, and the caller blocks on it.
 *
 * Three sources, and the order was corrected by looking at real output rather
 * than at the schema. `severity[].score` is NOT a number: measured 2026-09-02,
 * every entry in core's own report carries a CVSS VECTOR string
 * (`CVSS:3.1/AV:N/...`), which has no base score inside it to read. A fallback
 * that only parsed that field would have been dead code with a green test
 * beside it. The scanner does publish the computed number, one level up, as
 * `groups[].max_severity` ("4.3", "6.5", and `""` when it does not know) — so
 * the caller passes it in. It is a per-GROUP maximum, so using it for a single
 * vulnerability can over-state severity; that direction blocks more, not less.
 */
export function resolveSeverity(vuln, groupMaxSeverity) {
  const named = vuln?.database_specific?.severity;
  if (typeof named === 'string' && KNOWN_BANDS.has(named.toUpperCase())) {
    const b = named.toUpperCase();
    return b === 'MEDIUM' ? 'MODERATE' : b;
  }
  const entries = Array.isArray(vuln?.severity) ? vuln.severity : [];
  for (const e of entries) {
    const band = bandForScore(e?.score);
    if (band !== null) return band;
  }
  return bandForScore(groupMaxSeverity);
}

/**
 * A list where the report should hold one. Anything else is recorded and read
 * as empty, rather than thrown: a stack trace also exits non-zero, but it says
 * nothing about which envelope drifted.
 */
function asArray(value, errors, what) {
  if (Array.isArray(value)) return value;
  // `null` is NOT waved through as "absent". It reads as zero findings while
  // the consumer that only sees counts — the daily watch — reports all-clear,
  // which is the same swallow one level down from `results: null`. An absent
  // key is the only silence this accepts.
  if (value !== undefined) {
    errors.push(`${what} is ${JSON.stringify(value)} where a list belongs — the report shape drifted`);
  }
  return [];
}

/**
 * Evaluate a parsed report plus the exit code the scanner returned.
 *
 * Collects every reason it can still compute rather than the first, so one CI
 * run tells the author the whole story. The one early exit is a `results` that
 * is not a list: nothing below it can be counted, so the exit-code cross-check
 * that follows would be comparing against a fiction.
 */
export function evaluate({ doc, rc }) {
  const errors = [];
  const blocking = [];
  const below = [];

  if (!Number.isInteger(rc)) {
    errors.push(`the scanner exit code was not handed in (got ${JSON.stringify(rc)})`);
  } else if (rc !== 0 && rc !== 1) {
    errors.push(
      `osv-scanner exited ${rc} — 127 is an unreadable lockfile and 128 is a lockfile that ` +
        `yielded no packages; neither is a completed scan, and neither may read as clean`,
    );
  }

  if (!Array.isArray(doc?.results)) {
    errors.push(
      `the report has no \`results\` array (got ${JSON.stringify(doc?.results ?? null)}) — ` +
        `an envelope this gate cannot read is not an empty one`,
    );
    return { ok: false, errors, blocking, below };
  }

  // Every level is array-checked, not null-checked, and the reason is one level
  // down: `(g?.ids ?? []).includes(id)` on a STRING is a SUBSTRING match. A
  // group with `ids: "zzAzz"` claimed the finding `A` and lent it its own
  // `max_severity`, which turned an otherwise UNRESOLVED — blocking — finding
  // into a non-blocking LOW. That is the one shape measured here that flips
  // this gate from fail-closed to passing, so `?? []` is not enough anywhere.
  for (const result of doc.results) {
    const source = result?.source?.path ?? '(unknown lockfile)';
    for (const pkg of asArray(result?.packages, errors, `${source} packages`)) {
      const name = `${pkg?.package?.name ?? '?'}@${pkg?.package?.version ?? '?'}`;
      const groups = asArray(pkg?.groups, errors, `${name} groups`);
      for (const vuln of asArray(pkg?.vulnerabilities, errors, `${name} vulnerabilities`)) {
        const group = groups.find((g) => Array.isArray(g?.ids) && g.ids.includes(vuln?.id));
        const band = resolveSeverity(vuln, group?.max_severity);
        const entry = { id: vuln?.id ?? '(no id)', package: name, source, severity: band };
        if (band === null) {
          blocking.push({ ...entry, severity: 'UNRESOLVED' });
        } else if (BLOCKING_BANDS.has(band)) {
          blocking.push(entry);
        } else {
          below.push(entry);
        }
      }
    }
  }

  const total = blocking.length + below.length;
  if (Number.isInteger(rc)) {
    if (rc === 1 && total === 0) {
      errors.push('osv-scanner exited 1 but the report lists no findings — the two disagree');
    }
    if (rc === 0 && total > 0) {
      errors.push(`osv-scanner exited 0 but the report lists ${total} finding(s) — the two disagree`);
    }
  }

  return { ok: errors.length === 0 && blocking.length === 0, errors, blocking, below };
}

/**
 * Both spellings, `--flag value` and `--flag=value`.
 *
 * Not generosity: the first version accepted only the separated form, the
 * workflow that consumes the JSON verdict passed `--format=json`, and the flag
 * was silently ignored — the human report went to a file another step then
 * tried to read as JSON. An option a caller writes and nothing reads is the
 * same failure as writing nothing, so unknown options are refused too.
 */
function parseArgs(argv) {
  const out = { unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const value = eq === -1 ? argv[i + 1] : token.slice(eq + 1);
    if (key === 'report') out.report = value;
    else if (key === 'rc') out.rc = Number.parseInt(value ?? '', 10);
    else if (key === 'format') out.format = value ?? '';
    else out.unknown.push(token);
  }
  return out;
}

export function main(argv) {
  const { report, rc, format, unknown } = parseArgs(argv);
  if (unknown.length > 0) {
    console.error(`osv-report-gate: unknown option(s): ${unknown.join(', ')}`);
    return 1;
  }
  if (!report) {
    console.error('osv-report-gate: --report <path> is required');
    return 1;
  }
  // `--format` as the last token leaves `value` undefined, which would read as
  // "no format asked for" and quietly print prose to a caller expecting JSON.
  if (format !== undefined && format !== 'json') {
    console.error(`osv-report-gate: --format takes "json", not ${JSON.stringify(format)}`);
    return 1;
  }

  let doc;
  try {
    doc = JSON.parse(readFileSync(report, 'utf8'));
  } catch (err) {
    // A report that cannot be read is the loudest failure this gate has, and it
    // is the one the old `|| true` reached by accident. It is now the rule.
    console.error(`::error::osv-report-gate: cannot read ${report}: ${String(err)}`);
    return 1;
  }

  const { ok, errors, blocking, below } = evaluate({ doc, rc: Number.isNaN(rc) ? undefined : rc });

  // The daily watch needs the same classification as the merge gate but files
  // an issue instead of failing, so it reads counts rather than an exit code.
  // One classifier, two consumers — the alternative is a second copy of the
  // severity rules that drifts the moment either is edited.
  if (format === 'json') {
    console.log(JSON.stringify({ ok, blocking, below, errors }));
    return ok ? 0 : 1;
  }

  for (const e of errors) console.error(`::error::osv-report-gate: ${e}`);
  for (const b of blocking) {
    const label = b.severity === 'UNRESOLVED' ? 'UNRESOLVED SEVERITY' : b.severity;
    console.error(`::error::${b.source}: ${b.package} ${b.id} — ${label}`);
  }
  for (const b of below) console.log(`  below the floor: ${b.package} ${b.id} (${b.severity})`);
  // An annotation, as the step it replaces emitted: a line in a 3000-line log
  // that nobody scrolls to is not a report.
  if (below.length > 0) {
    console.log(`::warning::${below.length} finding(s) below the floor (not blocking)`);
  }

  console.log(
    `osv-report-gate: ${blocking.length + below.length} finding(s), ${blocking.length} blocking`,
  );
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
