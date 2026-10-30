/**
 * Every tool name the engine owns, so that no plugin tool can take one.
 *
 * The registry keys tools by name and lets a later registration replace an earlier one, and
 * the engine decides by name what a call may do: the danger check, the injection scan, the
 * timeout and secret exemptions, the mandate lock. A plugin tool under a built-in's name would
 * replace that tool where it is registered before the plugins, and inherit those decisions
 * where the built-in is switched off. Both are refused at the plugin boundary
 * (`PluginManager.admitTools`), against this set rather than against what is registered: a built-in
 * behind a switch that is off on this instance keeps its name too.
 */
import { MANDATE_TOOL_SURFACE, MANDATE_WITHHELD_TOOLS } from './mandate-tool-lock.js';

/**
 * Names the engine's decisions use although no built-in tool defines them, each with the
 * place that uses it.
 */
export const RESERVED_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  web_search: 'the provider\'s own search tool, which the agent adds to its tool list',
  tool_search_tool_regex: 'the provider\'s tool search, which the agent adds for deferred tools',
  google_gmail: 'an outbound tool in the output guard',
  ask_human: 'a question tool of a workflow step',
});

/**
 * The engine's own tools (the mandate lock's classification, which a booted registry is held
 * to: every engine tool is either on the surface or withheld) and the reserved names.
 */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...MANDATE_TOOL_SURFACE,
  ...Object.keys(MANDATE_WITHHELD_TOOLS),
  ...Object.keys(RESERVED_TOOL_NAMES),
]);
