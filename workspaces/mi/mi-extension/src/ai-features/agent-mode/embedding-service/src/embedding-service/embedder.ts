import type { FeatureExtractionPipeline, PreTrainedTokenizer } from '@huggingface/transformers';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';

// onnxruntime-web's WASM CPU backend always calls the global fetch() to load
// the ONNX model, even in Node. Transformers.js v4.1.0 passes it an absolute
// filesystem path (because `apis.IS_NODE_ENV` is true and is frozen, so we can't
// flip it from the outside). Node's undici fetch rejects bare paths and file:
// URLs with "Invalid URL" / unsupported scheme. Shim fetch once, at the top of
// the worker module, to resolve absolute paths and file: URLs from disk. Only
// the worker evaluates this file; the host process is unaffected.
const fetchShimInstalled = Symbol.for('mi-embedding-worker.fetchShim');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g[fetchShimInstalled]) {
  const originalFetch: typeof fetch = g.fetch;
  g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;
    let filePath: string | undefined;
    if (typeof url === 'string') {
      if (url.startsWith('file:')) {
        filePath = fileURLToPath(url);
      } else if (path.isAbsolute(url)) {
        filePath = url;
      }
    }
    if (filePath) {
      const buf = await fs.promises.readFile(filePath);
      // Response() accepts typed arrays at runtime (Node 22, browser), but the
      // older lib.dom.d.ts bundled with this project's tsc narrows BodyInit to
      // exclude Uint8Array. Cast through unknown to appease the compiler.
      const body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) as unknown as BodyInit;
      return new Response(body);
    }
    return originalFetch(input, init);
  };
  g[fetchShimInstalled] = true;
}

/**
 * Embedder class for generating embeddings using @huggingface/transformers.js
 * 
 * Architecture:
 * - Uses WASM-based ONNX Runtime (onnxruntime-web via transformers.js)
 * - NO native onnxruntime-node dependency
 * - NO CDN or remote model loading
 * - All model files cached locally at ~/.wso2-mi/copilot/models/
 * - WASM runtime bundled into extension via webpack
 * 
 * Model: isuruwijesiri/all-MiniLM-L6-v2-code-search-512
 *   - 384-dimensional embeddings
 *   - Quantized (q8) for smaller file size
 * 
 * WASM Handling:
 *   - Webpack config includes asyncWebAssembly experiment
 *   - .wasm files in @huggingface/transformers are bundled to dist/
 *   - WASM cache stored at ~/.wso2-mi/copilot/models/.onnx-wasm-cache
 *   - Fully offline-capable - no external dependencies
 */

export class Embedder {
  private extractor: FeatureExtractionPipeline | null = null;
  private tokenizer: PreTrainedTokenizer | null = null;

  async initialize(modelPath: string): Promise<void> {
    console.log(`[Embedder] Initializing embedder with WASM-based ONNX Runtime`);
    console.log(`[Embedder] Model cache path: ${modelPath}`);

    try {
      // Verify model directory structure
      const modelDir = path.join(modelPath, 'isuruwijesiri', 'all-MiniLM-L6-v2-code-search-512');
      if (!fs.existsSync(modelDir)) {
        throw new Error(`Model directory not found at: ${modelDir}`);
      }
      console.log(`[Embedder] Model directory verified`);

      // In the packaged extension, sharp's native binary is unavailable and its
      // webpack bundle module throws on first evaluation. Requiring it inside a
      // try-catch here causes webpack to cache the module with empty exports ({})
      // rather than re-throwing on subsequent requires. @huggingface/transformers
      // requires sharp at its top level but only calls into it for image pipelines;
      // text-only feature-extraction never reaches those code paths.
      try { require('sharp'); } catch { /* expected: sharp binary not available in packaged extension */ }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformers = require('@huggingface/transformers');
      const { pipeline, env, AutoTokenizer } = transformers;

      console.log(`[Embedder] Transformers.js loaded successfully`);

      // Force webpack to emit onnxruntime-web's WASM wrapper + binary to dist/
      // (resolved via synthetic aliases in webpack.config.js). The require()
      // calls are what trigger emission via `asset/resource`; their return
      // values are asset URLs that we don't need to use directly — wasmPaths
      // below points to dist/ and onnxruntime-web appends the file names itself.
      /* eslint-disable @typescript-eslint/no-require-imports */
      require('ort-wasm-jsep-mjs');
      require('ort-wasm-jsep-wasm');
      /* eslint-enable @typescript-eslint/no-require-imports */

      // Model cache paths — @huggingface/transformers resolves model IDs relative to localModelPath
      env.cacheDir = modelPath;
      env.localModelPath = modelPath;
      (env as any).allowRemoteModels = false;

      // Point onnxruntime-web at the WASM files emitted into dist/. Using a
      // file:// base URL makes its internal URL resolver build
      // `file:///…/dist/ort-wasm-simd-threaded.jsep.mjs`, which Node's ESM
      // loader accepts — sidestepping the fetch→Blob→import(blob:…) path
      // that throws ERR_UNSUPPORTED_ESM_URL_SCHEME in Node. Trailing slash
      // is required: onnxruntime-web treats wasmPaths as a base URL and
      // appends file names to it.
      const onnxBackend = (env as any).backends?.onnx;
      if (onnxBackend?.wasm) {
        onnxBackend.wasm.wasmPaths = pathToFileURL(__dirname).href + '/';
        onnxBackend.wasm.proxy = false;
        onnxBackend.wasm.numThreads = 1;
        console.log(`[Embedder] ORT wasm paths: ${onnxBackend.wasm.wasmPaths}`);
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // Load Model with WASM Backend
      // ═══════════════════════════════════════════════════════════════════════════
      
      console.log(`[Embedder] Loading feature-extraction pipeline...`);

      // Load the local embedding model from the cache
      // This will use WASM-based ONNX Runtime (transformers.js default for Node.js)
      // No external dependencies or CDN calls
      this.extractor = await pipeline(
        'feature-extraction',
        'isuruwijesiri/all-MiniLM-L6-v2-code-search-512',
        { dtype: 'q8' }
      );
      console.log(`[Embedder] Pipeline loaded successfully`);

      // Initialize tokenizer for accurate token counting
      console.log(`[Embedder] Loading tokenizer...`);
      this.tokenizer = await AutoTokenizer.from_pretrained('isuruwijesiri/all-MiniLM-L6-v2-code-search-512');
      console.log(`[Embedder] Tokenizer loaded successfully`);
      
      console.log(`[Embedder] Initialization complete - ready for embeddings`);
    } catch (e) {
      console.error('[Embedder] Initialization failed:', e);
      if (e instanceof Error) {
        console.error('[Embedder] Error details:', e.message);
        console.error('[Embedder] Stack trace:', e.stack);
      }
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
