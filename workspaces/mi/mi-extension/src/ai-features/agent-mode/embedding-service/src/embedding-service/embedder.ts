import { pipeline, env, AutoTokenizer, FeatureExtractionPipeline, PreTrainedTokenizer } from '@huggingface/transformers';
import * as path from 'path';

export class Embedder {
  private extractor: FeatureExtractionPipeline | null = null;
  private tokenizer: PreTrainedTokenizer | null = null;

  async initialize(modelPath: string): Promise<void> {
    console.log(`[Embedder] Initializing pure JS embedder`);

    try {
      // modelPath is the models root directory (~/.wso2-mi/copilot/models/).
      env.cacheDir = modelPath;
      env.localModelPath = modelPath;
      (env as any).allowRemoteModels = false;
      // We don't need onnxruntime-node because transformers.js uses onnxruntime-web (WASM) by default.
      // And we can specify backends if needed, but defaults are fine.

      // Load the quantized ONNX model from the local models directory.
        this.extractor = await pipeline(
        'feature-extraction',
        'isuruwijesiri/all-MiniLM-L6-v2-code-search-512',
        { dtype: 'q8' }
      );

      // Initialize tokenizer for accurate token counting.
      this.tokenizer = await AutoTokenizer.from_pretrained('isuruwijesiri/all-MiniLM-L6-v2-code-search-512');
    } catch (e) {
      console.error('[Embedder] Initialization failed', e);
      throw e;
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
    if (this.extractor) {
      this.extractor.dispose();
      this.extractor = null;
    }
    this.tokenizer = null;
  }
}
