/**
 * Benchmark: Embedding operations
 *
 * Measures ONNX cold start, warm embedding, cosine similarity,
 * and blob serialization/deserialization.
 */
import { bench, describe } from 'vitest';
import {
  OnnxProvider,
  LocalProvider,
  cosineSimilarity,
  embedToBlob,
  blobToEmbed,
} from '../../src/core/embedding.js';
import { generateText } from './setup.js';

// Pre-generate vectors for similarity/serialization benchmarks
const vecA = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1));
const vecB = Array.from({ length: 384 }, (_, i) => Math.cos(i * 0.1));
const blob = embedToBlob(vecA);

describe('Embedding — LocalProvider', () => {
  const local = new LocalProvider();

  bench('embed short text (50 chars)', async () => {
    await local.embed('Project requires PostgreSQL 16+ for JSONB queries.');
  });

  bench('embed medium text (500 chars)', async () => {
    await local.embed(generateText(500));
  });

  bench('embed long text (5000 chars)', async () => {
    await local.embed(generateText(5000));
  });
});

describe('Embedding — OnnxProvider (multilingual-e5-small)', () => {
  let onnx: OnnxProvider;

  // Cold start measured separately
  bench('cold start — first embed() call', async () => {
    const fresh = new OnnxProvider('multilingual-e5-small');
    await fresh.embed('test');
  }, { iterations: 1, warmupIterations: 0 });

  bench('warm embed short text', async () => {
    if (!onnx) {
      onnx = new OnnxProvider('multilingual-e5-small');
      await onnx.embed('warmup');
    }
    await onnx.embed('Project requires PostgreSQL 16+.');
  });

  bench('warm embed medium text (500 chars)', async () => {
    if (!onnx) {
      onnx = new OnnxProvider('multilingual-e5-small');
      await onnx.embed('warmup');
    }
    await onnx.embed(generateText(500));
  });
});

describe('Embedding — cosineSimilarity', () => {
  bench('384-dim vectors', () => {
    cosineSimilarity(vecA, vecB);
  });

  bench('1024-dim vectors', () => {
    const a = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.1));
    const b = Array.from({ length: 1024 }, (_, i) => Math.cos(i * 0.1));
    cosineSimilarity(a, b);
  });
});

describe('Embedding — blob serialization', () => {
  bench('embedToBlob (384-dim)', () => {
    embedToBlob(vecA);
  });

  bench('blobToEmbed (384-dim)', () => {
    blobToEmbed(blob, 384);
  });

  bench('round-trip (384-dim)', () => {
    blobToEmbed(embedToBlob(vecA), 384);
  });
});
