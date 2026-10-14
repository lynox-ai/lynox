#!/usr/bin/env node
/**
 * Every `pnpm.overrides` entry a lockfile records must also be APPLIED to it.
 *
 * WHY THIS EXISTS. `pnpm.overrides` is this repo's dependency-floor mechanism,
 * and the checks around it never look at the resolved versions:
 *
 *   · `--frozen-lockfile` does not re-resolve — it installs exactly what the
 *     lockfile says, and it compares the lockfile's recorded `overrides:` header
 *     with the declared overrides, not with the versions underneath it;
 *   · a plain `pnpm install` keeps an already-locked version as long as that
 *     header matches, so a floor raised by editing the lockfile header (or by a
 *     merge that took one side's header and the other side's packages) stays
 *     unapplied with nothing reporting it.
 *
 * So a lockfile can record a floor and resolve below it, and pass every
 * install. This file is the detector.
 *
 * ── The rules come from the LOCKFILE, and declared must equal recorded ───────
 *
 * The rules are the lockfile's own `overrides:` header — what pnpm says it
 * applied — and package.json `pnpm.overrides` must equal it key for key,
 * because `docs/` has its own lockfile and no CI job installs it with
 * `--frozen-lockfile` before this runs: nothing else checks that its header
 * still matches what docs/package.json declares.
 *
 * Two other places pnpm takes overrides from are REFUSED rather than modelled:
 * `overrides:` in pnpm-workspace.yaml and package.json `resolutions`. How pnpm
 * combines them with `pnpm.overrides` is not what a plain merge would suggest
 * (measured on 10.34.5: with both files declaring, `pnpm config list` showed
 * only the workspace set while a re-resolve still wrote the package.json set
 * into the header). Neither is used here; a guard that guessed their semantics
 * would print advice that cannot fix what it reports. Move them into
 * `pnpm.overrides` instead.
 *
 * ── The rule, and why it is bounded rather than exact ────────────────────────
 *
 * A resolved version is a violation when at least one override COULD govern it
 * and none of those that could accepts it. "Could govern" is deliberately
 * generous, because pnpm's selector grammar has three forms and a flat lockfile
 * cannot say which instance came from where:
 *
 *   `name`         a bare rule — always governs that package
 *   `parent>name`  scoped to one dependency path — MAY govern any instance;
 *                  the lockfile's `packages:` section is flat, so we cannot tell
 *   `name@range`   version-scoped — governs only the versions matching it
 *
 * Flagging a version that a scoped rule legitimately explains would fire on
 * correct input, and a guard that fails correct input gets deleted rather than
 * fixed. The cost of that generosity is REPORTED on every run: a version
 * accepted only by a narrower rule is listed together with the bare rule that
 * would have rejected it. So are overrides naming no package in the tree, values
 * that are not version ranges, and resolutions without a comparable version.
 *
 * A lockfile that yields NO PACKAGES while rules exist is a hard error: an empty
 * file, a renamed section, a CRLF checkout or an unreadable format must not
 * print `clean ✓`. The predicate is "no packages", not "no decisions" — a tree
 * where every rule legitimately decides nothing (`nanoid@3` against a resolved
 * nanoid 5) is common and correct.
 *
 * ── The trees ────────────────────────────────────────────────────────────────
 *
 * The workspace root and `docs/`. Both are real trees that something installs:
 * the root in every CI job, `docs/` in the docs build and deploy.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The trees this repo ships. `dir` holds package.json, the lockfile and (maybe) pnpm-workspace.yaml. */
const DEFAULT_TREES = [
  { label: 'workspace root', dir: '.' },
  { label: 'docs', dir: 'docs' },
];

/**
 * Resolved versions per package name, read from the lockfile's `packages:` block.
 *
 * Read STRUCTURALLY — by section and indentation — rather than by matching
 * package names with a regex over the whole file. `packages:` rather than
 * `snapshots:` on purpose: snapshot keys carry a peer suffix
 * (`'@hono/node-server@1.19.17(hono@4.13.4)'`) and `packages:` keys do not.
 */
export function readResolved(lockText) {
  const out = new Map();
  let section = null;
  // `\r` stripped, and it is not cosmetic: the key pattern anchors the colon to
  // the end of the line, so on a CRLF checkout nothing would match.
  for (const line of lockText.replace(/\r/g, '').split('\n')) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) {
      section = line.slice(0, line.indexOf(':'));
      continue;
    }
    if (section !== 'packages') continue;
    const m = /^ {2}(\S.*):$/.exec(line);
    if (!m) continue;
    let key = m[1];
    if (/^'.*'$/.test(key)) key = key.slice(1, -1);
    const split = splitNameVersion(key);
    // The NAME has to look like one. A pnpm v6 lockfile writes `/vite@7.3.5:`,
    // which splits into `/vite` — a "package" no rule can match, which would
    // keep the unreadable-lockfile branch quiet on a file this reader did not
    // understand.
    if (split === null || !isPackageName(split.name)) continue;
    if (!out.has(split.name)) out.set(split.name, new Set());
    out.get(split.name).add(split.version);
  }
  return out;
}

