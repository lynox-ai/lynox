import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BatchEntry {
  submitted_at: string;
  request_count: number;
  label: string;
}

export class BatchIndex {
  private readonly path: string;
  private data: Record<string, BatchEntry> = {};
  private loaded = false;

  constructor(dir?: string | undefined) {
    this.path = join(dir ?? join(homedir(), '.lynox'), 'batch-index.json');
  }

  async load(): Promise<Record<string, BatchEntry>> {
    if (!this.loaded) {
      try {
        const raw = await readFile(this.path, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        this.data = typeof parsed === 'object' && parsed !== null
          ? parsed as Record<string, BatchEntry>
          : {};
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          this.data = {};
        } else if (err instanceof SyntaxError) {
          this.data = {};
        } else {
          throw err;
        }
      }
      this.loaded = true;
    }
    return { ...this.data };
  }

  async save(id: string, entry: BatchEntry): Promise<void> {
    await this.load();
    this.data[id] = entry;
    await writeFile(this.path, JSON.stringify(this.data, null, 2) + '\n', 'utf-8');
  }

  async get(id: string): Promise<BatchEntry | null> {
    await this.load();
    return this.data[id] ?? null;
  }
}
