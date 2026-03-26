import { RESET, BOLD, DIM, RED, GREEN, MAGENTA, BLUE, GRAY, YELLOW, stripAnsi, TBL } from './ansi.js';
export { RESET, BOLD, DIM, RED, GREEN, MAGENTA, BLUE, GRAY, YELLOW };
import { sleep } from '../core/utils.js';
import { TOOL_DISPLAY_NAMES } from '../types/index.js';

// Bot icon with brand gradient (8 lines tall)
const ASCII_LYNOX = [
  '       █            █',
  '    ▄██████████████████▄',
  '  ▄██████████████████████▄',
  ' ▄████████████████████████▄',
  ' ██████████████████████████',
  ' ██████  ●  ████  ●  ██████',
  ' ██████████████████████████',
  ' ▀████████████████████████▀',
];
const ASCII_MAX_COLS = Math.max(...ASCII_LYNOX.map(r => r.length));
const INFO_COL = ASCII_MAX_COLS + 2;

// Brand Purple: close to rgb(101,37,239) — #6525EF
const BRAND_PALETTE = [93, 93, 99, 99, 135, 135, 99, 99, 93, 93];
const BRAND_ROW_COLORS: number[][] = Array.from({ length: ASCII_LYNOX.length }, (_, r) => {
  const shift = r;
  return BRAND_PALETTE.map((_, i) => BRAND_PALETTE[(i + shift) % BRAND_PALETTE.length]!);
});

export function renderGradientArt(): string {
  let out = '';
  for (let r = 0; r < ASCII_LYNOX.length; r++) {
    const row = ASCII_LYNOX[r]!;
    const palette = BRAND_ROW_COLORS[r]!;
    for (let col = 0; col < row.length; col++) {
      const ch = row[col]!;
      if (ch === ' ') {
        out += ch;
      } else {
        const pIdx = Math.floor((col / ASCII_MAX_COLS) * palette.length);
        const c = palette[pIdx] ?? palette[palette.length - 1]!;
        out += `\x1b[38;5;${c}m${ch}\x1b[0m`;
      }
    }
    out += '\n';
  }
  return out;
}

function buildSideInfo(
  model: string, thinking: string, effort: string, memory: string,
  mcpCount: number, toolCount: number, versionStr?: string | undefined,
): Record<number, string> {
  const version = `${DIM}v${versionStr ?? '0.0.0'}${RESET}`;
  return {
    3: `\x1b[1m\x1b[38;5;99mlynox\x1b[0m ${version}`,
    5: `${DIM}model:${RESET} ${BLUE}${model}${RESET}`,
    6: `${DIM}thinking:${RESET} ${thinking}  ${DIM}accuracy:${RESET} ${effort}`,
    7: `${DIM}knowledge:${RESET} ${memory}  ${DIM}tools:${RESET} ${toolCount}`,
  };
}

function renderArtWithInfo(sideInfo: Record<number, string>): string {
  const artLines = renderGradientArt().trimEnd().split('\n');
  let out = '';
  for (let i = 0; i < artLines.length; i++) {
    const line = artLines[i]!;
    const info = sideInfo[i];
    if (info !== undefined) {
      const visible = stripAnsi(line).length;
      const pad = Math.max(1, INFO_COL - visible);
      out += line + ' '.repeat(pad) + info + '\n';
    } else {
      out += line + '\n';
    }
  }
  return out;
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
  const sideInfo = buildSideInfo(model, thinking, effort, memory, mcpCount, toolCount, versionStr);
  return '\n' + renderArtWithInfo(sideInfo) + '\n';
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
  if (!output.isTTY) {
    output.write(renderBanner(model, thinking, effort, memory, mcpCount, toolCount, versionStr));
    return;
  }

  const rowCount = ASCII_LYNOX.length;
  const sideInfo = buildSideInfo(model, thinking, effort, memory, mcpCount, toolCount, versionStr);

  // Per-character color: brand gradient for position (r, col)
  const gradientC = (r: number, col: number): number => {
    const palette = BRAND_ROW_COLORS[r]!;
    const pIdx = Math.floor((col / ASCII_MAX_COLS) * palette.length);
    return palette[pIdx] ?? palette[palette.length - 1]!;
  };

  // Render a row with per-character color function
  const renderRow = (r: number, getColor: (r: number, col: number) => number): string => {
    const row = ASCII_LYNOX[r]!;
    let line = '';
    for (let col = 0; col < row.length; col++) {
      const ch = row[col]!;
      if (ch === ' ') { line += ch; continue; }
      line += `\x1b[38;5;${getColor(r, col)}m${ch}\x1b[0m`;
    }
    return line;
  };

  // Draw a full frame with per-character color control
  const draw = (colorFn: (r: number, col: number) => number, infoVisible?: Set<number>): void => {
    output.write(`\x1b[${rowCount}A`);
    for (let r = 0; r < rowCount; r++) {
      const line = renderRow(r, colorFn);
      const info = infoVisible !== undefined && infoVisible.has(r) ? sideInfo[r] : undefined;
      if (info !== undefined) {
        const visible = stripAnsi(line).length;
        const pad = Math.max(1, INFO_COL - visible);
        output.write(`\x1b[2K${line}${' '.repeat(pad)}${info}\n`);
      } else {
        output.write(`\x1b[2K${line}\n`);
      }
    }
  };

  // Reserve space
  output.write('\n');
  for (let r = 0; r < rowCount; r++) output.write('\n');

  // Phase 1: Fade from deep purple — body materializes (~250ms)
  const purpleSteps = [53, 54, 55, 92];
  for (const shade of purpleSteps) {
    draw(() => shade);
    await sleep(50);
  }
  draw(gradientC);
  await sleep(50);

  // Phase 2: Iris line sweep left→right on eye area rows 4-6 (~250ms)
  const sweepW = 4;
  for (let pos = -sweepW; pos <= ASCII_MAX_COLS + sweepW; pos += 3) {
    draw((r, col) => {
      if (r < 4 || r > 6) return gradientC(r, col);
      // Eye area: white sweep head, gradient behind
      if (col >= pos - sweepW && col <= pos) return 231;
      return gradientC(r, col);
    });
    await sleep(18);
  }
  draw(gradientC);

  // Phase 3: Double iris flash — bot "wakes up" (~280ms)
  await sleep(40);
  draw((r, col) => (r >= 4 && r <= 6) ? 231 : gradientC(r, col));
  await sleep(90);
  draw(gradientC);
  await sleep(50);
  draw((r, col) => (r >= 4 && r <= 6) ? 231 : gradientC(r, col));
  await sleep(70);
  draw(gradientC);

  // Phase 4: Info reveal with stagger (~240ms)
  await sleep(40);
  const infoRowIds = [3, 5, 6, 7];
  const visibleInfo = new Set<number>();
  for (const id of infoRowIds) {
    visibleInfo.add(id);
    draw(gradientC, visibleInfo);
    await sleep(60);
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