/** The lockfile's own `overrides:` header — what pnpm recorded as applied. */
export function readRecordedOverrides(lockText) {
  // No `\r` stripping needed here, unlike `readResolved`: the YAML parser reads CRLF itself.
  const doc = parseYaml(lockText);
  const o = doc?.overrides;
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

/**
 * Declared against recorded, key for key. Every difference is reported: a key
 * declared but not recorded, recorded but not declared, or recorded with a
 * different value. Values are compared as strings, which is how pnpm writes them
 * — except a `$name` back-reference, which pnpm replaces with the referenced
 * dependency's specifier before it writes the header. Only its key is compared.
 */
export function compareDeclared(declared, recorded) {
  const diffs = [];
  for (const [k, v] of Object.entries(declared)) {
    if (!Object.hasOwn(recorded, k)) diffs.push({ key: k, declared: String(v), recorded: null });
    else if (!String(v).startsWith('$') && String(recorded[k]) !== String(v)) diffs.push({ key: k, declared: String(v), recorded: String(recorded[k]) });
  }
  for (const [k, v] of Object.entries(recorded)) {
    if (!Object.hasOwn(declared, k)) diffs.push({ key: k, declared: null, recorded: String(v) });
  }
  return diffs;
}

/**
 * `name@version` → its two halves, looking for the LAST `@` rather than the
 * first. `@scope/pkg@1.2.3` has two.
 */
export function splitNameVersion(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (name.length === 0 || version.length === 0) return null;
  return { name, version };
}

const SAT = { includePrerelease: true };

/**
 * npm's `validate-npm-package-name().validForOldPackages`, error conditions
 * only — pnpm calls exactly this before it accepts a selector's alias. npm's
 * warnings (length, capitals, `~'!()*`) do not invalidate an old package name.
 */
const SCOPED_PATTERN = /^(?:@([^/]+?)[/])?([^/]+?)$/;
const NAME_BLACKLIST = new Set(['node_modules', 'favicon.ico']);

export function isPackageName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (/^\./.test(name) || /^_/.test(name)) return false;
  if (name.trim() !== name) return false;
  if (NAME_BLACKLIST.has(name.toLowerCase())) return false;
  if (encodeURIComponent(name) === name) return true;
  const m = SCOPED_PATTERN.exec(name);
  if (m === null) return false;
  const [, scope, pkg] = m;
  return scope !== undefined && encodeURIComponent(scope) === scope && encodeURIComponent(pkg) === pkg;
}

const PNPM_DELIMITER = /[^ |@]>/;

/** One selector into name + version-pref, as pnpm's `parseWantedDependency` does it. */
function parseSelector(selector) {
  const at = selector.indexOf('@', 1);
  if (at !== -1) {
    const name = selector.slice(0, at);
    return isPackageName(name) ? { name, pref: selector.slice(at + 1) } : null;
  }
  return isPackageName(selector) ? { name: selector, pref: undefined } : null;
}

/**
 * Which of pnpm's three selector forms this key is, and what it targets. A key
 * that parses as none of them is `malformed` rather than quietly reinterpreted.
 */
export function classifySelector(key) {
  const d = key.search(PNPM_DELIMITER);
  if (d !== -1) {
    const child = parseSelector(key.slice(d + 2));
    if (child === null) return { kind: 'malformed', name: key };
    // The child's own range is KEPT: dropping it would turn
    // `parent>esbuild@^0.18` into a rule over every esbuild.
    if (child.pref !== undefined && child.pref !== '' && semver.validRange(child.pref, SAT) !== null) {
      return { kind: 'scoped', name: child.name, selectorRange: child.pref };
    }
    return { kind: 'scoped', name: child.name };
  }
  const target = parseSelector(key);
  if (target === null) return { kind: 'malformed', name: key };
  if (target.pref === undefined) return { kind: 'bare', name: target.name };
  if (semver.validRange(target.pref, SAT) === null) return { kind: 'malformed', name: key };
  return { kind: 'versioned', name: target.name, selectorRange: target.pref };
}

/**
 * Override VALUES that are not semver ranges and are legitimate: `npm:` aliases,
 * `link:`/`file:` paths, protocols, git and tarball URLs, `user/repo` shorthands,
 * `$name` back-references, pnpm's removal override `-`, and six named dist-tags.
 * Skipped and COUNTED. Anything else that is not a range is a typo, and a typo'd
 * floor that is silently dropped stopped holding while still appearing in the file.
 */
