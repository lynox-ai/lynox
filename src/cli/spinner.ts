import { stderr } from 'node:process';
import { GRAY, DIM, RESET } from './ansi.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL = 80;

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private startTime = 0;

  start(label: string): void {
    if (this.timer) return;
    this.frame = 0;
    this.startTime = Date.now();
    this.timer = setInterval(() => {
      const f = FRAMES[this.frame % FRAMES.length]!;
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      stderr.write(`\r${GRAY}${f} ${DIM}${label} ${elapsed}s${RESET}\x1b[K`);
      this.frame++;
    }, INTERVAL);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    stderr.write('\r\x1b[K');
  }

  updateLabel(label: string): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.frame = 0;
    this.timer = setInterval(() => {
      const f = FRAMES[this.frame % FRAMES.length]!;
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      stderr.write(`\r${GRAY}${f} ${DIM}${label} ${elapsed}s${RESET}\x1b[K`);
      this.frame++;
    }, INTERVAL);
  }

  isActive(): boolean {
    return this.timer !== null;
  }
}
