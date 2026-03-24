import type { TabQuestion } from '../types/index.js';
import { RESET, BOLD, DIM, BLUE, GRAY, REVERSE, HIDE_CURSOR, SHOW_CURSOR, CLEAR_LINE, stripAnsi, wordWrap } from './ansi.js';

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

const OTHER_LABEL = 'Other';

function renderBox(text: string, width: number): string {
  const clean = stripAnsi(text).replace(/\s*Allow\?\s*\[y\/N\]/i, '').trim();
  const rawLines = clean.split('\n');
  const wrapped: string[] = [];
  for (const rl of rawLines) {
    wrapped.push(...wordWrap(rl, width - 4));
  }
  const top = `  ${GRAY}${BOX.tl}${BOX.h.repeat(width)}${BOX.tr}${RESET}\n`;
  const bottom = `  ${GRAY}${BOX.bl}${BOX.h.repeat(width)}${BOX.br}${RESET}\n`;
  let out = top;
  for (const line of wrapped) {
    const pad = Math.max(0, width - 2 - stripAnsi(line).length);
    out += `  ${GRAY}${BOX.v}${RESET} ${line}${' '.repeat(pad)} ${GRAY}${BOX.v}${RESET}\n`;
  }
  out += bottom;
  return out;
}

type DialogMode = 'select' | 'confirm' | 'freeform';

function detectMode(question: string, options?: string[]): DialogMode {
  if (options && options.length > 0) return 'select';
  if (/\[y\/N\]|Allow\?/i.test(question)) return 'confirm';
  return 'freeform';
}

export class InteractiveDialog {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;

  constructor(input: NodeJS.ReadStream, output: NodeJS.WriteStream) {
    this.input = input;
    this.output = output;
  }

  async prompt(question: string, options?: string[]): Promise<string> {
    if (!this.input.isTTY) {
      return this.fallbackPrompt(question);
    }
    const mode = detectMode(question, options);
    switch (mode) {
      case 'select': return this.selectMode(question, options!);
      case 'confirm': return this.confirmMode(question);
      case 'freeform': return this.freeformMode(question);
    }
  }

  async tabbedPrompt(questions: TabQuestion[]): Promise<string[]> {
    if (!this.input.isTTY || questions.length === 0) {
      return this.fallbackTabbedPrompt(questions);
    }

    return new Promise((resolve) => {
      let tabIdx = 0;
      const answers: string[] = new Array(questions.length).fill('');
      const selected: number[] = new Array(questions.length).fill(0);
      const freeformTexts: string[] = new Array(questions.length).fill('');
      const inFreeform: boolean[] = new Array(questions.length).fill(false);
      // Track whether "Other" was selected and confirmed (waiting for text input)
      const otherActive: boolean[] = new Array(questions.length).fill(false);
      let rendered = 0;

      const getOptionsWithOther = (idx: number): string[] | undefined => {
        const q = questions[idx]!;
        if (!q.options || q.options.length === 0) return undefined;
        // Sentinel: last option '\x00' means skip "Other"
        const skip = q.options.length > 0 && q.options[q.options.length - 1] === '\x00';
        const clean = skip ? q.options.slice(0, -1) : q.options;
        return skip ? clean : [...clean, OTHER_LABEL];
      };

      const build = (): string => {
        // Tab chips
        const chips = questions.map((q, i) => {
          const label = q.header ?? `Q${i + 1}`;
          if (i === tabIdx) return `${BLUE}${BOLD}[${label}]${RESET}`;
          if (i < tabIdx) return `${DIM}[${label} \u2713]${RESET}`;
          return `${DIM}[${label}]${RESET}`;
        });
        let out = `  ${chips.join(' ')}\n\n`;

        // Question box
        out += renderBox(questions[tabIdx]!.question, 52);

        const opts = getOptionsWithOther(tabIdx);
        if (opts && !otherActive[tabIdx]) {
          out += '\n';
          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i]!;
            if (!inFreeform[tabIdx] && i === selected[tabIdx]) {
              out += `  ${BLUE}${BOLD}> ${i + 1}. ${opt}${RESET}\n`;
            } else {
              out += `  ${DIM}  ${i + 1}. ${opt}${RESET}\n`;
            }
          }
          const tabOpts = questions[tabIdx]!.options;
          const tabSkipOther = tabOpts && tabOpts.length > 0 && tabOpts[tabOpts.length - 1] === '\x00';
          if (!tabSkipOther) {
            out += `\n  ${DIM}or type:${RESET} ${inFreeform[tabIdx] ? freeformTexts[tabIdx] : ''}`;
          }
        } else if (otherActive[tabIdx]) {
          // "Other" was selected — show freeform input
          out += `\n  ${BLUE}>${RESET} ${freeformTexts[tabIdx]}`;
        } else {
          // No options — pure freeform
          out += `\n  ${BLUE}>${RESET} ${freeformTexts[tabIdx]}`;
        }

        out += `\n\n  ${DIM}ESC back  ENTER confirm  arrows navigate${RESET}`;
        return out;
      };

      const render = () => {
        if (rendered > 0) {
          this.output.write(`\x1b[${rendered}A`);
        }
        const frame = build();
        const lines = frame.split('\n');
        for (const line of lines) {
          this.output.write(`${CLEAR_LINE}${line}\n`);
        }
        rendered = lines.length;
      };

      this.output.write(HIDE_CURSOR);
      this.input.setRawMode(true);
      this.input.resume();
      render();

      let escTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        this.input.setRawMode(false);
        this.input.removeListener('data', onKey);
        this.output.write(SHOW_CURSOR);
      };

