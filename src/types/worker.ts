// === Worker Pool (used by lynox-pro for parallel execution) ===

export interface IWorkerPool {
  execute(toolName: string, input: unknown, signal?: AbortSignal): Promise<string>;
  isWorkerSafe(toolName: string): boolean;
  shutdown(): Promise<void>;
}

export interface WorkerTaskMessage {
  id: string;
  toolName: string;
  input: unknown;
}

export interface WorkerResultMessage {
  id: string;
  success: boolean;
  result?: string | undefined;
  error?: string | undefined;
}
