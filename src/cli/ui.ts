import { RESET, BOLD, DIM, RED, GREEN, MAGENTA, BLUE, GRAY, YELLOW, stripAnsi, TBL } from './ansi.js';
export { RESET, BOLD, DIM, RED, GREEN, MAGENTA, BLUE, GRAY, YELLOW };
import { sleep } from '../core/utils.js';
import { TOOL_DISPLAY_NAMES } from '../types/index.js';

// Brand Purple: close to rgb(101,37,239) — #6525EF
const BRAND = 99;
const brandColor = (text: string) => `\x1b[38;5;${BRAND}m${text}\x1b[0m`;

/** Styled brand name — used by setup-wizard and banner */
export function renderGradientArt(): string {
  return `  ${brandColor(BOLD + 'lynox' + RESET)}\n`;
}

function buildBannerLines(
  model: string, thinking: string, effort: string, memory: string,
  _mcpCount: number, toolCount: number, versionStr?: string | undefined,
): string[] {
  const version = `${DIM}v${versionStr ?? '0.0.0'}${RESET}`;
  return [
    `  ${BOLD}${brandColor('lynox')}${RESET} ${version}`,
    '',
    `  ${DIM}model:${RESET}     ${BLUE}${model}${RESET}`,
    `  ${DIM}thinking:${RESET}  ${thinking}  ${DIM}accuracy:${RESET} ${effort}`,
    `  ${DIM}knowledge:${RESET} ${memory}  ${DIM}tools:${RESET}    ${toolCount}`,
  ];
}

export function renderBanner(
  model: string,
  thinking: string,
  effort: string,
  memory: string,
  mcpCount: number,
  toolCount: number,
  versionStr?: string | undefined,
): string {
  const lines = buildBannerLines(model, thinking, effort, memory, mcpCount, toolCount, versionStr);
  return '\n' + lines.join('\n') + '\n\n';
}

export function renderToolCall(name: string, input: unknown): string {
  const displayName = TOOL_DISPLAY_NAMES[name] ?? name;
  let detail = '';
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if ('command' in obj) detail = String(obj['command']);
    else if ('question' in obj) detail = String(obj['question']);
    else if ('path' in obj) detail = String(obj['path']);
    else if ('query' in obj) detail = String(obj['query']);
    else {
      const keys = Object.keys(obj);
      if (keys.length > 0 && keys[0]) detail = `${keys[0]}: ${String(obj[keys[0]!])}`;
    }
  }
  if (detail.length > 80) detail = detail.slice(0, 77) + '...';
  const sep = detail ? ` ${GRAY}───${RESET} ${DIM}${detail}${RESET}` : '';
  return `\n  ${MAGENTA}⚡${RESET} ${BOLD}${displayName}${RESET}${sep}\n`;
}

export function renderToolResult(name: string): string {
  const displayName = TOOL_DISPLAY_NAMES[name] ?? name;
  return `  ${GREEN}✓${RESET} ${DIM}${displayName}${RESET}\n`;
}

export function renderSpawn(agents: string[], estimatedCostUSD?: number | undefined): string {
  const costHint = estimatedCostUSD !== undefined && estimatedCostUSD > 0
    ? ` ${DIM}(est. max ~$${estimatedCostUSD.toFixed(2)}, budget $${(agents.length * 5).toFixed(0)}/role)${RESET}`
    : '';
  return `\n  ${BLUE}→${RESET} ${BOLD}Delegating to:${RESET} ${agents.join(', ')}${costHint}\n`;
}

export function renderError(message: string): string {
  return `  ${RED}✗${RESET} ${RED}${message}${RESET}\n`;
}

export function renderWarning(message: string): string {
  return `  ${YELLOW}⚠${RESET} ${DIM}${message}${RESET}\n`;
}

export function renderThinking(text: string, isStart: boolean): string {
  const prefix = isStart ? `\n  ${GRAY}${DIM}👾 Thinking...${RESET}\n` : '';
  return `${prefix}  ${GRAY}${DIM}${text}${RESET}`;
}

export function renderPermission(description: string): string {
  return `\n${MAGENTA}${BOLD}${description}${RESET}\n`;
}

export { wordWrap } from './ansi.js';

export async function animateBanner(
  output: NodeJS.WriteStream,
  model: string,
  thinking: string,
  effort: string,
  memory: string,
  mcpCount: number,
  toolCount: number,
  versionStr?: string | undefined,
): Promise<void> {
  const lines = buildBannerLines(model, thinking, effort, memory, mcpCount, toolCount, versionStr);

  if (!output.isTTY) {
    output.write(renderBanner(model, thinking, effort, memory, mcpCount, toolCount, versionStr));
    return;
  }

  // Staggered line reveal
  output.write('\n');
  for (const line of lines) {
    output.write(line + '\n');
    if (line.length > 0) await sleep(60);
  }
  output.write('\n');
}


export function renderTable(headers: string[], rows: string[][]): string {
  const colCount = headers.length;
  const widths: number[] = headers.map(h => stripAnsi(h).length);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? '';
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    }
  }

  const hBorder = (l: string, m: string, r: string) =>
    l + widths.map(w => TBL.h.repeat((w ?? 0) + 2)).join(m) + r + '\n';

  const dataRow = (cells: string[], bold = false) => {
    const parts = cells.map((c, i) => {
      const w = widths[i] ?? 0;
      const pad = Math.max(0, w - stripAnsi(c).length);
      const content = bold ? `${BOLD}${c}${RESET}` : c;
      return ` ${content}${' '.repeat(pad)} `;
    });
    return `${GRAY}${TBL.v}${RESET}${parts.join(`${GRAY}${TBL.v}${RESET}`)}${GRAY}${TBL.v}${RESET}\n`;
  };

  let out = `${GRAY}${hBorder(TBL.tl, TBL.tm, TBL.tr)}${RESET}`;
  out += dataRow(headers, true);
  out += `${GRAY}${hBorder(TBL.lm, TBL.cr, TBL.rm)}${RESET}`;
  for (const row of rows) {
    const padded = Array.from({ length: colCount }, (_, i) => row[i] ?? '');
    out += dataRow(padded);
  }
  out += `${GRAY}${hBorder(TBL.bl, TBL.bm, TBL.br)}${RESET}`;
  return out;
}
