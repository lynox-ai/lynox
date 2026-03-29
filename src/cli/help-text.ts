/**
 * Help text, command lists, and alias maps.
 * Slimmed after PWA launch — removed commands moved to PWA.
 */

import type { ModelTier } from '../types/index.js';
import { BOLD, DIM, BLUE, RESET } from './ui.js';

export const VALID_NAMESPACES = new Set(['knowledge', 'methods', 'status', 'learnings']);

export const COMMANDS = [
  '/clear', '/reset', '/compact',
  '/save', '/load', '/export', '/history',
  '/model', '/accuracy', '/cost', '/context',
  '/config', '/status',
  '/mode', '/roles',
  '/git', '/pr', '/diff',
  '/tools', '/mcp',
  '/help', '/exit', '/quit',
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
  ${BLUE}/clear${RESET}              Reset conversation
  ${BLUE}/model${RESET} [name]       Switch model (opus/sonnet/haiku)
  ${BLUE}/accuracy${RESET} [level]   Thinking depth
  ${BLUE}/cost${RESET}               Session token usage and cost
  ${BLUE}/mode${RESET}               Show current status
  ${BLUE}/help${RESET} all           Show all commands

${BOLD}Workflows${RESET}
  ${BLUE}/git${RESET} [cmd]          Git info (status/diff/log/branch)
  ${BLUE}/pr${RESET}                 Generate PR description
  ${BLUE}/roles${RESET}             Show available roles
`;

export const HELP_TEXT_FULL = `${BOLD}Session${RESET}
  ${BLUE}/clear${RESET}              Reset conversation
  ${BLUE}/compact${RESET} [focus]    Summarize conversation to free context
  ${BLUE}/save${RESET}               Save current session
  ${BLUE}/load${RESET} [name]        Restore session
  ${BLUE}/export${RESET} [file]      Export last response to file
  ${BLUE}/history${RESET} [search]   Command history

${BOLD}Model${RESET}
  ${BLUE}/model${RESET} [name]       Switch model (opus/sonnet/haiku)
  ${BLUE}/accuracy${RESET} [level]   Thinking depth
  ${BLUE}/cost${RESET}               Session token usage and cost
  ${BLUE}/context${RESET}            Context window usage

${BOLD}Project${RESET}
  ${BLUE}/git${RESET} [cmd]          Git info (status/diff/log/branch)
  ${BLUE}/pr${RESET}                 Generate PR description
  ${BLUE}/diff${RESET}               Show diff
  ${BLUE}/config${RESET}             Settings
  ${BLUE}/status${RESET}             Version, model, mode, tools

${BOLD}Tools${RESET}
  ${BLUE}/tools${RESET}              List available tools
  ${BLUE}/mcp${RESET} <name> <url>   Register MCP server

${BOLD}Roles${RESET}
  ${BLUE}/mode${RESET}               Show current session status
  ${BLUE}/roles${RESET}             Show available roles

${BOLD}System${RESET}
  ${BLUE}/help${RESET}               Show this help
  ${BLUE}/exit${RESET}               Exit

${DIM}More features available in the PWA at app.lynox.ai${RESET}
`;
