import type { RowStamp } from '../../src/core/data-store.js';

/**
 * The stamp for a test write whose source does not matter to the test: a writer whose
 * conversation resolved nothing, written by no known author from a clean turn. Tests about
 * the stamp itself build their own.
 */
export const TEST_STAMP: RowStamp = { grants: [], runId: null, writtenBy: null, untrusted: false };
