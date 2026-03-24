import { describe, it, expect, vi } from 'vitest';
import {
  LocalProvider,
  OnnxProvider,
  cosineSimilarity,
  embedToBlob,
  blobToEmbed,
  createEmbeddingProvider,
} from './embedding.js';

describe('Embedding', () => {
  describe('LocalProvider (test-only deterministic)', () => {
    it('produces 384-dimensional vectors', async () => {
      const provider = new LocalProvider();
      const vec = await provider.embed('hello world');
      expect(vec).toHaveLength(384);
    });

    it('produces normalized vectors (unit length)', async () => {
      const provider = new LocalProvider();
      const vec = await provider.embed('test input text');
      const magnitude = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 4);
    });

    it('produces deterministic embeddings', async () => {
      const provider = new LocalProvider();
      const a = await provider.embed('same text');
      const b = await provider.embed('same text');
      expect(a).toEqual(b);
    });

    it('produces different embeddings for different text', async () => {
      const provider = new LocalProvider();
      const a = await provider.embed('hello world');
      const b = await provider.embed('goodbye universe');
      expect(a).not.toEqual(b);
    });
  });

  describe('OnnxProvider', () => {
    it('has correct name and dimensions', () => {
      const provider = new OnnxProvider();
      expect(provider.name).toBe('onnx');
      expect(provider.dimensions).toBe(384);
    });

    it('lazy-loads pipeline on first embed (mocked)', async () => {
      const mockPipeline = vi.fn().mockResolvedValue({
        data: new Float32Array(384).fill(0.05),
      });
      const mockPipelineFn = vi.fn().mockResolvedValue(mockPipeline);

      vi.doMock('@huggingface/transformers', () => ({
        pipeline: mockPipelineFn,
        env: { backends: { onnx: {} } },
      }));

      // Use dynamic import after mock
      const { OnnxProvider: FreshOnnx } = await import('./embedding.js');
      const provider = new FreshOnnx();
      const vec = await provider.embed('test');
      expect(vec).toHaveLength(384);

      // Second call should reuse pipeline (singleton)
      await provider.embed('test2');
      // pipeline factory called only once
      expect(mockPipelineFn).toHaveBeenCalledTimes(1);

      vi.doUnmock('@huggingface/transformers');
    });
  });

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      const a = [1, 0, 0];
      expect(cosineSimilarity(a, a)).toBeCloseTo(1);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    });

    it('returns -1 for opposite vectors', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    });

    it('handles mismatched lengths', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('handles zero vectors', () => {
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    });
  });

  describe('BLOB serialization', () => {
    it('round-trips correctly', () => {
      const original = [0.1, -0.5, 0.9, 0, 1, -1];
      const blob = embedToBlob(original);
      const restored = blobToEmbed(blob, original.length);
      expect(restored).toEqual(original);
    });

    it('handles empty vectors', () => {
      const blob = embedToBlob([]);
      const restored = blobToEmbed(blob, 0);
      expect(restored).toEqual([]);
    });
  });

  describe('createEmbeddingProvider', () => {
    it('creates OnnxProvider when type is onnx', () => {
      const provider = createEmbeddingProvider('onnx');
      expect(provider.name).toBe('onnx');
      expect(provider.dimensions).toBe(384);
    });

    it('creates OnnxProvider when type is undefined', () => {
      const provider = createEmbeddingProvider(undefined);
      expect(provider.name).toBe('onnx');
    });

    it('creates OnnxProvider when voyage has no key', () => {
      const provider = createEmbeddingProvider('voyage');
      expect(provider.name).toBe('onnx');
    });

    it('creates VoyageProvider when key provided', () => {
      const provider = createEmbeddingProvider('voyage', 'test-key');
      expect(provider.name).toBe('voyage');
      expect(provider.dimensions).toBe(1024);
    });
  });
});
