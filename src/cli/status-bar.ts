import { RESET } from './ansi.js';

/**
 * Status bar — renders a line above the prompt.
 * Content should include its own ANSI formatting.
 * No cursor manipulation needed; the line is simply part of scrollback.
 */
export class StatusBar {
  private content = '';

  update(content: string): void {
    this.content = content;
  }

  /** Return the status line string to write before the prompt. */
  render(stream: NodeJS.WriteStream): string {
    if (!stream.isTTY || !this.content) return '';
    return `${this.content}${RESET}\n`;
  }

  /** Clear stored content (e.g. on reset). */
  clear(): void {
    this.content = '';
  }

  getContent(): string {
    return this.content;
  }
}