      const handleEsc = () => {
        if (otherActive[tabIdx]) {
          otherActive[tabIdx] = false;
          freeformTexts[tabIdx] = '';
          render();
          return;
        }
        if (tabIdx > 0) {
          tabIdx--;
          render();
          return;
        }
        cleanup();
        resolve([]);
      };

      const onKey = (data: Buffer) => {
        const key = data.toString();

        // Ctrl+C — cancel gracefully (same as ESC on first tab)
        if (key === '\x03') {
          cleanup();
          resolve([]);
          return;
        }

        // ESC disambiguation: wait 50ms to distinguish bare ESC from arrow key split
        if (key === '\x1b') {
          escTimer = setTimeout(handleEsc, 50);
          return;
        }
        // Cancel pending ESC if any input arrives within the 50ms window
        if (escTimer) {
          clearTimeout(escTimer);
          escTimer = null;
          // If it's a split arrow key follow-up (e.g. '[A' after bare ESC)
          if (key.length >= 2 && key[0] === '[') {
            const opts = getOptionsWithOther(tabIdx);
            const hasOptions = !!opts && !otherActive[tabIdx];
            const arrowKey = '\x1b' + key;
            if (arrowKey === '\x1b[A' && hasOptions) {
              inFreeform[tabIdx] = false;
              selected[tabIdx] = Math.max(0, selected[tabIdx]! - 1);
              render();
            } else if (arrowKey === '\x1b[B' && hasOptions) {
              inFreeform[tabIdx] = false;
              selected[tabIdx] = Math.min(opts!.length - 1, selected[tabIdx]! + 1);
              render();
            }
            return;
          }
          // Otherwise fall through to normal key handling
        }

        // Multi-byte escape sequences delivered in one chunk
        if (key.startsWith('\x1b[')) {
          const opts = getOptionsWithOther(tabIdx);
          const hasOptions = !!opts && !otherActive[tabIdx];
          if (key === '\x1b[A' && hasOptions) {
            inFreeform[tabIdx] = false;
            selected[tabIdx] = Math.max(0, selected[tabIdx]! - 1);
            render();
          } else if (key === '\x1b[B' && hasOptions) {
            inFreeform[tabIdx] = false;
            selected[tabIdx] = Math.min(opts!.length - 1, selected[tabIdx]! + 1);
            render();
          }
          return;
        }

        const opts = getOptionsWithOther(tabIdx);
        const hasOptions = !!opts && !otherActive[tabIdx];
        const isFreeformOnly = !opts || otherActive[tabIdx];

        // Enter
        if (key === '\r' || key === '\n') {
          let answer: string;
          if (hasOptions && !inFreeform[tabIdx]) {
            const sel = selected[tabIdx]!;
            const opt = opts![sel];
            if (opt === OTHER_LABEL) {
              // Activate "Other" freeform input
              otherActive[tabIdx] = true;
              freeformTexts[tabIdx] = '';
              render();
              return;
            }
            answer = opt ?? '';
          } else if (hasOptions && inFreeform[tabIdx]) {
            answer = freeformTexts[tabIdx]!;
          } else {
            // Freeform only (no options, or "Other" active)
            answer = freeformTexts[tabIdx]!;
          }

          if (!answer && isFreeformOnly) {
            // Don't advance on empty freeform
            return;
          }

          answers[tabIdx] = answer;

          if (tabIdx < questions.length - 1) {
            tabIdx++;
            render();
          } else {
            cleanup();
            resolve(answers);
          }
          return;
        }

        // Number jump (only when not in freeform and has options)
        if (hasOptions && !inFreeform[tabIdx]) {
          const num = parseInt(key, 10);
          if (!isNaN(num) && num >= 1 && num <= opts!.length) {
            selected[tabIdx] = num - 1;
            render();
            return;
          }
        }

        // Backspace
        if (key === '\x7f' || key === '\x08') {
          if (inFreeform[tabIdx] || isFreeformOnly) {
            freeformTexts[tabIdx] = freeformTexts[tabIdx]!.slice(0, -1);
            if (hasOptions && freeformTexts[tabIdx]!.length === 0) {
              inFreeform[tabIdx] = false;
            }
            render();
          }
          return;
        }

        // Printable character
        if (key.length === 1 && key >= ' ') {
          if (hasOptions) {
            inFreeform[tabIdx] = true;
          }
          freeformTexts[tabIdx] += key;
          render();
        }
      };

