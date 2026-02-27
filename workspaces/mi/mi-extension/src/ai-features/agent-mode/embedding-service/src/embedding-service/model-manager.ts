/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL_ORG = 'isuruwijesiri';
const MODEL_NAME = 'all-MiniLM-L6-v2-code-search-512';
const MODEL_ID = `${MODEL_ORG}/${MODEL_NAME}`;

/**
 * Files that must be present for the model to be considered fully downloaded.
 * Paths are relative to the model root directory.
 *
 * @xenova/transformers resolves these relative to localModelPath/<org>/<model>/:
 *   - config.json, tokenizer_config.json, tokenizer.json, vocab.txt  (root)
 *   - onnx/model_quantized.onnx                                       (quantized ONNX)
 *
 * All of these exist in the HuggingFace repo under both the root and onnx/ folder.
 * We download the root-level copies that @xenova/transformers looks for by default.
 */
const REQUIRED_MODEL_FILES = [
    'config.json',
    'tokenizer_config.json',
    'tokenizer.json',
    'vocab.txt',
    path.join('onnx', 'model_quantized.onnx'),
];

const HF_BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;

// ─── Path Helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the root directory for all WSO2 MI models.
 * ~/.wso2-mi/models
 */
export function getWso2MiModelsDir(): string {
    return path.join(os.homedir(), '.wso2-mi', 'models');
}

/**
 * Returns the directory where the embedding model is stored.
 * ~/.wso2-mi/models/isuruwijesiri/all-MiniLM-L6-v2-code-search-512
 *
 * This is used as env.localModelPath by @xenova/transformers so it can
 * resolve model files by their relative paths (e.g. onnx/model_quantized.onnx).
 */
export function getLocalModelDir(): string {
    return path.join(getWso2MiModelsDir(), MODEL_ORG, MODEL_NAME);
}

// ─── State Check ──────────────────────────────────────────────────────────────

/**
 * Returns true if all required model files are present on disk.
 */
export function isModelDownloaded(): boolean {
    const modelDir = getLocalModelDir();
    return REQUIRED_MODEL_FILES.every(f => fs.existsSync(path.join(modelDir, f)));
}

// ─── Download ─────────────────────────────────────────────────────────────────

export type ModelDownloadProgressCallback = (fileName: string, percent: number) => void;

/**
 * Downloads the embedding model files from HuggingFace into ~/.wso2-mi/models/.
 *
 * Uses only Node.js built-ins (https, fs) — no extra npm dependencies.
 * Each file is written to a temporary .part file first, then renamed on
 * success, so a failed download never leaves a corrupt partial file behind.
 *
 * @param onProgress - Optional callback called periodically with (fileName, percent 0-100)
 * @throws If any file download fails (partial .part file is cleaned up before throwing)
 */
export async function downloadModel(onProgress?: ModelDownloadProgressCallback): Promise<void> {
    const modelDir = getLocalModelDir();

    // Ensure all required directories exist
    fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });

    for (const relativePath of REQUIRED_MODEL_FILES) {
        const destPath = path.join(modelDir, relativePath);

        // Skip files that already exist (resume-friendly)
        if (fs.existsSync(destPath)) {
            onProgress?.(relativePath, 100);
            continue;
        }

        const url = `${HF_BASE_URL}/${relativePath.replace(/\\/g, '/')}`;
        console.log(`[ModelManager] Downloading: ${url}`);

        await downloadFile(url, destPath, (percent) => {
            onProgress?.(relativePath, percent);
        });

        console.log(`[ModelManager] Saved: ${destPath}`);
    }
}

/**
 * Download a single file via HTTPS with progress reporting.
 * Writes to a .part temp file, renames to final path on completion.
 */
function downloadFile(
    url: string,
    destPath: string,
    onProgress?: (percent: number) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const partPath = destPath + '.part';
        const fileStream = fs.createWriteStream(partPath);

        const cleanup = (err: Error) => {
            fileStream.destroy();
            try { fs.unlinkSync(partPath); } catch { /* ignore */ }
            reject(err);
        };

        const request = (reqUrl: string) => {
            https.get(reqUrl, { headers: { 'User-Agent': 'wso2-mi-vscode-extension' } }, (res) => {
                // Follow redirects (HuggingFace issues both relative and absolute redirects)
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); // Consume response to free socket
                    const location = res.headers.location;
                    // Resolve relative redirect paths against the HuggingFace base origin
                    const nextUrl = location.startsWith('/')
                        ? `https://huggingface.co${location}`
                        : location;
                    request(nextUrl);
                    return;
                }

                if (res.statusCode !== 200) {
                    cleanup(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                    return;
                }

                const totalBytes = parseInt(res.headers['content-length'] ?? '0', 10);
                let downloadedBytes = 0;
                let lastReportedPercent = -1;

                res.on('data', (chunk: Buffer) => {
                    downloadedBytes += chunk.length;
                    if (totalBytes > 0) {
                        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                        if (percent !== lastReportedPercent) {
                            lastReportedPercent = percent;
                            onProgress?.(percent);
                        }
                    }
                });

                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close(() => {
                        try {
                            fs.renameSync(partPath, destPath);
                            onProgress?.(100);
                            resolve();
                        } catch (renameErr) {
                            cleanup(renameErr as Error);
                        }
                    });
                });

                res.on('error', cleanup);
                fileStream.on('error', cleanup);
            }).on('error', cleanup);
        };

        request(url);
    });
}
