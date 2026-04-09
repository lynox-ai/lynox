import { stdout } from 'node:process';
import { GRAY, DIM, RESET, stripAnsi } from './ansi.js';

/**
 * Inline status bar — prints a dim status line after each response.
 * No scroll regions, no cursor manipulation. Works with terminal scrollback.
 */
export class FooterBar {
  private active = false;
  private right = '';

  activate(): void {
    if (!stdout.isTTY) return;
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
  }

  setStatus(text: string): void {
    this.right = text;
  }

  /** Print the status line inline. Call after turn_end output. */
  render(): string {
    if (!this.active || !this.right) return '';
    const cols = stdout.columns ?? 80;
    const statsLen = stripAnsi(this.right).length;
    const fillLen = Math.max(0, cols - statsLen - 1);
    const fill = `${GRAY}${'─'.repeat(fillLen)}${RESET}`;
    return `${fill} ${DIM}${this.right}${RESET}\n`;
  }

  isActivated(): boolean {
    return this.active;
  }
}