      this.input.on('data', onKey);
    });
  }

  private fallbackPrompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.output.write(`${question}\n> `);
      let data = '';
      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        const nl = data.indexOf('\n');
        if (nl !== -1) {
          this.input.removeListener('data', onData);
          resolve(data.slice(0, nl).trim());
        }
      };
      this.input.on('data', onData);
    });
  }

  private async fallbackTabbedPrompt(questions: TabQuestion[]): Promise<string[]> {
    const answers: string[] = [];
    for (const q of questions) {
      const answer = await this.fallbackPrompt(q.question);
      answers.push(answer);
    }
    return answers;
  }

  private selectMode(question: string, options: string[]): Promise<string> {
    return new Promise((resolve) => {
      // Sentinel: if last option is '\x00', skip "Other" freeform option
      const skipOther = options.length > 0 && options[options.length - 1] === '\x00';
      const cleanOptions = skipOther ? options.slice(0, -1) : options;
      const allOptions = skipOther ? cleanOptions : [...cleanOptions, OTHER_LABEL];
      let selected = 0;
      let freeformText = '';
      let inFreeform = false;
      let otherActive = false;
      let rendered = 0;
      let escTimer: ReturnType<typeof setTimeout> | null = null;

      const build = (): string => {
        let out = renderBox(question, 52);
        if (!otherActive) {
          out += '\n';
          for (let i = 0; i < allOptions.length; i++) {
            const opt = allOptions[i]!;
            if (!inFreeform && i === selected) {
              out += `  ${BLUE}${BOLD}> ${i + 1}. ${opt}${RESET}\n`;
            } else {
              out += `  ${DIM}  ${i + 1}. ${opt}${RESET}\n`;
            }
          }
          if (!skipOther) {
            out += `\n  ${DIM}or type:${RESET} ${inFreeform ? freeformText : ''}`;
          }
        } else {
          out += `\n  ${BLUE}>${RESET} ${freeformText}`;
        }
        out += `\n\n  ${DIM}ESC cancel  ENTER confirm  arrows navigate${RESET}`;
        return out;
      };

      const render = () => {
        if (rendered > 0) {
          this.output.write(`\x1b[${rendered}A`);
        }
        const frame = build();
        const lines = frame.split('\n');
        for (const line of lines) {
          this.output.write(`${CLEAR_LINE}${line}\n`);
        }
        rendered = lines.length;
      };

      this.output.write(HIDE_CURSOR);
      this.input.setRawMode(true);
      this.input.resume();
      render();

      const cleanup = () => {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        this.input.setRawMode(false);
        this.input.removeListener('data', onKey);
        this.output.write(SHOW_CURSOR);
      };

      const handleEsc = () => {
        if (otherActive) {
          otherActive = false;
          freeformText = '';
          render();
          return;
        }
        cleanup();
        resolve('');
      };

      const onKey = (data: Buffer) => {
        const key = data.toString();

        if (key === '\x03') {
          cleanup();
          resolve('');
          return;
        }

        // ESC disambiguation: bare \x1b could be standalone ESC or start of
        // arrow key sequence split across data events. Wait 50ms to see if
        // more bytes follow (e.g. '[A' for arrow up).
        if (key === '\x1b') {
          escTimer = setTimeout(handleEsc, 50);
          return;
        }
        // Cancel pending ESC if any input arrives within the 50ms window
        if (escTimer) {
          clearTimeout(escTimer);
          escTimer = null;
          if (key.length >= 2 && key[0] === '[') {
            const arrowKey = '\x1b' + key;
            if (arrowKey === '\x1b[A' && !otherActive) {
              inFreeform = false;
              selected = Math.max(0, selected - 1);
              render();
            } else if (arrowKey === '\x1b[B' && !otherActive) {
              inFreeform = false;
              selected = Math.min(allOptions.length - 1, selected + 1);
              render();
            }
            return;
          }
          // Otherwise fall through to normal key handling
        }

        // Multi-byte escape sequences delivered in one chunk (normal case)
        if (key.startsWith('\x1b[')) {
          if (key === '\x1b[A' && !otherActive) {
            inFreeform = false;
            selected = Math.max(0, selected - 1);
            render();
          } else if (key === '\x1b[B' && !otherActive) {
            inFreeform = false;
            selected = Math.min(allOptions.length - 1, selected + 1);
            render();
          }
          return;
        }

        if (key === '\r' || key === '\n') {
          if (otherActive) {
            cleanup();
            resolve(freeformText);
            return;
          }
          if (inFreeform && freeformText) {
            cleanup();
            resolve(freeformText);
            return;
          }
          const opt = allOptions[selected];
          if (opt === OTHER_LABEL) {
            otherActive = true;
            freeformText = '';
            render();
            return;
          }
          cleanup();
          resolve(opt ?? '');
          return;
        }

        if (otherActive) {
          if (key === '\x7f' || key === '\x08') {
            freeformText = freeformText.slice(0, -1);
            render();
            return;
          }
          if (key.length === 1 && key >= ' ') {
            freeformText += key;
            render();
          }
          return;
        }

        const num = parseInt(key, 10);
        if (!isNaN(num) && num >= 1 && num <= allOptions.length && !inFreeform) {
          selected = num - 1;
          inFreeform = false;
          render();
          return;
        }

        if (key === '\x7f' || key === '\x08') {
          if (inFreeform) {
            freeformText = freeformText.slice(0, -1);
            if (freeformText.length === 0) inFreeform = false;
            render();
          }
          return;
        }

        if (key.length === 1 && key >= ' ') {
          inFreeform = true;
          freeformText += key;
          render();
        }
      };

      this.input.on('data', onKey);
    });
  }

  private confirmMode(question: string): Promise<string> {
    return new Promise((resolve) => {
      let selected = 1; // default Deny
      let rendered = 0;

      const build = (): string => {
        let out = renderBox(question, 52);
        out += '\n';
        const allow = selected === 0 ? `${REVERSE} Allow ${RESET}` : `${DIM} Allow ${RESET}`;
        const deny = selected === 1 ? `${REVERSE} Deny ${RESET}` : `${DIM} Deny ${RESET}`;
        out += `    ${allow}    ${deny}`;
        out += `\n\n  ${DIM}ESC deny  y/n  arrows select${RESET}`;
        return out;
      };

      const render = () => {
        if (rendered > 0) {
          this.output.write(`\x1b[${rendered}A`);
        }
        const frame = build();
        const lines = frame.split('\n');
        for (const line of lines) {
          this.output.write(`${CLEAR_LINE}${line}\n`);
        }
        rendered = lines.length;
      };

      this.output.write(HIDE_CURSOR);
      this.input.setRawMode(true);
      this.input.resume();
      render();

      let escTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        this.input.setRawMode(false);
        this.input.removeListener('data', onKey);
        this.output.write(SHOW_CURSOR);
      };

      const onKey = (data: Buffer) => {
        const key = data.toString();

        if (key === '\x03') {
          cleanup();
          resolve('n');
          return;
        }

        // ESC disambiguation
        if (key === '\x1b') {
          escTimer = setTimeout(() => { cleanup(); resolve('n'); }, 50);
          return;
        }
        if (escTimer) {
          clearTimeout(escTimer);
          escTimer = null;
          if (key.length >= 2 && key[0] === '[') {
            const arrowKey = '\x1b' + key;
            if (arrowKey === '\x1b[D' || arrowKey === '\x1b[C') {
              selected = selected === 0 ? 1 : 0;
              render();
            }
            return;
          }
        }

        if (key === '\r' || key === '\n') {
          cleanup();
          resolve(selected === 0 ? 'y' : 'n');
          return;
        }

        if (key === '\x1b[D' || key === '\x1b[C') {
          selected = selected === 0 ? 1 : 0;
          render();
          return;
        }

        if (key === 'y' || key === 'Y') {
          cleanup();
          resolve('y');
          return;
        }

        if (key === 'n' || key === 'N') {
          cleanup();
          resolve('n');
          return;
        }
      };

      this.input.on('data', onKey);
    });
  }

  private freeformMode(question: string): Promise<string> {
    return new Promise((resolve) => {
      let text = '';
      let rendered = 0;

      const build = (): string => {
        let out = renderBox(question, 52);
        out += `\n  ${BLUE}>${RESET} ${text}`;
        return out;
      };

      const render = () => {
        if (rendered > 0) {
          this.output.write(`\x1b[${rendered}A`);
        }
        const frame = build();
        const lines = frame.split('\n');
        for (const line of lines) {
          this.output.write(`${CLEAR_LINE}${line}\n`);
        }
        rendered = lines.length;
      };

      this.output.write(SHOW_CURSOR);
      this.input.setRawMode(true);
      this.input.resume();
      render();

      let escTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (escTimer) { clearTimeout(escTimer); escTimer = null; }
        this.input.setRawMode(false);
        this.input.removeListener('data', onKey);
      };

      const onKey = (data: Buffer) => {
        const key = data.toString();

        if (key === '\x03') {
          cleanup();
          resolve('');
          return;
        }

        // ESC disambiguation — freeform doesn't use arrow keys but
        // handle split sequences to avoid swallowing input
        if (key === '\x1b') {
          escTimer = setTimeout(() => { cleanup(); resolve(''); }, 50);
          return;
        }
        if (escTimer) {
          clearTimeout(escTimer);
          escTimer = null;
        }

        if (key === '\r' || key === '\n') {
          cleanup();
          resolve(text);
          return;
        }

        if (key === '\x7f' || key === '\x08') {
          text = text.slice(0, -1);
          render();
          return;
        }

        if (key.length === 1 && key >= ' ') {
          text += key;
          render();
        }
      };

      this.input.on('data', onKey);
    });
  }
}
