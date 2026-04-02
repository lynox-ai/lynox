// === Interactive CLI prompts ===
// Arrow key navigation, Enter to select, Esc to skip.
// Falls back to readline for non-TTY (tests, piped input).

import { stdin, stdout } from 'node:process';
import { BOLD, DIM, BLUE, GREEN, RESET } from './ansi.js';

export interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string | undefined;
}

/**
 * Interactive select with arrow keys. Returns the selected value.
 * Falls back to numbered list on non-TTY or when rl is provided (tests).
 */
export async function select<T>(
  options: SelectOption<T>[],
  opts?: { default?: number | undefined; allowSkip?: boolean | undefined; rl?: import('node:readline/promises').Interface | undefined } | undefined,
): Promise<T | null> {
  if (!stdin.isTTY || opts?.rl) {
    return selectFallback(options, opts);
  }

  let cursor = opts?.default ?? 0;
  const draw = (): void => {
    // Move cursor up to redraw (except first draw)
    stdout.write(`\x1b[${options.length}A`);
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const active = i === cursor;
      const prefix = active ? `${BLUE}❯${RESET} ` : '  ';
      const label = active ? `${BOLD}${opt.label}${RESET}` : opt.label;
      const hint = opt.hint ? ` ${DIM}${opt.hint}${RESET}` : '';
      stdout.write(`\x1b[2K${prefix}${label}${hint}\n`);
    }
  };

  // Initial draw
  for (const opt of options) {
    const hint = opt.hint ? ` ${DIM}${opt.hint}${RESET}` : '';
    stdout.write(`  ${opt.label}${hint}\n`);
  }
  draw();

  return new Promise<T | null>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    const prevEncoding = stdin.readableEncoding;
    stdin.setEncoding('utf8');

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onKey);
      stdin.pause();
      if (prevEncoding) stdin.setEncoding(prevEncoding);
    };

    const onKey = (data: string): void => {
      const key = data.toString();

      // Arrow up / k
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + options.length) % options.length;
        draw();
        return;
      }
      // Arrow down / j
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % options.length;
        draw();
        return;
      }
      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        resolve(options[cursor]!.value);
        return;
      }
      // Escape
      if (key === '\x1b' && opts?.allowSkip) {
        cleanup();
        stdout.write(`  ${DIM}Skipped.${RESET}\n`);
        resolve(null);
        return;
      }
      // Ctrl+C
      if (key === '\x03') {
        cleanup();
        resolve(null);
        return;
      }
    };

    stdin.on('data', onKey);
  });
}

/**
 * Interactive confirm with Y/n. Returns boolean.
 * Falls back to readline on non-TTY or when rl is provided (tests).
 */
export async function confirm(
  message: string,
  defaultYes: boolean = true,
  rl?: import('node:readline/promises').Interface | undefined,
): Promise<boolean> {
  if (!stdin.isTTY || rl) {
    return confirmFallback(message, defaultYes, rl);
  }

  const hint = defaultYes ? `${BOLD}Y${RESET}/${DIM}n${RESET}` : `${DIM}y${RESET}/${BOLD}N${RESET}`;
  stdout.write(`  ${message} [${hint}] `);

  return new Promise<boolean>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onKey);
      stdin.pause();
    };

    const onKey = (data: string): void => {
      const key = data.toString().toLowerCase();
      if (key === 'y' || (key === '\r' && defaultYes) || (key === '\n' && defaultYes)) {
        cleanup();
        stdout.write(`${GREEN}Yes${RESET}\n`);
        resolve(true);
      } else if (key === 'n' || (key === '\r' && !defaultYes) || (key === '\n' && !defaultYes)) {
        cleanup();
        stdout.write(`${DIM}No${RESET}\n`);
        resolve(false);
      } else if (key === '\x1b' || key === '\x03') {
        cleanup();
        stdout.write(`${DIM}No${RESET}\n`);
        resolve(false);
      }
    };

    stdin.on('data', onKey);
  });
}

