/**
 * Census of the places the engine's own strings name `ask_secret`. A locked turn
 * (a mandate's) stores no key through it, so a text that sends the model there is either kept from
 * that turn, swapped for it, true there as it stands, or answered there by the call itself. Each
 * mention found in `src/` (tests aside) carries one verdict below; a NEW mention without one
 * fails, and so does a verdict whose mention is gone, so none is added or dropped silently.
 *
 * The census is by NAME: it sees the literal `ask_secret` in a string or template part and
 * nothing else. A paraphrase that does not name the tool is not seen here (the runtime check in
 * `locked-turn-request.test.ts` knows some forms), nor a template that interpolates a tool name
 * whose value may be `ask_secret` (the one known, `findAutonomousViolations`, has its own swap
 * test). The key is (file, the nearest enclosing name, the n-th mention under it), not the line.
 */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..');
const ROOT = join(SRC, '..');

type Verdict =
  /** The tool's name as data: a list, an enum, a comparison, a column value. */
  | 'name'
  /** On a path a locked turn does not reach; `why` names what stops it first. */
  | 'owner-only'
  /** Owner text a locked turn reads swapped; the swap has a test. */
  | 'swapped'
  /** The locked text itself, which says the tool stores nothing there. */
  | 'locked-text'
  /** True in a locked turn as it stands: it says the tool does not help, or is not the way. */
  | 'true-locked'
  /** Names the tool as a kind of step (a workflow that asks), sending nobody to collect a key. */
  | 'describes'
  /** Sends the model to the call; in a locked turn the call's answer carries the way (decided 08.11.). */
  | 'answered-by-call';

const V = (verdict: Verdict, why: string): { verdict: Verdict; why: string } => ({ verdict, why });
const SWAP_TEST = 'locked-turn-texts.test.ts';
const CONNECT_TEST = 'api-setup-connect.test.ts (locked turn block)';
const ANSWER = 'ask_secret answers a locked turn with MANDATE_SECRET_REFUSAL (U-185 §1), named for this class on 08.11.';

