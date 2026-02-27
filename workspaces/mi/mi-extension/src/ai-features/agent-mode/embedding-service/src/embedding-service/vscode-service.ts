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

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SQLiteDB } from '../db/sqlite';
import { Embedder } from './embedder';
import { Pipeline } from './pipeline';
import { artifactRegistry } from './artifact-registry';
import { createEmbeddingFileWatcher } from './vscode-watcher';
import { getCopilotProjectStorageDir } from '../../../storage-paths';
import { getWso2MiModelsDir, isModelDownloaded, downloadModel } from './model-manager';

/**
 * Configuration for the VSCode-integrated embedding service.
 * Paths are resolved relative to the embedding-service package root.
 */
export interface VSCodeEmbeddingServiceConfig {
    /** Absolute path to the MI project root */
    projectPath: string;
    /** Sub-path within each project to artifacts (e.g. 'src/main/wso2mi/artifacts') */
    artifactsSubPath: string;
    /** Polling interval in milliseconds for incremental re-indexing */
    pollIntervalMs: number;
    /** Maximum tokens per embedding chunk */
    maxTokens: number;
    /** Absolute path to the SQLite database file */
    dbPath: string;
    /** Absolute path to the ONNX model file */
    modelPath: string;
}

/**
 * Resolves default configuration for the VSCode embedding service.
 * Uses the embedding-service package root as the base for model/data/plugins paths.
 */
export function resolveDefaultConfig(projectPath: string): VSCodeEmbeddingServiceConfig {
    return {
        projectPath,
        artifactsSubPath: 'src/main/wso2mi/artifacts',
        pollIntervalMs: 60_000,
        maxTokens: 256,
        // Store embeddings DB in the per-project copilot storage dir, co-located with
        // the chat history. Never written into the user's project directory.
        // ~/.wso2-mi/copilot/projects/<name-hash>/embeddings.db
        dbPath: path.join(getCopilotProjectStorageDir(projectPath), 'embeddings.db'),
        // Root directory for all WSO2 MI models (~/.wso2-mi/models).
        // @xenova/transformers resolves model IDs relative to this path, so
        // 'isuruwijesiri/all-MiniLM-L6-v2-code-search-512' resolves to
        // ~/.wso2-mi/models/isuruwijesiri/all-MiniLM-L6-v2-code-search-512/.
        modelPath: getWso2MiModelsDir(),
    };
}

/** Singleton state per project path */
const activeServices = new Map<string, VSCodeEmbeddingService>();

/**
 * Get or create a singleton embedding service instance for a given project.
 */
export function getEmbeddingService(projectPath: string): VSCodeEmbeddingService {
    const normalized = path.resolve(projectPath);
    let service = activeServices.get(normalized);
    if (!service) {
        service = new VSCodeEmbeddingService(resolveDefaultConfig(normalized));
        activeServices.set(normalized, service);
    }
    return service;
}

/**
 * Dispose the embedding service for a specific project.
 * Call when a workspace folder is removed or closed.
 */
export async function disposeEmbeddingService(projectPath: string): Promise<void> {
    const normalized = path.resolve(projectPath);
    const service = activeServices.get(normalized);
    if (service) {
        await service.stop();
        activeServices.delete(normalized);
        console.log(`[EmbeddingService] Disposed for project: ${normalized}`);
    }
}

/**
 * Dispose all active embedding services. Call on extension deactivation.
 */
export async function disposeAllEmbeddingServices(): Promise<void> {
    for (const [projectPath, service] of activeServices) {
        await service.stop();
        console.log(`[EmbeddingService] Disposed for project: ${projectPath}`);
    }
    activeServices.clear();
}

/**
 * VSCode-Integrated Embedding Service
 *
 * Background service that incrementally indexes MI project XML files within
 * the VSCode extension process. Reuses the existing Pipeline, Embedder, and
 * SQLiteDB components from the standalone embedding-service package.
 *
 * Lifecycle:
 *   1. `start()` — initializes the embedder, runs initial indexing, starts polling.
 *   2. `notifyFileChange(filePath)` — triggers immediate re-index for a single file.
 *   3. `stop()` — cleans up timers and closes resources.
 *
 * Fault tolerance:
 *   - Corrupted DB: logs error, attempts to delete and recreate DB, continues.
 *   - Missing model: logs warning, marks service as unavailable.
 *   - All errors are caught and logged; the service never throws into the caller.
 */
export class VSCodeEmbeddingService {
    private config: VSCodeEmbeddingServiceConfig;
    private db: SQLiteDB | null = null;
    private embedder: Embedder | null = null;
    private pipeline: Pipeline | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private fileWatcher: { dispose(): void } | null = null;
    private _isAvailable = false;
    private _isInitializing = false;
    private _initPromise: Promise<void> | null = null;
    private _statusBarItem: vscode.StatusBarItem | null = null;
    /** Event emitter for ready state changes */
    private _onReady = new vscode.EventEmitter<boolean>();
    /** Fires when the service finishes initialization (true = success, false = failed). */
    public readonly onReady = this._onReady.event;

