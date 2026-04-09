/** Shared numeric constants used across multiple core modules. */

/** Max buffer for single-file reads and bash output (10 MB). */
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Private directory permissions (owner rwx only). */
export const DIR_MODE_PRIVATE = 0o700;

/** Private file permissions (owner rw only). */
export const FILE_MODE_PRIVATE = 0o600;

/** Default bash command timeout (2 minutes). */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
