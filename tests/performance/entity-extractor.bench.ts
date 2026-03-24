/**
 * Benchmark: Entity extraction (Tier 1 regex)
 *
 * Measures regex-based entity extraction throughput on
 * different text sizes and content types.
 */
import { bench, describe } from 'vitest';
import { extractEntitiesRegex } from '../../src/core/entity-extractor.js';
import { generateEntityText, generateText } from './setup.js';

const entityRichText = generateEntityText();
const shortText = 'Client Thomas from Zürich uses PostgreSQL.';
const mediumText = generateEntityText() + '\n' + generateEntityText();
const largeText = Array.from({ length: 10 }, () => generateEntityText()).join('\n');
const plainText = generateText(2000);

describe('Entity Extraction — regex tier', () => {
  bench('short text (1 sentence)', () => {
    extractEntitiesRegex(shortText);
  });

  bench('medium text (~1KB, entity-rich)', () => {
    extractEntitiesRegex(entityRichText);
  });

  bench('large text (~10KB, entity-rich)', () => {
    extractEntitiesRegex(largeText);
  });

  bench('plain text (2KB, no entities)', () => {
    extractEntitiesRegex(plainText);
  });

  bench('double text (~2KB, repeated entities)', () => {
    extractEntitiesRegex(mediumText);
  });
});