const VERDICTS: Record<string, { verdict: Verdict; why: string }> = {
  'src/core/agent.ts::INTERNAL_TOOLS::1': V('name', 'set of tool names'),
  'src/core/agent.ts::TOOL_TIMEOUT_EXEMPT::1': V('name', 'set of tool names'),
  'src/core/agent.ts::content::1': V('owner-only', 'a locked turn refuses every secret: reference before this (agent.ts, `_toolLock !== null` in secret resolution)'),
  'src/core/agent.ts::content::2': V('owner-only', 'as content::1'),
  'src/core/api-store.ts::CATALOG_OWNER_STORE_STEP::1': V('swapped', `lockedTurnBriefing, ${SWAP_TEST}`),
  'src/core/engine-db.ts::MIGRATIONS::1': V('name', 'CHECK constraint value'),
  'src/core/knowledge-store.ts::reason::1': V('answered-by-call', ANSWER),
  'src/core/mandate-tool-lock.ts::MANDATE_TOOL_SURFACE::1': V('name', 'set of tool names'),
  'src/core/oauth-presets.ts::presetClientSecretGuidance::1': V('true-locked', '"not through ask_secret"'),
  'src/core/oauth-refresh-failure.ts::revokedGrantMessage::1': V('answered-by-call', ANSWER),
  'src/core/profile-secret-view.ts::withheldText::1': V('true-locked', '"Asking for the value with ask_secret does not change this"; allowed by its words in locked-turn-request.test.ts'),
  'src/core/prompt-store.ts::<module>::1': V('name', 'prompt type value'),
  'src/core/prompt-store.ts::promptType::1': V('name', 'prompt type value'),
  'src/core/prompts.ts::OWNER_COMMUNICATION_SECRETS::1': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_COMMUNICATION_SECRETS::2': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_EXTERNAL_SECRETS::1': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_GUIDE_RULE_6::1': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_GUIDE_RULE_6::2': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_GUIDE_RULE_6::3': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_GUIDE_RULE_6::4': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_GUIDE_RULE_6::5': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_SECRETS_RULE_1::1': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_SECRETS_RULE_3::1': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_SECRETS_RULE_4::1': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::OWNER_SHOPIFY_NEVER_ASK::1': V('swapped', `lockedTurnPrompt, ${SWAP_TEST}`),
  'src/core/prompts.ts::LOCKED_SECRETS_RULE_3::1': V('locked-text', 'rule 3 of a locked turn (U-185 §3)'),
  'src/core/run-history.ts::MIGRATIONS::1': V('name', 'CHECK constraint value'),
  'src/core/run-history.ts::MIGRATIONS::2': V('name', 'CHECK constraint value'),
  'src/core/secret-store.ts::withoutTypedCredentials::1': V('answered-by-call', ANSWER),
  'src/core/task-manager.ts::create::1': V('describes', 'a workflow with ask_secret steps cannot be scheduled'),
  'src/core/worker-loop.ts::executePipeline::1': V('describes', 'a workflow that asks for more than an answer'),
  'src/integrations/search/web-search-tool.ts::API_SETUP_REMINDER_STORE_LINE::1': V('swapped', 'apiSetupReminder, web-search-tool.test.ts (locked turn block)'),
  'src/orchestrator/human-in-the-loop.ts::HUMAN_IN_THE_LOOP_TOOLS::1': V('name', 'set of tool names'),
  'src/orchestrator/human-in-the-loop.ts::message::1': V('name', 'comparison `tool === \'ask_secret\'`'),
  'src/orchestrator/human-in-the-loop.ts::message::2': V('locked-text', `pipeline text of a locked turn (U-185 §4), ${SWAP_TEST}`),
  'src/orchestrator/human-in-the-loop.ts::message::3': V('locked-text', 'as message::2'),
  'src/orchestrator/prompt-budget.ts::PromptBudgetExceededError::1': V('describes', 'stops further question calls'),
  'src/server/http-api.ts::_settleNamedPrompt::1': V('name', 'prompt type value'),
  'src/server/http-api.ts::tool::1': V('name', 'prompt type value'),
  'src/server/http-api.ts::kind::1': V('name', 'prompt type value'),
  'src/server/http-api.ts::_registerRoutes::1': V('name', 'prompt type value'),
  'src/server/http-api.ts::_registerRoutes::2': V('describes', 'a workflow that asks for more than an answer (an HTTP answer)'),
  'src/server/http-api.ts::_registerRoutes::3': V('describes', 'as _registerRoutes::2'),
  'src/tools/builtin/api-setup.ts::bootstrapFromDocs::1': V('swapped', `turnIsLocked, locked-turn-request.test.ts (s3)`),
  'src/tools/builtin/api-setup.ts::bootstrapFromDocs::2': V('swapped', `turnIsLocked, locked-turn-request.test.ts (s3)`),
  'src/tools/builtin/api-setup.ts::detailedGuidance::1': V('swapped', `lockedGuidance, ${SWAP_TEST}`),
  'src/tools/builtin/api-setup.ts::handler::1': V('swapped', 'create, turnIsLocked, locked-turn-request.test.ts (s4)'),
  'src/tools/builtin/api-setup.ts::handler::2': V('swapped', `connect without ORIGIN, ${CONNECT_TEST}`),
  'src/tools/builtin/api-setup.ts::handler::3': V('swapped', `connect without a built-in provider, ${CONNECT_TEST}`),
  'src/tools/builtin/api-setup.ts::unnamedValueStep::1': V('swapped', `connect, a profile that names no vault key and no built-in provider; no caller reaches it locked today, so the step decides itself; its unit test in ${CONNECT_TEST}, the call site untested`),
  'src/tools/builtin/api-setup.ts::askableValueStep::1': V('swapped', `connect, the vault has no value; no caller reaches it locked today, so the step decides itself; its unit test in ${CONNECT_TEST}, the call site untested`),
  'src/tools/builtin/api-setup.ts::ask::1': V('swapped', `fetch_token, the vault has no value, ${CONNECT_TEST}`),
  'src/tools/builtin/api-setup.ts::refreshOnDerivedAdvice::1': V('swapped', `fetch_token, a refresh token on the access name, reached with a mandate's own grant, ${CONNECT_TEST}`),
  'src/tools/builtin/api-setup.ts::API_SETUP_OWNER_STORE_SENTENCE::1': V('swapped', `lockedGuidance, ${SWAP_TEST}`),
  'src/tools/builtin/ask-secret.ts::ASK_SECRET_LOCKED_DESCRIPTION::1': V('locked-text', `description of a locked turn (U-185 §2), ${SWAP_TEST}`),
  'src/tools/builtin/ask-secret.ts::name::1': V('name', 'the tool\'s name'),
  'src/tools/builtin/ask-secret.ts::handler::1': V('owner-only', 'list: a locked turn is answered before this (ask-secret.ts, `turnIsLocked` in list)'),
  'src/tools/builtin/ask-secret.ts::handler::2': V('owner-only', 'collect: a locked turn gets MANDATE_SECRET_REFUSAL before the name checks'),
  'src/tools/builtin/ask-secret.ts::handler::3': V('owner-only', 'as handler::2'),
  'src/tools/builtin/ask-secret.ts::handler::4': V('owner-only', 'as handler::2'),
  'src/tools/builtin/ask-secret.ts::handler::5': V('owner-only', 'as handler::2: a sub-agent asking outside its secret_scope'),
  'src/tools/builtin/ask-secret.ts::handler::6': V('owner-only', 'as handler::2: the profiles could not be listed'),
  'src/tools/builtin/ask-secret.ts::handler::7': V('owner-only', 'as handler::2: an answer of the dialog'),
  'src/tools/builtin/ask-secret.ts::head::1': V('owner-only', 'as handler::2: a token slot of a profile on a built-in provider'),
  'src/tools/builtin/http.ts::realKey::1': V('answered-by-call', ANSWER),
  'src/tools/builtin/http.ts::refusal::1': V('answered-by-call', ANSWER),
  'src/tools/builtin/http.ts::hint::1': V('answered-by-call', ANSWER),
  'src/tools/builtin/http.ts::hint::2': V('answered-by-call', ANSWER),
  'src/tools/builtin/http.ts::modelOwnedAuthHint::1': V('answered-by-call', ANSWER),
  'src/tools/builtin/http.ts::modelOwnedAuthHint::2': V('answered-by-call', ANSWER),
  'src/tools/builtin/http.ts::vault::1': V('answered-by-call', ANSWER),
  'src/tools/builtin/http.ts::vault::2': V('answered-by-call', ANSWER),
  'src/tools/builtin/knowledge.ts::handler::1': V('answered-by-call', ANSWER),
  'src/tools/builtin/pipeline.ts::error::1': V('describes', 'an interactive workflow runs from a chat'),
  'src/tools/builtin/pipeline.ts::executePipelineById::1': V('describes', 'as error::1'),
  'src/tools/builtin/pipeline.ts::executePipelineById::2': V('describes', 'as error::1'),
  'src/tools/builtin/task.ts::unschedulable::1': V('describes', 'a workflow with ask_secret steps cannot be scheduled'),
  'src/tools/builtin/update-workflow.ts::lostSchedule::1': V('describes', 'a workflow that may now ask for more than an answer'),
};

