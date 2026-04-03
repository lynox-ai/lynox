export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

/**
 * Deterministic hash-based embedding provider for testing.
 * Not suitable for real semantic search — use OnnxProvider instead.
 */
export class LocalProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly dimensions = 384;

  async embed(text: string): Promise<number[]> {
    const vec = new Float64Array(this.dimensions);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      for (let j = 0; j < word.length; j++) {
        const charCode = word.charCodeAt(j);
        const idx = (charCode * 31 + j * 17 + i * 7) % this.dimensions;
        vec[idx] = (vec[idx] ?? 0) + 1;
      }
    }

    let magnitude = 0;
    for (let i = 0; i < this.dimensions; i++) {
      magnitude += (vec[i] ?? 0) ** 2;
    }
    magnitude = Math.sqrt(magnitude);
    if (magnitude === 0) magnitude = 1;

    const result: number[] = [];
    for (let i = 0; i < this.dimensions; i++) {
      result.push((vec[i] ?? 0) / magnitude);
    }
    return result;
  }
}

/** Supported ONNX embedding models with their HuggingFace IDs and dimensions. */
export type OnnxModelId = 'all-minilm-l6-v2' | 'multilingual-e5-small' | 'bge-m3';

interface OnnxModelConfig {
  huggingFaceId: string;
  dimensions: number;
  multilingual: boolean;
}

export const ONNX_MODEL_REGISTRY: Record<OnnxModelId, OnnxModelConfig> = {
  'all-minilm-l6-v2': {
    huggingFaceId: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
    multilingual: false,
  },
  'multilingual-e5-small': {
    huggingFaceId: 'Xenova/multilingual-e5-small',
    dimensions: 384,
    multilingual: true,
  },
  'bge-m3': {
    huggingFaceId: 'Xenova/bge-m3',
    dimensions: 1024,
    multilingual: true,
  },
};

/**
 * ONNX embedding provider using @huggingface/transformers (WASM runtime).
 * Supports multiple models via model registry.
 * Lazy-loads pipeline on first embed() call.
 *
 * Default: multilingual-e5-small (384d, 100 languages, ~118MB quantized).
 */
export class OnnxProvider implements EmbeddingProvider {
  readonly name = 'onnx';
  readonly dimensions: number;
  private readonly modelId: OnnxModelId;
  private readonly huggingFaceId: string;
  private pipeline: unknown | null = null;
  private loading: Promise<unknown> | null = null;

  constructor(model?: OnnxModelId | undefined) {
    this.modelId = model ?? 'multilingual-e5-small';
    const config = ONNX_MODEL_REGISTRY[this.modelId];
    this.dimensions = config.dimensions;
    this.huggingFaceId = config.huggingFaceId;
  }

  private async _getPipeline(): Promise<unknown> {
    if (this.pipeline) return this.pipeline;
    if (!this.loading) {
      this.loading = (async () => {
        const mod = await import('@huggingface/transformers');
        // Redirect model cache to writable dir (container root fs may be read-only).
        if (mod.env) {
          (mod.env as Record<string, unknown>)['cacheDir'] =
            process.env['HF_HOME'] ?? `${process.env['HOME'] ?? '/tmp'}/.cache/huggingface`;
        }
        // Alpine uses gcompat for glibc compat — onnxruntime-node works natively.
        const pipe = await mod.pipeline('feature-extraction', this.huggingFaceId, {
          dtype: 'fp32',
        });
        this.pipeline = pipe;
        return pipe;
      })();
    }
    return this.loading;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this._getPipeline() as (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }
}

/**
 * Create an embedding provider based on config.
 */
export function createEmbeddingProvider(
  type: 'onnx' | 'local' | undefined,
  model?: OnnxModelId | undefined,
): EmbeddingProvider {
  if (type === 'local') {
    return new LocalProvider();
  }
  return new OnnxProvider(model);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) ** 2;
    magB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize embedding to Buffer for SQLite BLOB storage.
 */
export function embedToBlob(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 8);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeDoubleBE(embedding[i] ?? 0, i * 8);
  }
  return buf;
}

/**
 * Deserialize embedding from SQLite BLOB.
 */
export function blobToEmbed(blob: Buffer, dimensions: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    result.push(blob.readDoubleBE(i * 8));
  }
  return result;
}
