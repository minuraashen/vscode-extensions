import { pipeline, env, AutoTokenizer } from '@xenova/transformers';

/**
 * Detect the best available ONNX execution providers for the current platform.
 *
 * - macOS (any arch): CoreML provider. On Apple Silicon this maps to Metal
 *   Performance Shaders (MPS) + Neural Engine. On Intel Macs it uses the
 *   CoreML hardware-accelerated inference stack. 'cpu' is always appended as
 *   the fallback so ORT can use CPU for ops not supported by CoreML.
 *
 * - Linux / Windows: 'cpu' only. CUDA acceleration requires onnxruntime-gpu
 *   which is not the standard onnxruntime-node package. If the host has a
 *   CUDA-capable GPU and onnxruntime-gpu installed, add 'cuda' here.
 */
function resolveExecutionProviders(): string[] {
    if (process.platform === 'darwin') {
        return ['coreml', 'cpu'];
    }
    return ['cpu'];
}

export class Embedder {
  private extractor: any = null;
  private tokenizer: any = null;

  async initialize(modelPath: string): Promise<void> {
    // modelPath is the models root directory (e.g. .../embedding-service/models/).
    // @xenova/transformers resolves model IDs by appending the org/model name,
    // so 'isuruwijesiri/all-MiniLM-L6-v2-code-search-512' resolves to
    // models/isuruwijesiri/all-MiniLM-L6-v2-code-search-512/.
    env.cacheDir = modelPath;
    env.localModelPath = modelPath;
    // Prevent the library from attempting to download models from HuggingFace Hub.
    (env as any).allowRemoteModels = false;

    const providers = resolveExecutionProviders();
    console.log(`[Embedder] Platform: ${process.platform}/${process.arch}, ONNX providers: ${providers.join(', ')}`);

    // @xenova/transformers uses a module-level `executionProviders` array in
    // backends/onnx.js that is not part of the public API. The only reliable
    // way to inject custom providers is to temporarily wrap InferenceSession.create
    // on the shared onnxruntime-node CJS module. Because onnxruntime-node is a CJS
    // package, Node.js uses the same module-cache entry for both `require()` calls
    // (from this bundle) and ESM imports (from @xenova/transformers), so patching
    // InferenceSession.create here affects the exact same object that models.js uses.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ort = require('onnxruntime-node');
    const _origCreate = ort.InferenceSession.create;
    ort.InferenceSession.create = function (model: unknown, options: Record<string, unknown> = {}) {
        return _origCreate.call(this, model, { ...options, executionProviders: providers });
    };

    try {
      // Load the quantized ONNX model from the local models directory.
      this.extractor = await pipeline(
        'feature-extraction',
        'isuruwijesiri/all-MiniLM-L6-v2-code-search-512',
        {
          quantized: true // Use model_quantized.onnx (smaller, faster)
        }
      );

      // Initialize tokenizer for accurate token counting
      this.tokenizer = await AutoTokenizer.from_pretrained('isuruwijesiri/all-MiniLM-L6-v2-code-search-512');
    } finally {
      // Always restore InferenceSession.create to avoid affecting other ORT users.
      ort.InferenceSession.create = _origCreate;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) {
      throw new Error('Embedder not initialized');
    }

    // Use the pipeline with mean pooling and normalization
    const result = await this.extractor(text, {
      pooling: 'mean',
      normalize: true
    });

    // Convert to Float32Array for consistency with our database
    return new Float32Array(Array.from(result.data));
  }

  /**
   * Count tokens using the actual model's tokenizer
   * @param text Text to tokenize (XML content + metadata)
   * @returns Accurate token count
   */
  countTokens(text: string): number {
    if (!this.tokenizer) {
      throw new Error('Tokenizer not initialized');
    }
    const tokens = this.tokenizer.encode(text);
    return tokens.length;
  }

  async close(): Promise<void> {
    this.extractor = null;
    this.tokenizer = null;
  }
}
