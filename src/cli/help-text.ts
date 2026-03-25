/**
 * Help text, command lists, and alias maps extracted from index.ts.
 */

import type { ModelTier } from '../types/index.js';
import { BOLD, DIM, BLUE, RESET } from './ui.js';

export const VALID_NAMESPACES = new Set(['knowledge', 'methods', 'project-state', 'learnings']);

export const COMMANDS = [
  '/reset', '/clear', '/compact', '/memory', '/knowledge', '/tools', '/mcp', '/accuracy', '/cost',
  '/batch', '/batch-status', '/save', '/load', '/history',
  '/runs', '/stats',
  '/git', '/pr', '/export', '/alias',
  '/model', '/mode', '/roles', '/plugin',
  '/pipeline', '/workflow', '/approvals', '/google', '/secret',
  '/status', '/config', '/context', '/hooks',
  '/task', '/schedule', '/quickstart', '/help', '/exit', '/quit',
];

export const COMMAND_ALIASES: Record<string, string> = {};

export function completer(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const hits = COMMANDS.filter(c => c.startsWith(line));
  return [hits.length ? hits : COMMANDS, line];
}

export const MODEL_ALIASES: Record<string, ModelTier> = {
  'opus': 'opus', 'apex': 'opus',
  'sonnet': 'sonnet', 'fast': 'sonnet',
  'haiku': 'haiku', 'micro': 'haiku',
};

export const HELP_TEXT_BASICS = `${BOLD}Basics${RESET}
  ${BLUE}/clear${RESET}              Reset conversation (keep knowledge)
  ${BLUE}/model${RESET} [name]       Switch model (thorough/balanced/fast)
  ${BLUE}/accuracy${RESET} [level]   Thinking depth (quick/balanced/thorough/exhaustive)
  ${BLUE}/cost${RESET}               Session token usage and cost
  ${BLUE}/knowledge${RESET} [sub]    Show or manage knowledge (prune)
  ${BLUE}/task${RESET} [sub]          Tasks (list/add/done/start/show/edit/delete)
  ${BLUE}/schedule${RESET} [sub]      Scheduled & watch tasks (list/details/cancel/test)
  ${BLUE}/mode${RESET}               Show current status
  ${BLUE}/quickstart${RESET}          Guided first steps
  ${BLUE}/help${RESET} all           Show all commands

${BOLD}Workflows${RESET}
  ${BLUE}/workflow${RESET} [sub]     Multi-step workflows (list/plan/run/show/retry)
  ${BLUE}/roles${RESET}             Show available roles for delegation
  ${BLUE}/git${RESET} [cmd]          Git info (status/diff/log/branch)
  ${BLUE}/pr${RESET}                 Generate PR description
`;

export const HELP_TEXT_FULL = `${BOLD}Basics${RESET}
  ${BLUE}/clear${RESET}              Reset conversation (keep knowledge)
  ${BLUE}/compact${RESET} [focus]    Summarize conversation to free context
  ${BLUE}/save${RESET}               Save current session
  ${BLUE}/load${RESET} [name]        Restore session (latest if no name)
  ${BLUE}/export${RESET} [file <path>] Export last response to file

${BOLD}Model${RESET}
  ${BLUE}/model${RESET} [name]       Switch model (thorough/balanced/fast)
  ${BLUE}/accuracy${RESET} [level]   Thinking depth (quick/balanced/thorough/exhaustive)
  ${BLUE}/cost${RESET}               Session token usage and cost
  ${BLUE}/context${RESET}            Context window usage

${BOLD}Project${RESET}
  ${BLUE}/git${RESET} [cmd]          Git info (status/diff/log/branch)
  ${BLUE}/pr${RESET}                 Generate PR description
  ${BLUE}/status${RESET}             Version, model, mode, tools, knowledge
  ${BLUE}/config${RESET}             Settings

${BOLD}Tools${RESET}
  ${BLUE}/tools${RESET}              List available tools
  ${BLUE}/mcp${RESET} <name> <url>   Register MCP server
  ${BLUE}/approvals${RESET} [sub]   Auto-approval history (list/show/export)
  ${BLUE}/hooks${RESET}              Show registered hooks
  ${BLUE}/plugin${RESET} [sub]       Plugins (add/remove/list)

${BOLD}Knowledge${RESET}
  ${BLUE}/knowledge${RESET} [sub]    Show or manage knowledge (prune)

${BOLD}Modes${RESET}
  ${BLUE}/mode${RESET}               Show current status
  ${BLUE}/roles${RESET}             Show available roles for delegation

${BOLD}Workflows${RESET}
  ${BLUE}/workflow${RESET} [sub]     Multi-step workflows (list/plan/run/show/retry)
  ${BLUE}/batch${RESET} [sub]        Bulk API processing (submit/list/retry)

${BOLD}Tasks${RESET}
  ${BLUE}/task${RESET} [sub]          Tasks (list/add/done/start/show/edit/delete)
  ${BLUE}/schedule${RESET} [sub]      Manage scheduled & watch tasks (list/details/cancel/test)

${BOLD}History${RESET}
  ${BLUE}/runs${RESET} [sub]         Run history (list/search/<id>/tree/delete/purge/vacuum)
  ${BLUE}/stats${RESET} [sub]        Usage statistics (tools/cost/prompts/workflows)
  ${BLUE}/history${RESET} [search]   Command history

${BOLD}Identity${RESET}
  ${BLUE}/alias${RESET} [sub]        Command aliases (list/create/delete)
  ${BLUE}/secret${RESET} [sub]       Secret management (list/set/delete/status)
  ${BLUE}/google${RESET} [sub]       Google Workspace (auth/status/disconnect)

${BOLD}System${RESET}
  ${BLUE}/quickstart${RESET}          Guided first steps
  ${BLUE}/help${RESET}               Show this help (${DIM}/help all${RESET} for everything)
  ${BLUE}/exit${RESET}               Exit
`;