    constructor(config: VSCodeEmbeddingServiceConfig) {
        this.config = config;
    }

    /** Whether the service is initialized and ready to serve queries. */
    get isAvailable(): boolean {
        return this._isAvailable;
    }

    /** Whether the service is currently initializing. */
    get isInitializing(): boolean {
        return this._isInitializing;
    }

    /**
     * Wait for the service to finish initializing (if in progress).
     * Returns immediately if already available or not initializing.
     * After this resolves, check `isAvailable` to confirm the service started.
     */
    async waitForReady(): Promise<void> {
        if (this._isAvailable) {
            return;
        }
        if (this._initPromise) {
            // Await but don't propagate — _start() handles its own errors.
            try {
                await this._initPromise;
            } catch {
                // Initialization failed — caller should check isAvailable.
            }
        }
    }

    /** Expose the SQLite database handle for query-time access. */
    get database(): SQLiteDB | null {
        return this.db;
    }

    /** Expose the embedder for query-time embedding. */
    get embedderInstance(): Embedder | null {
        return this.embedder;
    }

    /**
     * Start the background embedding service.
     * Safe to call multiple times — subsequent calls return the same init promise.
     * If a previous attempt failed, calling start() again will retry initialization.
     */
    async start(): Promise<void> {
        if (this._isAvailable) {
            return;
        }
        if (this._isInitializing && this._initPromise) {
            return this._initPromise;
        }
        this._isInitializing = true;
        this._initPromise = this._start();
        try {
            await this._initPromise;
        } catch {
            // _start() handles its own errors internally and never throws,
            // but guard against unexpected throws so _isInitializing is reset.
        } finally {
            this._isInitializing = false;
            // If initialization failed, null out _initPromise so the next
            // call to start() will retry instead of returning a stale promise.
            if (!this._isAvailable) {
                this._initPromise = null;
            }
        }
    }

    private async _start(): Promise<void> {
        try {
            // Show status bar indicator while indexing
            this.showStatusBar('$(sync~spin) MI: Indexing…', 'Embedding service is indexing project files');

            // Ensure the DB directory exists (~/.wso2-mi/copilot/projects/<hash>/)
            const dbDir = path.dirname(this.config.dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
                console.log(`[EmbeddingService] Created DB directory: ${dbDir}`);
            }

            // Download model to ~/.wso2-mi/models/ if not already present
            if (!isModelDownloaded()) {
                console.log(`[EmbeddingService] Model not found — starting download to ${this.config.modelPath}`);
                this.showStatusBar('$(cloud-download) MI: Downloading model…',
                    'Downloading embedding model to ~/.wso2-mi/models — this happens once');
                try {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: 'MI Copilot: Downloading embedding model',
                            cancellable: false,
                        },
                        async (progress) => {
                            await downloadModel((fileName, percent) => {
                                progress.report({ message: `${fileName} — ${percent}%` });
                            });
                        }
                    );
                    console.log(`[EmbeddingService] Model downloaded to: ${this.config.modelPath}`);
                } catch (downloadError) {
                    console.error('[EmbeddingService] Model download failed:', downloadError);
                    this.showStatusBar('$(warning) MI: Model Download Failed',
                        `Failed to download embedding model: ${downloadError}`);
                    this._onReady.fire(false);
                    return;
                }
            }

            console.log(`[EmbeddingService] Model ready at: ${this.config.modelPath}`);

            // Initialize DB with recovery
            this.db = this.initializeDB();
            if (!this.db) {
                this.showStatusBar('$(error) MI: DB Error', 'Embedding database initialization failed');
                this._onReady.fire(false);
                return;
            }

            console.log(`[EmbeddingService] Database initialized at: ${this.config.dbPath}`);

            // Initialize embedder
            this.embedder = new Embedder();
            await this.embedder.initialize(this.config.modelPath);

            // Create pipeline
            this.pipeline = new Pipeline(this.db, this.embedder, artifactRegistry);

