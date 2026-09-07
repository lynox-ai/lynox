#!/usr/bin/env node
/**
 * fence-guard — no hand-built fences.
 *
 * ## What a fence is, and why the rule is not about template literals
 *
 * A FENCE is any code that produces a string in which a COINED element is
 * opened and closed with non-literal content between them, and that string is
 * read by the model. `<memory_blocks>…${payload}…</memory_blocks>` is one.
 *
 * The rule is drawn over that EFFECT, not over a syntax form, and the reason is
 * measured rather than assumed. On 2026-09-07 the repo held 14 such elements:
 * 13 built as one template literal and **one** — `<api_bootstrap_hints>` in
 * `core/api-store.ts` — assembled with `lines.push('<api_bootstrap_hints>')` …
 * `lines.push(\`- ${name}\`)` … `lines.push('</api_bootstrap_hints>')` …
 * `join('\n')`. A rule that said "a template literal that opens and closes"
 * would have missed it SILENTLY: no error, no warning, one member fewer. So the
 * guard recognises three construction forms, and the third exists because a
 * later measurement found it too:
 *
 *   A. one template literal          `<x>${p}</x>`
 *   B. assembled in pieces           push('<x>') … push(p) … push('</x>') … join()
 *   C. interpolated tag NAME         `<${TOKEN}>${p}</${TOKEN}>`
 *
 * Form C was not hypothetical either: `renderProvenanceFact` builds `<fact …>`
 * that way. Constant extraction (`const OPEN = '<x>'`) was measured and does
 * **not exist today** — it would land in form B if it appeared, because the tag
 * still sits in a string literal somewhere in the function.
 *
 * ## Why the answer is a mechanism and not a count
 *
 * The obvious predicate — "which frames are model-facing?" — needs DATAFLOW, and
 * that was built and measured before this guard existed: a real call graph (708
 * files, 3344 functions, 5219 edges) with anchors derived from the code (15
 * provider callers, 51 tool handlers found by type, 4 context setters). Both
 * directions failed, mirror-image: forward misses value-producing functions,
 * upward loses `<asked>`. Root cause: calls through interfaces do not resolve,
 * and this codebase is interface-heavy. A denylist over foreign dataflow stays
 * open however good it gets.
 *
 * This guard asks the closable question instead — *is any fence hand-built?* —
 * and drives the set to EMPTY. It needs no count to be correct.
 *
 * ## ⛔ What "clean" means here, stated so nobody reads the stronger claim into it
 *
 * Clean means: no frame is hand-built, so no payload can close ITS OWN frame. It
 * does NOT mean a payload cannot fake OTHER engine framing — an opening
 * `<task_overview>` inside another frame's payload passes through, and the rest
 * reads to the model as the engine's. That is a real residue, measured (18 of 19
 * call sites rely on renderFence alone) and registered as
 * DEF-renderfence-does-not-stop-foreign-framing — not a gap this guard closes.
 *
 * ## Exceptions
 *
 * Every exception is fail-open, so each one names why ITS payload cannot close
 * the frame — never a path, never a filetype. HTML is excluded by a stable
 * vocabulary (element names) rather than by directory, because a directory is a
 * place and the vocabulary is a property of the thing.
 *
 * **The guard also fails when an exception matches nothing.** A dead exception is
 * a hole nobody sees: it keeps standing after the code it excused has moved or
 * gone, and the next frame that lands on that file+token inherits an excuse
 * written for something else. Most guards check that their rule still bites and
 * never that their own exceptions still mean anything.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');

/** HTML element names. The discriminator is this VOCABULARY — a property of the
 *  element — and not the directory the file sits in. A coined fence is
 *  snake_case by convention; an HTML tag never is. */
const HTML = new Set(['html', 'head', 'body', 'div', 'p', 'span', 'a', 'ul', 'ol', 'li', 'table',
  'thead', 'tbody', 'tr', 'td', 'th', 'pre', 'code', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'style', 'script', 'title', 'img', 'form', 'input', 'button', 'label', 'em', 'strong', 'b', 'i',
  'small', 'section', 'header', 'footer', 'nav', 'main', 'meta', 'link', 'option', 'select',
  'textarea', 'iframe', 'svg', 'path', 'g', 'defs', 'use', 'figure', 'figcaption']);
/**
 * Coined means: NOT an HTML element. Nothing more.
 *
 * A first version also demanded an underscore, and that was a SPELLING proxy —
 * it silently dropped `<asked>`, `<answer>`, `<context>`, `<scope>`, every
 * single-word coined frame. The positive control caught it because it was drawn
 * from a complete measurement rather than from the cases in view: `<asked>` was
 * known to be a member and the guard did not list it.
 */
