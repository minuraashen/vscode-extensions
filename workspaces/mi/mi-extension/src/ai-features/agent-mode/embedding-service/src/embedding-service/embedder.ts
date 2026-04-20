import { requireSemanticNativeModule, importSemanticNativeESMModule } from './native-runtime-bootstrap';

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
    const providers = resolveExecutionProviders();
    console.log(`[Embedder] Platform: ${process.platform}/${process.arch}, ONNX providers: ${providers.join(', ')}`);

    // Patch onnxruntime-node BEFORE loading @xenova/transformers.
    // transformers/src/backends/onnx.js has a static `import * as ONNX_NODE from
    // 'onnxruntime-node'` that runs at module evaluation time. By loading and
    // patching the CJS singleton here first, the patch is already in the module
    // cache when transformers' ESM import evaluates — so InferenceSession.create
    // is our wrapped version for the lifetime of the pipeline() call.
    const ort = requireSemanticNativeModule<any>('onnxruntime-node');
    const _origCreate = ort.InferenceSession.create;
    ort.InferenceSession.create = function (model: unknown, options: Record<string, unknown> = {}) {
        return _origCreate.call(this, model, { ...options, executionProviders: providers });
    };

    try {
      // @xenova/transformers 2.x ships as an ES Module ("type": "module").
      // createRequire (CJS) cannot load ESM packages — use importSemanticNativeESMModule
      // which resolves the entry point from the runtime bundle and calls dynamic import()
      // via a new Function wrapper so webpack does not transform it into require().
      const transformers = await importSemanticNativeESMModule<any>('@xenova/transformers');
      const { pipeline, env, AutoTokenizer } = transformers;

      // modelPath is the models root directory (~/.wso2-mi/copilot/models/).
      // @xenova/transformers resolves model IDs relative to localModelPath, so
      // 'isuruwijesiri/all-MiniLM-L6-v2-code-search-512' maps to
      // localModelPath/isuruwijesiri/all-MiniLM-L6-v2-code-search-512/.
      env.cacheDir = modelPath;
      env.localModelPath = modelPath;
      (env as any).allowRemoteModels = false;

      // Load the quantized ONNX model from the local models directory.
      this.extractor = await pipeline(
        'feature-extraction',
        'isuruwijesiri/all-MiniLM-L6-v2-code-search-512',
        { quantized: true }
      );

      // Initialize tokenizer for accurate token counting.
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