            // Run initial indexing with detailed staged progress notification
            const dirs = this.getArtifactDirs();
            if (dirs.length > 0) {
                const savedHashes = this.db.getLatestFileHashes();
                const isFirstRun = savedHashes.size === 0;
                const progressTitle = isFirstRun
                    ? 'MI Copilot: Generating embeddings'
                    : 'MI Copilot: Updating embeddings';

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: progressTitle,
                        cancellable: false,
                    },
                    async (progress) => {
                        // Stage 1: Scanning
                        progress.report({ message: 'Scanning project files…' });
                        this.showStatusBar('$(sync~spin) MI: Scanning…', 'Scanning project for artifact files');

                        await this.pipeline!.processInitial(dirs, (stage, detail, fileIndex, totalFiles) => {
                            switch (stage) {
                                case 'scanning':
                                    progress.report({ message: 'Scanning project files…' });
                                    this.showStatusBar('$(sync~spin) MI: Scanning…', detail);
                                    break;
                                case 'embedding': {
                                    // Stage 2: Embedding generation
                                    const pct = totalFiles > 0
                                        ? Math.round((fileIndex / totalFiles) * 100)
                                        : 0;
                                    progress.report({ message: `Generating embeddings — ${detail}` });
                                    this.showStatusBar(
                                        `$(sync~spin) MI: Embedding (${pct}%)`,
                                        `Embedding generation: ${detail}`
                                    );
                                    break;
                                }
                                case 'updating': {
                                    // Stage 3: Storing / updating embeddings in DB
                                    const pct = totalFiles > 0
                                        ? Math.round((fileIndex / totalFiles) * 100)
                                        : 0;
                                    progress.report({ message: `Updating embeddings — ${detail}` });
                                    this.showStatusBar(
                                        `$(sync~spin) MI: Storing (${pct}%)`,
                                        `Embeddings update: ${detail}`
                                    );
                                    break;
                                }
                                case 'complete':
                                    // Stage 4: Done
                                    progress.report({ message: 'Embeddings created ✓' });
                                    break;
                            }
                        });

                        progress.report({ message: 'Embeddings ready ✓' });
                    }
                );
            }

            // Start polling with progress on incremental updates
            this.pollTimer = setInterval(async () => {
                try {
                    const currentDirs = this.getArtifactDirs();
                    if (currentDirs.length > 0 && this.pipeline) {
                        await this.pipeline.processIncremental(currentDirs, (stage, detail) => {
                            if (stage === 'embedding' || stage === 'updating') {
                                this.showStatusBar(
                                    `$(sync~spin) MI: Updating…`,
                                    `Incremental update: ${detail}`
                                );
                            }
                        });
                        // Restore ready status bar after incremental update
                        if (this._isAvailable && this.db) {
                            const count = this.db.getChunkCount();
                            this.showStatusBar(
                                `$(check) MI: Indexed (${count})`,
                                `Semantic search ready — ${count} chunks indexed`
                            );
                        }
                    }
                } catch (error) {
                    console.error('[EmbeddingService] Incremental processing error:', error);
                }
            }, this.config.pollIntervalMs);

            // Start file system watcher for real-time change detection
            try {
                this.fileWatcher = createEmbeddingFileWatcher(
                    this.config.projectPath,
                    this
                );
            } catch (watcherError) {
                console.warn('[EmbeddingService] File watcher creation failed (non-fatal):', watcherError);
            }

            this._isAvailable = true;

            // ── Completion indicator ──────────────────────────────────────
            const chunkCount = this.db.getChunkCount();
            console.log(
                `[EmbeddingService] ✅ Ready for project: ${this.config.projectPath} ` +
                `(${chunkCount} chunks indexed, DB: ${this.config.dbPath})`
            );
            this.showStatusBar(
                `$(check) MI: Indexed (${chunkCount})`,
                `Semantic search ready — ${chunkCount} chunks indexed`
            );
            this._onReady.fire(true);
        } catch (error) {
            console.error('[EmbeddingService] Failed to start:', error);
            this._isAvailable = false;
            this.showStatusBar('$(error) MI: Index Error', `Embedding service failed: ${error}`);
            this._onReady.fire(false);
        }
    }

    /**
     * Notify the service that a specific file has changed.
     * Triggers an immediate incremental re-index for that file's directory.
     */
    async notifyFileChange(filePath: string): Promise<void> {
        if (!this._isAvailable || !this.pipeline) {
            return;
        }
        try {
            const dir = path.dirname(filePath);
            const fileName = path.basename(filePath);
            this.showStatusBar(`$(sync~spin) MI: Updating…`, `Re-indexing: ${fileName}`);
            await this.pipeline.processIncremental([dir], (stage, detail) => {
                if (stage === 'embedding' || stage === 'updating') {
                    this.showStatusBar(`$(sync~spin) MI: Updating…`, detail);
                }
            });
            // Restore ready status
            if (this.db) {
                const count = this.db.getChunkCount();
                this.showStatusBar(
                    `$(check) MI: Indexed (${count})`,
                    `Semantic search ready — ${count} chunks indexed`
                );
            }
        } catch (error) {
            console.error(`[EmbeddingService] Error processing file change for ${filePath}:`, error);
        }
    }

    /**
     * Stop the service and release all resources.
     */
    async stop(): Promise<void> {
        if (this._statusBarItem) {
            this._statusBarItem.dispose();
            this._statusBarItem = null;
        }
        this._onReady.dispose();
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.embedder) {
            await this.embedder.close();
            this.embedder = null;
        }
        if (this.db) {
            try {
                this.db.close();
            } catch {
                // Ignore close errors
            }
            this.db = null;
        }
        this.pipeline = null;
        this._isAvailable = false;
        this._initPromise = null;
    }

    // ── Status Bar Helpers ────────────────────────────────────────────

    private showStatusBar(text: string, tooltip: string): void {
        if (!this._statusBarItem) {
            this._statusBarItem = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Right,
                50
            );
        }
        this._statusBarItem.text = text;
        this._statusBarItem.tooltip = tooltip;
        this._statusBarItem.show();
    }

    /**
     * Initialize SQLite database with corruption recovery.
     * Detects native module ABI mismatches and provides actionable guidance.
     */
    private initializeDB(): SQLiteDB | null {
        console.log(`[EmbeddingService] initializeDB() — dbPath: ${this.config.dbPath}`);
        console.log(`[EmbeddingService] Node version: ${process.version}, ABI: ${process.versions.modules}`);
        try {
            const db = new SQLiteDB(this.config.dbPath);
            console.log(`[EmbeddingService] initializeDB() — SUCCESS`);
            return db;
        } catch (error) {
            const errMsg = (error as any)?.message || '';
            console.error('[EmbeddingService] DB initialization failed — FULL ERROR:', error);
            console.error('[EmbeddingService] Error name:', (error as any)?.name);
            console.error('[EmbeddingService] Error message:', errMsg);
            console.error('[EmbeddingService] Error stack:', (error as any)?.stack);

            // Detect ABI mismatch — the most common cause for native module failures
            if (errMsg.includes('NODE_MODULE_VERSION') || errMsg.includes('was compiled against') ||
                errMsg.includes('module did not self-register') || errMsg.includes('Cannot find module')) {
                console.error(
                    '[EmbeddingService] ⚠️  Native module ABI mismatch detected.\n' +
                    '  better-sqlite3 was compiled for a different Node.js version than VS Code uses.\n' +
                    '  Run: pnpm run rebuild-native\n' +
                    '  This rebuilds native modules for the Electron version used by VS Code.'
                );
                vscode.window.showWarningMessage(
                    'MI Copilot: Semantic search unavailable — native module needs rebuilding. ' +
                    'Run "pnpm run rebuild-native" in the mi-extension directory.',
                    'Show Details'
                ).then(choice => {
                    if (choice === 'Show Details') {
                        vscode.window.showErrorMessage(
                            `better-sqlite3 ABI mismatch: compiled for different Node.js version. ` +
                            `Current: ${process.version} (ABI ${process.versions.modules}). ` +
                            `Error: ${errMsg}`
                        );
                    }
                });
                return null;
            }

            try {
                // Attempt to delete corrupted DB and recreate
                if (fs.existsSync(this.config.dbPath)) {
                    fs.unlinkSync(this.config.dbPath);
                }
                // Also remove WAL and SHM files if present
                const walPath = this.config.dbPath + '-wal';
                const shmPath = this.config.dbPath + '-shm';
                if (fs.existsSync(walPath)) {
                    fs.unlinkSync(walPath);
                }
                if (fs.existsSync(shmPath)) {
                    fs.unlinkSync(shmPath);
                }
                const db2 = new SQLiteDB(this.config.dbPath);
                console.log(`[EmbeddingService] initializeDB() — RECOVERY SUCCESS`);
                return db2;
            } catch (recoveryError) {
                console.error('[EmbeddingService] DB recovery failed — FULL ERROR:', recoveryError);
                console.error('[EmbeddingService] Recovery error message:', (recoveryError as any)?.message);
                return null;
            }
        }
    }

    /**
     * Get artifact directories to scan for the configured project.
     * Scans the project root for directories containing MI artifacts.
     */
    private getArtifactDirs(): string[] {
        const artifactPath = path.join(this.config.projectPath, this.config.artifactsSubPath);
        if (fs.existsSync(artifactPath)) {
            return [artifactPath];
        }
        // Fallback: look in direct subdirectories (multi-module projects)
        const dirs: string[] = [];
        try {
            const entries = fs.readdirSync(this.config.projectPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const subArtifact = path.join(this.config.projectPath, entry.name, this.config.artifactsSubPath);
                    if (fs.existsSync(subArtifact)) {
                        dirs.push(subArtifact);
                    }
                }
            }
        } catch {
            // Ignore directory read errors
        }
        return dirs;
    }
}