const NON_RANGE_VALUE =
  /^(?:-$|npm:|link:|file:|workspace:|catalog:|portal:|jsr:|github:|git[+:]|ssh:|https?:|\$|(?:latest|next|beta|alpha|canary|rc)$|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#.*)?$)/;

/** The verdict, as data — pure, so the tests drive this and not a process. */
export function evaluate({ overrides, resolved }) {
  const rules = [];
  const malformed = [];
  const unenforceable = [];
  for (const [key, range] of Object.entries(overrides ?? {})) {
    const cls = classifySelector(key);
    if (cls.kind === 'malformed') {
      malformed.push({ key, range: String(range), why: 'not a package selector' });
      continue;
    }
    if (typeof range !== 'string') {
      malformed.push({ key, range: String(range), why: 'not a string' });
      continue;
    }
    if (NON_RANGE_VALUE.test(range)) {
      unenforceable.push({ key, range });
      continue;
    }
    if (range.trim() === '' || semver.validRange(range, SAT) === null) {
      malformed.push({ key, range, why: 'not a semver range' });
      continue;
    }
    rules.push({ ...cls, key, range });
  }

  const violations = [];
  const rescues = [];
  const unmatchedNames = [];
  let checkedVersions = 0;

  for (const rule of rules) {
    if (!resolved.has(rule.name)) unmatchedNames.push(rule.key);
  }

  for (const [name, versions] of resolved) {
    const forName = rules.filter((r) => r.name === name);
    if (forName.length === 0) continue;
    for (const version of versions) {
      // `link:`/`file:`/git resolutions carry no comparable version. Skipped,
      // and counted — a silent skip is indistinguishable from a check.
      if (semver.valid(version) === null) {
        rescues.push({ name, version, kind: 'not-a-version', bare: [], via: [] });
        continue;
      }
      const applicable = forName.filter(
        (r) => r.selectorRange === undefined || semver.satisfies(version, r.selectorRange, SAT),
      );
      if (applicable.length === 0) continue;
      checkedVersions += 1;
      const accepting = applicable.filter((r) => semver.satisfies(version, r.range, SAT));
      if (accepting.length === 0) {
        violations.push({ name, version, rules: applicable.map((r) => `${r.key}: ${r.range}`) });
        continue;
      }
      // Accepted only because a NARROWER rule explains it — the bare floor would
      // have rejected this version. Reported, never silent.
      const bare = applicable.filter((r) => r.kind === 'bare');
      if (bare.length > 0 && accepting.every((r) => r.kind !== 'bare')) {
        rescues.push({
          name,
          version,
          kind: 'narrower-rule',
          bare: bare.map((r) => `${r.key}: ${r.range}`),
          via: accepting.map((r) => `${r.key}: ${r.range}`),
        });
      }
    }
  }

  const decidedNothing = rules.length > 0 && resolved.size === 0;

  return {
    ok: violations.length === 0 && malformed.length === 0 && !decidedNothing,
    violations,
    malformed,
    unenforceable,
    rescues,
    unmatchedNames,
    checkedVersions,
    decidedNothing,
    ruleCount: rules.length,
  };
}

/**
 * The declared overrides of a tree: package.json `pnpm.overrides`. The two other
 * sources pnpm reads are refused with a reason (see the header), never merged.
 */
export function readDeclared(dir) {
  const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
  const refused = [];
  if (pkg?.resolutions !== undefined) refused.push('package.json declares `resolutions`');
  const ws = resolve(dir, 'pnpm-workspace.yaml');
  if (existsSync(ws) && parseYaml(readFileSync(ws, 'utf8'))?.overrides != null) {
    refused.push('pnpm-workspace.yaml declares `overrides:`');
  }
  return { declared: { ...(pkg?.pnpm?.overrides ?? {}) }, refused };
}

function readTree(tree) {
  const dir = resolve(REPO_ROOT, tree.dir);
  const lockPath = resolve(dir, 'pnpm-lock.yaml');
  for (const p of [resolve(dir, 'package.json'), lockPath]) {
    // An absent file must never read as "nothing to check".
    if (!existsSync(p)) return { error: `${p} does not exist — refusing to report clean on a tree this check could not read` };
  }
  const lockText = readFileSync(lockPath, 'utf8');
  try {
    return { recorded: readRecordedOverrides(lockText), ...readDeclared(dir), resolved: readResolved(lockText) };
  } catch (e) {
    // A file that does not parse is a finding, not a stack trace — and never a pass.
    return { error: `${dir}: could not read the tree (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` };
  }
}

function main() {
  const argv = process.argv.slice(2);
  let trees = DEFAULT_TREES;
  if (argv.length > 0) {
    // Exactly `--dir <path>` or nothing: a misspelled flag must not quietly fall back to the defaults.
    if (argv.length !== 2 || argv[0] !== '--dir') {
      console.error('usage: override-applied-guard.mjs [--dir <directory with package.json and pnpm-lock.yaml>]');
      process.exit(2);
    }
    // Relative to where it is run, like any path on a command line.
    trees = [{ label: argv[1], dir: resolve(process.cwd(), argv[1]) }];
  }

  let failed = false;
  for (const tree of trees) {
    const lock = `${tree.dir === '.' ? '' : `${tree.dir}/`}pnpm-lock.yaml`;
    const read = readTree(tree);
    if (read.error !== undefined) {
      console.error(`::error::override-applied-guard: ${read.error}`);
      failed = true;
      continue;
    }

    for (const why of read.refused) {
      console.error(
        `::error::override-applied-guard [${tree.label}]: ${why}. This guard does not model how pnpm combines that ` +
          'with `pnpm.overrides`, so it refuses rather than guess. Move the entries into `pnpm.overrides` in package.json.',
      );
    }
    const diffs = compareDeclared(read.declared, read.recorded);
    for (const d of diffs) {
      console.error(
        `::error::override-applied-guard [${tree.label}]: \`${d.key}\` is declared as ${d.declared ?? '(nothing)'} ` +
          `but the lockfile records ${d.recorded ?? '(nothing)'}.`,
      );
    }
    if (diffs.length > 0) {
      console.error(`  The lockfile was not regenerated after the overrides changed. Run \`pnpm install\` in ${tree.dir} and commit ${lock}.`);
    }

    const r = evaluate({ overrides: read.recorded, resolved: read.resolved });

    for (const m of r.malformed) {
      console.error(`::error::override-applied-guard [${tree.label}]: \`${m.key}: ${m.range}\` — ${m.why}.`);
    }
    for (const v of r.violations) {
      console.error(
        `::error::override-applied-guard [${tree.label}]: ${v.name}@${v.version} is resolved, but the ` +
          `recorded override says ${v.rules.join(' · ')}.`,
      );
    }
    if (r.violations.length > 0) {
      console.error('');
      console.error('  The override is RECORDED and was never APPLIED. `--frozen-lockfile` cannot see this:');
      console.error('  it installs what the lockfile says rather than re-resolving, and a plain `pnpm install`');
      console.error(`  keeps the locked version while the header matches. Re-resolve the named package in ${tree.dir}`);
      console.error(`  (for example \`pnpm update --depth Infinity <name>\`) and commit ${lock}.`);
      console.error('');
    }
    if (r.decidedNothing) {
      console.error(
        `::error::override-applied-guard [${tree.label}]: ${r.ruleCount} override(s) to enforce and NOT ONE resolved ` +
          'version was decided. The lockfile parsed to nothing usable — an empty file, a renamed `packages:` section, ' +
          'or a format this reader no longer understands. A guard that checks nothing must not report clean.',
      );
    }

    const notes = [];
    if (r.unmatchedNames.length > 0) notes.push(`${r.unmatchedNames.length} override(s) name no package in this tree`);
    if (r.unenforceable.length > 0) notes.push(`${r.unenforceable.length} override(s) are not version ranges`);
    const narrower = r.rescues.filter((s) => s.kind === 'narrower-rule');
    const unversioned = r.rescues.filter((s) => s.kind === 'not-a-version');
    if (narrower.length > 0) notes.push(`${narrower.length} version(s) accepted only by a narrower selector`);
    if (unversioned.length > 0) notes.push(`${unversioned.length} resolution(s) carry no comparable version`);
    const suffix = notes.length > 0 ? ` — ${notes.join('; ')}` : '';
    const ok = r.ok && diffs.length === 0 && read.refused.length === 0;
    if (ok) {
      // The lockfile PATH is in the line, not just the label: a verdict has to
      // name what it read, or a pair re-pointed at the wrong file passes unseen.
      console.log(
        `override-applied-guard [${tree.label} · ${lock}]: clean ✓ ` +
          `(${r.ruleCount} overrides, ${r.checkedVersions} resolved version(s) checked${suffix})`,
      );
    }
    for (const s of narrower) {
      console.log(
        `  note: ${s.name}@${s.version} passes only via ${s.via.join(' · ')}; the bare rule ${s.bare.join(' · ')} would reject it.`,
      );
    }
    for (const u of r.unenforceable) {
      console.log(`  note: \`${u.key}: ${u.range}\` is not a version range — nothing here can compare it.`);
    }

    if (!ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

// The house entrypoint idiom. Said out loud on failure: a silent no-op here
// would exit 0 having checked nothing.
let invoked = null;
try {
  invoked = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
} catch {
  process.stderr.write(`entrypoint self-check: ${import.meta.url} could not resolve process.argv[1]\n`);
}
if (invoked !== null && fileURLToPath(import.meta.url) === invoked) {
  main();
}