// ---------------------------------------------------------------------------
// Multi-select checklist (Space to toggle, Enter to confirm)
// ---------------------------------------------------------------------------

export interface ChecklistOption<T> {
  label: string;
  value: T;
  hint?: string | undefined;
  checked?: boolean | undefined;
}

/**
 * Interactive checklist with arrow keys + space to toggle.
 * Returns the selected values. Falls back to numbered input on non-TTY.
 */
export async function multiSelect<T>(
  options: ChecklistOption<T>[],
  opts?: { rl?: import('node:readline/promises').Interface | undefined } | undefined,
): Promise<T[]> {
  if (!stdin.isTTY || opts?.rl) {
    return multiSelectFallback(options, opts);
  }

  let cursor = 0;
  const checked = options.map(o => o.checked === true);

  const draw = (): void => {
    stdout.write(`\x1b[${options.length}A`);
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const active = i === cursor;
      const box = checked[i] ? `${GREEN}[✓]${RESET}` : `${DIM}[ ]${RESET}`;
      const prefix = active ? `${BLUE}❯${RESET} ` : '  ';
      const label = active ? `${BOLD}${opt.label}${RESET}` : opt.label;
      const hint = opt.hint ? `  ${DIM}${opt.hint}${RESET}` : '';
      stdout.write(`\x1b[2K${prefix}${box} ${label}${hint}\n`);
    }
  };

  // Hint line
  stdout.write(`${DIM}  ↑↓ move · Space toggle · Enter continue${RESET}\n\n`);
  // Initial draw
  for (const opt of options) {
    const box = opt.checked ? `${GREEN}[✓]${RESET}` : `${DIM}[ ]${RESET}`;
    const hint = opt.hint ? `  ${DIM}${opt.hint}${RESET}` : '';
    stdout.write(`  ${box} ${opt.label}${hint}\n`);
  }
  draw();

  return new Promise<T[]>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    const prevEncoding = stdin.readableEncoding;
    stdin.setEncoding('utf8');

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onKey);
      stdin.pause();
      if (prevEncoding) stdin.setEncoding(prevEncoding);
    };

    const onKey = (data: string): void => {
      const key = data.toString();

      // Arrow up / k
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + options.length) % options.length;
        draw();
        return;
      }
      // Arrow down / j
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % options.length;
        draw();
        return;
      }
      // Space — toggle
      if (key === ' ') {
        checked[cursor] = !checked[cursor];
        draw();
        return;
      }
      // Enter — confirm
      if (key === '\r' || key === '\n') {
        cleanup();
        const selected = options.filter((_, i) => checked[i]);
        resolve(selected.map(o => o.value));
        return;
      }
      // Escape / Ctrl+C — skip all
      if (key === '\x1b' || key === '\x03') {
        cleanup();
        resolve([]);
        return;
      }
    };

    stdin.on('data', onKey);
  });
}

// ---------------------------------------------------------------------------
// Secret input (masked)
// ---------------------------------------------------------------------------

/**
 * Read a secret from stdin with masking. Shows ● for each character,
 * reveals the last 4 chars for confirmation (e.g., ●●●●●●●●●●wAA).
 * Falls back to readline on non-TTY (no masking possible).
 */