const isCoined = (t) => !HTML.has(t);

/**
 * Each entry says why THIS payload cannot close THIS frame. Not a pattern, not a
 * path — a reason that a reader can check against the code.
 */
const EXCEPTIONS = [
  {
    file: 'core/data-boundary.ts', token: 'fact',
    why: 'renderProvenanceFact runs its body through escapeXml, which replaces `<` '
      + 'with `&lt;` — the payload cannot contain a `<` at all, so no close tag can '
      + 'survive. That is strictly stronger than neutralising the tag: the character '
      + 'the tag needs is gone. Measured: escapeXml("</fact>") === "&lt;/fact&gt;".',
  },
  {
    file: 'core/data-boundary.ts', token: 'untrusted_data',
    why: 'This IS the boundary. wrapUntrustedData neutralises the payload itself via '
      + 'closeTagPattern before interpolating it; routing it through renderFence would '
      + 'be circular. Its own tests cover eleven encodings of the close tag plus five '
      + 'negative controls.',
  },
  {
    file: 'core/wire-capture.ts', token: 'secrets',
    why: 'redactWireUserMessage REPLACES a matched catalog; the text between the tags '
      + 'is a count this function computes from the match ("1 secret available …"). '
      + 'Nothing from the input reaches it, so there is no payload to neutralise — and '
      + 'routing it through renderFence changed the redaction output shape that its own '
      + 'tests and downstream wire consumers read.',
  },
];

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) files.push(p);
  }
})(SRC);

/** A module-level `const X = '…'` in the same file, so `renderFence(TOKEN, …)`
 *  resolves. Deliberately only literals: if the token is computed at runtime the
 *  guard says so rather than guessing. */
function resolveConst(src, name) {
  const m = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*['"\`]([^'"\`]+)['"\`]`).exec(src);
  return m ? m[1] : null;
}

