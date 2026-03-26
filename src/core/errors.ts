/**
 * Centralized error hierarchy for lynox.
 * Business-friendly error codes + optional structured context.
 */

export class LynoxError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown> | undefined;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'LynoxError';
    this.code = code;
    if (context) this.context = context;
  }
}

/** Input validation failures (bad arguments, schema mismatch, missing fields). */
export class ValidationError extends LynoxError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

/** Configuration errors (missing keys, invalid tiers, schema parse). */
export class ConfigError extends LynoxError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', context);
    this.name = 'ConfigError';
  }
}

/** Runtime execution failures (tool errors, API errors, timeouts). */
export class ExecutionError extends LynoxError {
  constructor(message: string, context?: Record<string, unknown>, options?: { cause?: Error }) {
    super(message, 'EXECUTION_ERROR', context);
    this.name = 'ExecutionError';
    if (options?.cause) this.cause = options.cause;
  }
}

/** Tool-specific errors returned to the LLM as tool_result. */
export class ToolError extends LynoxError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'TOOL_ERROR', context);
    this.name = 'ToolError';
  }
}

/** Resource not found (pipelines, tasks, tenants, processes). */
export class NotFoundError extends LynoxError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', context);
    this.name = 'NotFoundError';
  }
}