export async function readSecret(
  prompt: string,
  rl?: import('node:readline/promises').Interface | undefined,
): Promise<string> {
  if (!stdin.isTTY || rl) {
    // Non-TTY fallback — no masking possible (CI, piped input)
    const injected = rl;
    let fallbackRl: import('node:readline/promises').Interface;
    if (injected) {
      fallbackRl = injected;
    } else {
      const { createInterface } = await import('node:readline/promises');
      fallbackRl = createInterface({ input: stdin, output: stdout });
    }
    try {
      return (await fallbackRl.question(`  ${prompt} `)).trim();
    } finally {
      if (!injected) fallbackRl.close();
    }
  }

  stdout.write(`  ${prompt} `);
  let buf = '';

  return new Promise<string>((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    const prevEncoding = stdin.readableEncoding;
    stdin.setEncoding('utf8');

    const redraw = (): void => {
      // Clear current line after prompt
      const masked = buf.length <= 4
        ? buf
        : '●'.repeat(buf.length - 4) + buf.slice(-4);
      stdout.write(`\r  ${prompt} ${masked}\x1b[K`);
    };

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.removeListener('data', onKey);
      stdin.pause();
      if (prevEncoding) stdin.setEncoding(prevEncoding);
    };

    const onKey = (data: string): void => {
      for (const ch of data) {
        // Enter — submit
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        // Ctrl+C / Escape — abort
        if (ch === '\x03' || ch === '\x1b') {
          cleanup();
          stdout.write('\n');
          resolve('');
          return;
        }
        // Backspace / Delete
        if (ch === '\x7f' || ch === '\b') {
          if (buf.length > 0) buf = buf.slice(0, -1);
          redraw();
          continue;
        }
        // Ctrl+U — clear line
        if (ch === '\x15') {
          buf = '';
          redraw();
          continue;
        }
        // Ignore other control chars
        if (ch.charCodeAt(0) < 32) continue;
        // Regular character
        buf += ch;
        redraw();
      }
    };

    stdin.on('data', onKey);
  });
}

// ---------------------------------------------------------------------------
// Fallbacks for non-TTY (tests, piped input)
// ---------------------------------------------------------------------------

async function selectFallback<T>(
  options: SelectOption<T>[],
  opts?: { default?: number | undefined; allowSkip?: boolean | undefined; rl?: import('node:readline/promises').Interface | undefined } | undefined,
): Promise<T | null> {
  const injected = opts?.rl;
  let rl: import('node:readline/promises').Interface;
  if (injected) {
    rl = injected;
  } else {
    const { createInterface } = await import('node:readline/promises');
    rl = createInterface({ input: stdin, output: stdout });
  }
  try {
    for (let i = 0; i < options.length; i++) {
      const def = i === (opts?.default ?? 0) ? ' (default)' : '';
      stdout.write(`  ${i + 1}. ${options[i]!.label}${def}\n`);
    }
    const answer = await rl.question('  Choose: ');
    const idx = parseInt(answer.trim(), 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx]!.value;
    return options[opts?.default ?? 0]!.value;
  } finally {
    if (!injected) rl.close();
  }
}

async function multiSelectFallback<T>(
  options: ChecklistOption<T>[],
  opts?: { rl?: import('node:readline/promises').Interface | undefined } | undefined,
): Promise<T[]> {
  const injected = opts?.rl;
  let rl: import('node:readline/promises').Interface;
  if (injected) {
    rl = injected;
  } else {
    const { createInterface } = await import('node:readline/promises');
    rl = createInterface({ input: stdin, output: stdout });
  }
  try {
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      const hint = opt.hint ? ` — ${opt.hint}` : '';
      stdout.write(`  ${i + 1}. ${opt.label}${hint}\n`);
    }
    const answer = await rl.question('  Select (comma-separated numbers, or Enter to skip): ');
    if (!answer.trim()) return [];
    const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1);
    return indices
      .filter(i => i >= 0 && i < options.length)
      .map(i => options[i]!.value);
  } finally {
    if (!injected) rl.close();
  }
}

async function confirmFallback(
  message: string,
  defaultYes: boolean,
  injected?: import('node:readline/promises').Interface | undefined,
): Promise<boolean> {
  let rl: import('node:readline/promises').Interface;
  if (injected) {
    rl = injected;
  } else {
    const { createInterface } = await import('node:readline/promises');
    rl = createInterface({ input: stdin, output: stdout });
  }
  try {
    const answer = await rl.question(`  ${message} [${defaultYes ? 'Y/n' : 'y/N'}]: `);
    const v = answer.trim().toLowerCase();
    if (v === 'y') return true;
    if (v === 'n') return false;
    return defaultYes;
  } finally {
    if (!injected) rl.close();
  }
}
