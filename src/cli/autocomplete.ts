import { DIM, RESET, BOLD, GRAY, GREEN, CYAN } from './ansi.js';

export interface CommandDef {
  name: string;
  description: string;
  category: string;
}

const MAX_VISIBLE = 8;

/**
 * Slash command autocomplete — takes over stdin when '/' is typed.
 * Renders a bordered input area with a scrollable command list below.
 *
 * ────────────────────────────────────────
 *  ❯ /mo
 * ────────────────────────────────────────
 *  /model      Switch model (opus/sonnet/haiku)
 *  /mode       Set operational mode
 *  ▼
 *  (1/2)
 */
export class SlashAutocomplete {
  private commands: CommandDef[];

  constructor(commands: CommandDef[]) {
    this.commands = commands;
  }

  run(
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    initial: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let input = initial;
      let selected = 0;
      let scrollOffset = 0;
      let matches = this.filter(input);
      let totalLines = 0;
      const cols = stdout.columns ?? 80;

      const topBorder = `${GRAY}${'─'.repeat(cols)}${RESET}`;
      const botBorder = `${GRAY}${'─'.repeat(cols)}${RESET}`;

      // Track cursor position relative to the top of the rendered block.
      // After render(), cursor is on input line (index 1). After cleanup, cursor is at top.
      let cursorLine = 0;

      const clearBlock = () => {
        if (totalLines === 0) return;
        // Move cursor to top of block first
        if (cursorLine > 0) stdout.write(`\x1b[${cursorLine}A`);
        // Clear all lines from top to bottom
        for (let i = 0; i < totalLines; i++) {
          stdout.write(`\r\x1b[K${i < totalLines - 1 ? '\n' : ''}`);
        }
        // Move back to top
        if (totalLines > 1) stdout.write(`\x1b[${totalLines - 1}A`);
        stdout.write('\r');
        cursorLine = 0;
        totalLines = 0;
      };

      const render = () => {
        clearBlock();

        // Ensure selected is visible in scroll window
        if (selected < scrollOffset) scrollOffset = selected;
        if (selected >= scrollOffset + MAX_VISIBLE) scrollOffset = selected - MAX_VISIBLE + 1;

        const lines: string[] = [];

        // Top border
        lines.push(topBorder);
        // Input line
        lines.push(` ${GREEN}❯${RESET} ${CYAN}${input}${RESET}`);
        // Bottom border
        lines.push(botBorder);

        // Command list
        if (matches.length > 0) {
          const visible = Math.min(matches.length, MAX_VISIBLE);
          const end = Math.min(scrollOffset + visible, matches.length);
          for (let i = scrollOffset; i < end; i++) {
            const m = matches[i]!;
            const desc = m.description.length > cols - 22
              ? m.description.slice(0, cols - 25) + '…'
              : m.description;
            if (i === selected) {
              lines.push(` ${BOLD}${m.name.padEnd(18)}${RESET} ${desc}`);
            } else {
              lines.push(` ${DIM}${m.name.padEnd(18)} ${desc}${RESET}`);
            }
          }
          // Scroll indicator
          if (matches.length > MAX_VISIBLE) {
            const hasMore = end < matches.length;
            const hasAbove = scrollOffset > 0;
            const arrow = hasMore && hasAbove ? '▲▼' : hasMore ? ' ▼' : ' ▲';
            lines.push(` ${DIM}${arrow}${RESET}`);
            lines.push(` ${DIM}(${selected + 1}/${matches.length})${RESET}`);
          }
        } else {
          lines.push(` ${DIM}No matching commands${RESET}`);
        }

        // Write all lines
        stdout.write(lines.map(l => `\r\x1b[K${l}`).join('\n'));
        totalLines = lines.length;

        // Move cursor back to input line (line index 1)
        const up = totalLines - 2; // from last line to input line (index 1)
        if (up > 0) stdout.write(`\x1b[${up}A`);
        cursorLine = 1; // cursor is on input line (index 1)
        const cursorCol = 3 + input.length; // " ❯ " = 3 visible chars + input
        stdout.write(`\r\x1b[${cursorCol}C`);
      };

      let escTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (result: string | null) => {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        stdin.removeListener('data', onData);
        clearBlock();
        stdout.write('\r\x1b[K');
        resolve(result);
      };

      const onData = (data: Buffer) => {
        const b0 = data[0];

        // Handle follow-up after bare ESC (split arrow key delivery)
        if (escTimer && b0 === 0x5b /* [ */) {
          clearTimeout(escTimer);
          escTimer = null;
          if (data[1] === 0x41 && matches.length > 0) { // Up
            selected = (selected - 1 + matches.length) % matches.length;
            render();
          } else if (data[1] === 0x42 && matches.length > 0) { // Down
            selected = (selected + 1) % matches.length;
            render();
          }
          return;
        }
        if (escTimer) {
          clearTimeout(escTimer);
          escTimer = null;
        }

        // ESC sequences or bare ESC
        if (b0 === 0x1b) {
          if (data.length === 1) {
            // Could be bare ESC or start of split sequence — wait 50ms
            escTimer = setTimeout(() => { escTimer = null; cleanup(null); }, 50);
            return;
          }
          if (data[1] === 0x5b) {
            if (data[2] === 0x41) { // Up
              if (matches.length > 0) {
                selected = (selected - 1 + matches.length) % matches.length;
                render();
              }
              return;
            }
            if (data[2] === 0x42) { // Down
              if (matches.length > 0) {
                selected = (selected + 1) % matches.length;
                render();
              }
              return;
            }
          }
          return;
        }

        // Enter
        if (b0 === 0x0d) {
          // If input has a space (subcommand), return the full input as typed
          // Otherwise return the selected match name (autocomplete selection)
          const result = input.includes(' ')
            ? input
            : (matches[selected]?.name ?? (input.length > 1 ? input : null));
          cleanup(result);
          return;
        }

        // Tab — fill selected, keep typing
        if (b0 === 0x09) {
          if (matches[selected]) {
            input = matches[selected]!.name + ' ';
            selected = 0;
            scrollOffset = 0;
            matches = this.filter(input.trimEnd());
            render();
          }
          return;
        }

        // Ctrl+C
        if (b0 === 0x03) { cleanup(null); return; }

        // Backspace
        if (b0 === 0x7f) {
          if (input.length > 1) {
            input = input.slice(0, -1);
            selected = 0;
            scrollOffset = 0;
            matches = this.filter(input);
            render();
          } else {
            cleanup(null);
          }
          return;
        }

        // Printable ASCII
        if (b0 !== undefined && b0 >= 0x20 && b0 < 0x7f) {
          input += String.fromCharCode(b0);
          if (!input.includes(' ')) {
            selected = 0;
            scrollOffset = 0;
            matches = this.filter(input);
          }
          render();
        }
      };

      stdin.on('data', onData);
      render();
    });
  }

  private filter(input: string): CommandDef[] {
    const q = input.toLowerCase().split(' ')[0]!;
    return this.commands.filter(c => c.name.toLowerCase().startsWith(q));
  }
}

/**
 * Parse HELP_TEXT-style command definitions into CommandDef array.
 */
export function buildCommandDefs(commands: string[], helpText: string): CommandDef[] {
  const defs: CommandDef[] = [];
  let currentCategory = '';

  for (const line of helpText.split('\n')) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!stripped) continue;

    if (!stripped.startsWith('/') && !stripped.includes('  /')) {
      currentCategory = stripped;
      continue;
    }

    const match = stripped.match(/^(\/\S+)\s*(.*)/);
    if (match) {
      const name = match[1]!;
      let desc = match[2]?.replace(/^\[.*?\]\s*/, '').trim() ?? '';
      desc = desc.replace(/^\(.*?\)\s*/, '');
      if (commands.includes(name)) {
        defs.push({ name, description: desc, category: currentCategory });
      }
    }
  }

  for (const cmd of commands) {
    if (!defs.some(d => d.name === cmd)) {
      defs.push({ name: cmd, description: '', category: 'Other' });
    }
  }

  return defs;
}
