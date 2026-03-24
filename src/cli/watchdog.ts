import { resolve } from 'node:path';
import { stdout } from 'node:process';
import { BLUE, RESET, DIM, MAGENTA } from './ui.js';
import { FileTrigger } from '../core/triggers/file-trigger.js';

export class Watchdog {
  private readonly dir: string;
  private readonly onChangeBatch: (files: string[]) => Promise<void>;
  private trigger: FileTrigger | null = null;

  constructor(dir: string, onChangeBatch: (files: string[]) => Promise<void>, debounceMs = 500) {
    this.dir = resolve(dir);
    this.onChangeBatch = onChangeBatch;
    this.trigger = new FileTrigger({ type: 'file', dir: this.dir, debounceMs });
  }

  start(): void {
    stdout.write(`${BLUE}👁${RESET} ${DIM}Watching${RESET} ${this.dir}\n`);
    this.trigger?.start(async (event) => {
      const payload = event.payload as { files?: string[] } | undefined;
      const files = payload?.files ?? [];
      if (files.length > 0) {
        stdout.write(`${BLUE}△${RESET} ${DIM}Changed:${RESET} ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}\n`);
        await this.onChangeBatch(files);
      }
    });
  }

  stop(): void {
    if (this.trigger) {
      this.trigger.stop();
      this.trigger = null;
    }
    stdout.write(`${MAGENTA}■${RESET} ${DIM}Watchdog stopped${RESET}\n`);
  }
}