const found = [];
const unresolved = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true);
  const rel = relative(SRC, f);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

  // Per enclosing function: which coined tokens are opened, which closed, and is
  // there non-literal content? Walking per FUNCTION rather than per literal is
  // what makes forms A and B the same rule instead of two.
  const scopes = new Map();
  const scopeHasInterp = new Set();
  const scopeOf = (n) => {
    let p = n;
    while (p && !(ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)
      || ts.isArrowFunction(p) || ts.isFunctionExpression(p))) p = p.parent;
    return p ?? sf;
  };
  const note = (scope, token, kind, node) => {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const m = scopes.get(scope);
    if (!m.has(token)) m.set(token, { open: 0, close: 0, interp: false, line: lineOf(node), viaRender: false });
    m.get(token)[kind]++;
    if (m.get(token).line > lineOf(node)) m.get(token).line = lineOf(node);
  };

  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      const txt = n.getText();
      const scope = scopeOf(n);
      for (const m of txt.matchAll(/<([a-z][a-z0-9_]*)[\s>]/g)) if (isCoined(m[1])) note(scope, m[1], 'open', n);
      for (const m of txt.matchAll(/<\/([a-z][a-z0-9_]*)>/g)) if (isCoined(m[1])) note(scope, m[1], 'close', n);
      // ⚠ Interpolation is judged BETWEEN the tags when both sit in one literal —
      // not scope-wide. A first version flagged the scope, so any function
      // containing any `${}` marked every tag in it as a fence: `session.ts`
      // quotes `<fact kind="…">fact text</fact>` as an EXAMPLE in a prompt, and
      // that was reported as a hand-built frame. A quoted syntax example is not a
      // frame; nothing flows into it.
      for (const m of txt.matchAll(/<([a-z][a-z0-9_]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
        if (!isCoined(m[1])) continue;
        const e = scopes.get(scope)?.get(m[1]);
        if (e) e.pairInLiteral = (e.pairInLiteral ?? false) || true;
        if (e && m[2].includes('${')) e.interpBetween = true;
      }
      // Form C: the tag NAME is interpolated. The token is then the identifier's
      // name, lowercased — enough to report the site; the reason it is a fence
      // does not depend on knowing the runtime value.
      // Form C, but not when the template is building a REGEX: `<${tag}\\b[^>]*>`
      // is a pattern, not a frame. Measured — `worker-loop.ts:100` and three
      // provider presets are exactly that, and a first version reported them.
      const looksLikeRegex = /\\\\[bsSdDwW]|\[\^|\\\\\//.test(txt);
      if (ts.isTemplateExpression(n) && !looksLikeRegex) {
        for (const m of txt.matchAll(/<\/?\$\{\s*([A-Za-z_][\w.]*)/g)) {
          const id = m[1].split('.').pop();
          if (/^[A-Z0-9_]+$/.test(id) || /TAG$/i.test(id)) {
            const tok = id.toLowerCase().replace(/_?tag$/, '').replace(/^provenance_?/, '');
            note(scope, tok || id.toLowerCase(), m[0].startsWith('</') ? 'close' : 'open', n);
          }
        }
      }
      // ⚠ NOT propagated here. A first version set `interp` on the tokens already
      // noted in this scope at visit time, which made it ORDER-DEPENDENT: a frame
      // whose tags are pushed AFTER the interpolated lines never got the flag and
      // vanished from the inventory entirely. That is the piecewise form — the one
      // this guard exists for — so the failure was silent and exactly on target.
      // Collected per scope and applied once, after the walk.
      if (txt.includes('${')) scopeHasInterp.add(scope);
    }
    if (ts.isCallExpression(n) && /(^|\.)renderFence$/.test(n.expression.getText())) {
      // ⚠ PER TOKEN, never scope-wide. A first version marked every token in the
      // enclosing function compliant as soon as ONE renderFence call appeared —
      // so a function with one migrated frame and one hand-built frame passed
      // both. Same class as the scope-wide interpolation bug, and just as silent.
      const scope = scopeOf(n);
      const arg = n.arguments[0];
      let token = null;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) token = arg.text;
      else if (arg && ts.isIdentifier(arg)) token = resolveConst(src, arg.text);
      if (token) {
        note(scope, token, 'open', n);
        note(scope, token, 'close', n);
        const e = scopes.get(scope).get(token);
        e.viaRender = true; e.pairInLiteral = false; e.interp = true;
      } else {
        unresolved.push({ file: rel, line: lineOf(n), arg: arg?.getText() ?? '?' });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  for (const [scope, tokens] of scopes) {
    const anyInterp = scopeHasInterp.has(scope);
    for (const [token, v] of tokens) {
      // Ein Paar in EINEM Literal zaehlt nur mit Interpolation ZWISCHEN den Tags.
      // Stueckweise gebaute Rahmen (Form B) haben kein solches Zwischenstueck, dort
      // bleibt das scope-weite Signal — die Kante ist hier benannt statt versteckt.
      const isFence = v.pairInLiteral ? v.interpBetween : (v.interp || anyInterp);
      if (!v.open || !v.close || !isFence) continue;
      found.push({ file: rel, token, line: v.line, viaRender: v.viaRender });
    }
  }
}

const excused = (h) => EXCEPTIONS.find((e) => e.file === h.file && e.token === h.token);
const offenders = found.filter((h) => !h.viaRender && !excused(h));
const exempt = found.filter((h) => !h.viaRender && excused(h));
const compliant = found.filter((h) => h.viaRender);

if (process.argv.includes('--inventory')) {
  console.log(`fence-guard inventory: ${found.length} fences`);
  for (const h of found.sort((a, b) => a.file.localeCompare(b.file)))
    console.log(`  ${h.viaRender ? 'renderFence' : excused(h) ? 'exempt     ' : 'HAND-BUILT '}  <${h.token}>`.padEnd(46) + `${h.file}:${h.line}`);
  process.exit(0);
}

console.log(`fence-guard: ${found.length} fence(s) — ${compliant.length} via renderFence, ${exempt.length} exempt, ${offenders.length} hand-built`);
for (const e of EXCEPTIONS) {
  const live = found.some((h) => h.file === e.file && h.token === e.token);
  if (!live) {
    console.error(`\n❌ exception for <${e.token}> in ${e.file} matches nothing — a stale exception is a hole nobody sees.`);
    process.exit(1);
  }
}
if (unresolved.length) {
  console.error('\n❌ renderFence called with a token this guard cannot resolve — it cannot');
  console.error('   attribute the call to a frame, so it must not assume compliance:');
  for (const u of unresolved) console.error(`   ${u.file}:${u.line}  renderFence(${u.arg}, …)`);
  process.exit(1);
}
if (offenders.length === 0) {
  console.log('clean ✓  (positive control: the guard sees the exempt frames too, listed above by --inventory)');
  process.exit(0);
}
console.error('\n❌ hand-built fence(s). Route the payload through renderFence(token, payload):');
for (const h of offenders.sort((a, b) => a.file.localeCompare(b.file)))
  console.error(`   <${h.token}>`.padEnd(40) + `${h.file}:${h.line}`);
console.error('\n   A fence promises the model that its contents are data. If the payload can '
  + 'close it, the promise is void for everything after — and the escape leaves no trace.');
process.exit(1);
