import type { ToolEntry } from '../types/index.js';
import type { ToolContext } from './tool-context.js';
import { STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK, SUBAGENT_NO_WEB_PROMPT_BLOCK } from './prompts.js';
import { noticeLanguage } from './notice-language.js';
import { defuseUnopenedLinks } from './unopened-links.js';

/** Tools that reach the web: through `network_policy` (`network-guard.ts`), or, for `bash`
 *  outside sidecar mode, past it. */
const WEB_REACHING_TOOLS = new Set(['web_research', 'http_request', 'api_setup', 'google_docs', 'google_drive', 'google_sheets', 'google_calendar', 'bash']);

/**
 * Whether an agent with `tools` under `ctx` can reach no web page at all, for the reason the
 * network settings give: under `deny-all` every surface the policy governs is blocked (and the
 * provider's own search is withheld, `providerSearchAdmitted`), so only `bash`, which outside
 * sidecar mode runs past the policy, leaves a way out; under `allow-list` the allowed hosts stay
 * reachable, so only an agent with no web-reaching tool at all is cut off. Under any other
 * policy, or an unread one, the agent is not told about settings it may not be under.
 */
export function subAgentLacksWebSearch(tools: readonly ToolEntry[], ctx: ToolContext | undefined): boolean {
  const names = tools.map((t) => t.definition.name);
  switch (ctx?.networkPolicy) {
    case 'deny-all': return !names.includes('bash');
    case 'allow-list': return !names.some((n) => WEB_REACHING_TOOLS.has(n));
    default: return false;
  }
}

/**
 * The system prompt of an agent the engine starts for a task (a spawned child, a workflow step,
 * named or inline): `prompt` as given, and, when the network settings keep that agent off the
 * web (`subAgentLacksWebSearch`), the sentence that tells it so and not to pass on an address it
 * never opened (`SUBAGENT_NO_WEB_PROMPT_BLOCK`). A workflow step (`step: true`) gets one more
 * sentence for structured output (`STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK`). `ownCodeTools` marks tools
 * from an agent definition (`convertAgentTools`). One place, so the paths cannot drift apart.
 */
export function withNoWebSentence(prompt: string, tools: readonly ToolEntry[], ctx: ToolContext | undefined, opts: { step?: boolean; ownCodeTools?: boolean } = {}): string {
  if (!keptOffWeb(tools, ctx, opts)) return prompt;
  return opts.step === true
    ? `${prompt}\n\n${SUBAGENT_NO_WEB_PROMPT_BLOCK} ${STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK}`
    : `${prompt}\n\n${SUBAGENT_NO_WEB_PROMPT_BLOCK}`;
}

/**
 * Whether the engine treats an agent with `tools` under `ctx` as kept off the web: told so by
 * `withNoWebSentence`, and its output passed through `withoutUnopenedLinks`. One predicate for
 * both, so an agent is never told one thing and treated as the other.
 */
function keptOffWeb(tools: readonly ToolEntry[], ctx: ToolContext | undefined, opts: { ownCodeTools?: boolean }): boolean {
  // Tools an agent definition brings run its own code, which `network_policy` does not reach:
  // any of them may open pages, whatever its name, so such an agent is not told it cannot.
  if (opts.ownCodeTools === true && tools.length > 0) return false;
  return subAgentLacksWebSearch(tools, ctx);
}

/**
 * The output of an agent the engine started for a task (a spawned child, a workflow step), as it
 * is handed on and stored: when that agent was kept off the web (`keptOffWeb`, the same test
 * `withNoWebSentence` applies), every link to an address it was not given (`given`: its task and
 * context) becomes plain text with a note, in the instance's language (`noticeLanguage`), see
 * `defuseUnopenedLinks`. Otherwise `output` as it is.
 */
export function withoutUnopenedLinks(output: string, tools: readonly ToolEntry[], ctx: ToolContext | undefined, given: string, language: string | undefined, opts: { ownCodeTools?: boolean } = {}): string {
  if (!keptOffWeb(tools, ctx, opts)) return output;
  return defuseUnopenedLinks(output, given, noticeLanguage(language));
}