/** The nearest enclosing name of a node: a declaration, a method, a property. */
function ownerOf(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)
      || ts.isPropertyDeclaration(p) || ts.isClassDeclaration(p) || ts.isGetAccessor(p))
      && p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  }
  return '<module>';
}

/** Every mention of the tool's name in one source text's strings, by key. */
function mentions(fileName: string, text: string): string[] {
  if (!text.includes('ask_secret')) return [];
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const seen = new Map<string, number>();
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (let i = node.text.indexOf('ask_secret'); i >= 0; i = node.text.indexOf('ask_secret', i + 1)) {
        const base = `${fileName}::${ownerOf(node)}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        out.push(`${base}::${String(n)}`);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

it('sees every string form it claims to see, keyed by the enclosing name', () => {
  const probe = [
    "const A = 'x ask_secret y ask_secret';",
    'function f() { return `a ${1} ask_secret b`; }',
    'const o = { p: `ask_secret` };',
    '// ask_secret in a comment is not a string',
    "const B = 'collect it';",
  ].join('\n');
  expect(mentions('probe.ts', probe)).toEqual(['probe.ts::A::1', 'probe.ts::A::2', 'probe.ts::f::1', 'probe.ts::p::1']);
});

it('every mention of ask_secret in the engine\'s strings has a verdict, and every verdict a mention', () => {
  const found = sourceFiles(SRC).flatMap((f) => {
    const rel = relative(ROOT, f).split('\\').join('/');
    return mentions(rel, readFileSync(f, 'utf8'));
  });
  const unjudged = found.filter((k) => VERDICTS[k] === undefined);
  expect(unjudged, 'a new text names ask_secret: say what a locked turn reads there (swap it, or give it a verdict here)').toEqual([]);
  const gone = Object.keys(VERDICTS).filter((k) => !found.includes(k));
  expect(gone, 'a judged mention is gone or moved: drop or re-key its verdict').toEqual([]);
  expect(found.length).toBe(Object.keys(VERDICTS).length);
});
