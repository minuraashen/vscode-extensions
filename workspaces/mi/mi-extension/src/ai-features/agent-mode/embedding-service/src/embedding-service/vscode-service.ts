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
import { ChildProcess, fork } from 'child_process';
import { SQLiteDB } from '../db/sqlite';
import { Embedder } from './embedder';
import { Pipeline } from './pipeline';
import { createEmbeddingFileWatcher } from './vscode-watcher';
import { getCopilotProjectStorageDir } from '../../../storage-paths';
import { getWso2MiModelsDir, isModelDownloaded, downloadModel } from './model-manager';
import {
    configureSemanticNativeRuntimeBootstrap,
    ensureSemanticNativeRuntimeDependencies,
    getSemanticNativeRuntimeFailureReason,
    invalidateSemanticNativeRuntime,
    NativeRuntimeBootstrapConfig,
} from './native-runtime-bootstrap';
import {
    IPC_PROTOCOL_VERSION,
    IpcRequestMethod,
    IpcResponseMessage,
    SemanticSearchResponsePayload,
    WorkerStatusPayload,
    WorkerLogEventPayload,
} from './ipc-types';

const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 30_000;
const WORKER_INIT_TIMEOUT_MS = 15 * 60_000;
const WORKER_RESTART_BASE_DELAY_MS = 1_000;
const WORKER_RESTART_MAX_DELAY_MS = 30_000;
const WORKER_RESTART_MAX_ATTEMPTS = 5;

interface PendingWorkerRequest {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeout: NodeJS.Timeout;
}

/** Re-export for local use — canonical definition lives in ipc-types.ts */
type WorkerStatusSnapshot = WorkerStatusPayload;

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
    private workerProcess: ChildProcess | null = null;
    private workerReady = false;
    private workerRequestSeq = 0;
    private workerPendingRequests = new Map<string, PendingWorkerRequest>();
    private workerRestartAttempts = 0;
    private workerRestartTimer: NodeJS.Timeout | null = null;
    private workerStopRequested = false;
    private workerStatusSnapshot: WorkerStatusSnapshot | null = null;
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

    /** Returns indexed chunk count from active backend (worker or in-process DB). */
    get indexedChunkCount(): number {
        if (this.isWorkerModeActive()) {
            return this.workerStatusSnapshot?.chunkCount ?? 0;
        }
        return this.db?.getChunkCount() ?? 0;
    }

    /** Whether worker-backed query path is currently active. */
    get isWorkerQueryActive(): boolean {
        return this.isWorkerModeActive();
    }

    /**
     * Execute semantic search in the worker process when worker mode is active.
     * Returns null when worker mode is inactive or worker call fails.
     */
    async semanticSearchWithWorker(
        query: string,
        topK: number,
        scoreThreshold: number,
    ): Promise<SemanticSearchResponsePayload | null> {
        if (!this.isWorkerModeActive()) {
            return null;
        }

        try {
            const response = await this.sendWorkerRequest<
                { query: string; topK: number; scoreThreshold: number },
                SemanticSearchResponsePayload
            >(
                'search.semantic',
                { query, topK, scoreThreshold },
            );
            return response;
        } catch (error) {
            console.warn('[EmbeddingService] Worker semantic search failed; fallback to in-process path:', error);
            return null;
        }
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
            const nativeRuntimeConfig = this.getNativeRuntimeBootstrapConfig();
            configureSemanticNativeRuntimeBootstrap(nativeRuntimeConfig);

            this.showStatusBar(
                '$(cloud-download) MI: Downloading dependencies…',
                'Resolving semantic runtime dependencies for this platform'
            );

            const nativeRuntimeReady = await ensureSemanticNativeRuntimeDependencies();
            if (!nativeRuntimeReady) {
                const failureReason = getSemanticNativeRuntimeFailureReason();
                const msg = failureReason
                    ? `Semantic runtime dependencies are unavailable. ${failureReason}`
                    : 'Semantic runtime dependencies are unavailable. Automatic download could not complete for this platform/runtime.';
                console.error(`[EmbeddingService] ${msg}`);
                this._isAvailable = false;
                this._isInitializing = false;
                this.showStatusBar('$(warning) MI: Semantic Runtime Missing', msg);
                this._onReady.fire(false);
                return;
            }

            if (this.useWorkerProcess()) {
                const workerStarted = await this.tryStartWorkerMode();
                if (workerStarted) {
                    this.ensureWorkerModeWatcher();
                    return;
                }

                console.error('[EmbeddingService] Worker mode startup failed; in-process fallback is disabled while worker mode is enabled');
                this._isAvailable = false;
                this._isInitializing = false;
                this.showStatusBar(
                    '$(error) MI: Worker Init Failed',
                    'Semantic worker failed to start. Disable MI.EMBEDDING_WORKER_ENABLED to use in-process mode.'
                );
                this._onReady.fire(false);
                return;
            }

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
            this.pipeline = new Pipeline(this.db, this.embedder);

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

    private async tryStartWorkerMode(): Promise<boolean> {
        this.startWorkerSupervisor();

        if (!this.workerProcess) {
            this.workerReady = false;
            return false;
        }

        try {
            this.showStatusBar('$(sync~spin) MI: Initializing worker…', 'Starting semantic worker process');

            await this.sendWorkerRequest('init', {
                projectPath: this.config.projectPath,
                artifactsSubPath: this.config.artifactsSubPath,
                dbPath: this.config.dbPath,
                modelRootPath: this.config.modelPath,
                pollIntervalMs: this.config.pollIntervalMs,
                maxTokens: this.config.maxTokens,
                nativeRuntime: this.getNativeRuntimeBootstrapConfig(),
            }, WORKER_INIT_TIMEOUT_MS);

            await this.sendWorkerRequest('health', { ping: true });
            const status = await this.sendWorkerRequest<{}, WorkerStatusSnapshot>('status.get', {});

            this.workerReady = status.available;
            this.workerStatusSnapshot = status;
            this._isAvailable = status.available;
            this._isInitializing = status.initializing;

            if (status.available) {
                // Worker is ready — initial indexing may still be running in the
                // background (status.initializing === true). Show the appropriate
                // status bar message based on the current indexing state.
                if (status.initializing) {
                    this.showStatusBar(
                        '$(sync~spin) MI: Indexing…',
                        'Semantic worker ready — building initial index in background'
                    );
                } else {
                    this.showStatusBar(
                        `$(check) MI: Indexed (${status.chunkCount})`,
                        `Semantic worker ready — ${status.chunkCount} chunks indexed`
                    );
                }
                this._onReady.fire(true);
                return true;
            }

            this.showStatusBar(
                '$(warning) MI: Worker Unavailable',
                status.reason || 'Semantic worker is unavailable'
            );
            this._onReady.fire(false);
            return false;
        } catch (error) {
            this.workerReady = false;
            this.workerStatusSnapshot = {
                available: false,
                initializing: false,
                chunkCount: 0,
                projectPath: this.config.projectPath,
                reason: String(error),
            };
            this._isAvailable = false;
            this._isInitializing = false;
            this.showStatusBar('$(warning) MI: Worker Init Failed', `Worker init failed: ${error}`);
            this._onReady.fire(false);
            return false;
        }
    }

    private ensureWorkerModeWatcher(): void {
        if (this.fileWatcher) {
            return;
        }

        try {
            this.fileWatcher = createEmbeddingFileWatcher(
                this.config.projectPath,
                this
            );
        } catch (watcherError) {
            console.warn('[EmbeddingService] File watcher creation failed in worker mode (non-fatal):', watcherError);
        }
    }

    /**
     * Notify the service that a specific file has changed.
     * Triggers an immediate incremental re-index for that file's directory.
     */
    async notifyFileChange(filePath: string): Promise<void> {
        if (this.isWorkerModeActive()) {
            try {
                await this.sendWorkerRequest('notify.fileChange', { filePath });
                return;
            } catch (error) {
                console.warn(`[EmbeddingService] Worker notify.fileChange failed for ${filePath}; falling back to in-process path:`, error);
            }
        }

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
        this.stopWorkerSupervisor();
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

    // ── Worker Supervisor Scaffolding (disabled by default) ───────────

    private useWorkerProcess(): boolean {
        const projectUri = vscode.Uri.file(this.config.projectPath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(projectUri);

        if (workspaceFolder) {
            return vscode.workspace
                .getConfiguration('MI', workspaceFolder.uri)
                .get<boolean>('EMBEDDING_WORKER_ENABLED', true);
        }

        return vscode.workspace
            .getConfiguration('MI')
            .get<boolean>('EMBEDDING_WORKER_ENABLED', true);
    }

    private getNativeRuntimeBootstrapConfig(): NativeRuntimeBootstrapConfig {
        const projectUri = vscode.Uri.file(this.config.projectPath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(projectUri);
        const config = workspaceFolder
            ? vscode.workspace.getConfiguration('MI', workspaceFolder.uri)
            : vscode.workspace.getConfiguration('MI');

        // Only pass runtimeDir if explicitly configured; otherwise let bootstrap code
        // fall back to MI_COPILOT_NATIVE_RUNTIME_DIR environment variable
        const runtimeDirSetting = config.get<string>('semanticRuntime.runtimeDir', '').trim();

        return {
            enabled: config.get<boolean>('semanticRuntime.downloadEnabled', true),
            runtimeDir: runtimeDirSetting || undefined,
            manifestUrl: config.get<string>('semanticRuntime.manifestUrl', ''),
            bundleUrl: config.get<string>('semanticRuntime.bundleUrl', ''),
            bundleSha256: config.get<string>('semanticRuntime.bundleSha256', ''),
        };
    }

    private isWorkerModeActive(): boolean {
        return this.useWorkerProcess() && this.workerReady;
    }

    private getWorkerEntryPath(): string {
        return path.join(__dirname, 'embedding-worker.js');
    }

    private startWorkerSupervisor(): void {
        if (!this.useWorkerProcess() || this.workerProcess) {
            return;
        }

        this.workerStopRequested = false;

        if (this.workerRestartTimer) {
            clearTimeout(this.workerRestartTimer);
            this.workerRestartTimer = null;
        }

        const workerEntry = this.getWorkerEntryPath();
        if (!fs.existsSync(workerEntry)) {
            console.warn(`[EmbeddingService] Worker entry not found: ${workerEntry}`);
            return;
        }

        try {
            this.workerProcess = fork(workerEntry, [], {
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });

            this.workerProcess.stdout?.on('data', (data: Buffer) => {
                const text = data.toString().trim();
                if (text) {
                    console.log(`[EmbeddingWorker:stdout] ${text}`);
                }
            });

            this.workerProcess.stderr?.on('data', (data: Buffer) => {
                const text = data.toString().trim();
                if (text) {
                    console.warn(`[EmbeddingWorker:stderr] ${text}`);
                }
            });

            this.workerProcess.on('message', (raw: unknown) => {
                this.handleWorkerMessage(raw);
            });

            this.workerProcess.on('exit', (code, signal) => {
                this.workerReady = false;
                this.workerProcess = null;
                this._isAvailable = false;
                this._onReady.fire(false);
                this.rejectAllPendingWorkerRequests(
                    new Error(`[EmbeddingService] Worker exited (code=${code}, signal=${signal})`)
                );

                if (!this.workerStopRequested) {
                    this.scheduleWorkerRestart(`exit(code=${code}, signal=${signal})`);
                }
            });

            this.workerProcess.on('error', (error) => {
                console.error('[EmbeddingService] Worker process error:', error);
                if (!this.workerStopRequested) {
                    this.scheduleWorkerRestart(`error(${error.message})`);
                }
            });

            this.workerRestartAttempts = 0;
        } catch (error) {
            console.error('[EmbeddingService] Failed to start worker supervisor:', error);
            this.workerProcess = null;
            this.workerReady = false;
            if (!this.workerStopRequested) {
                this.scheduleWorkerRestart('startup-failure');
            }
        }
    }

    private stopWorkerSupervisor(): void {
        this.workerStopRequested = true;
        this.workerStatusSnapshot = null;

        if (this.workerRestartTimer) {
            clearTimeout(this.workerRestartTimer);
            this.workerRestartTimer = null;
        }

        if (!this.workerProcess) {
            return;
        }

        const proc = this.workerProcess;
        this.workerProcess = null;
        this.workerReady = false;
        this.rejectAllPendingWorkerRequests(
            new Error('[EmbeddingService] Worker supervisor stopped')
        );

        try {
            proc.removeAllListeners('message');
            proc.removeAllListeners('exit');
            proc.removeAllListeners('error');
            proc.kill();
        } catch {
            // Ignore shutdown errors in scaffolding mode
        }
    }

    private scheduleWorkerRestart(reason: string): void {
        if (!this.useWorkerProcess() || this.workerStopRequested) {
            return;
        }

        if (this.workerProcess || this.workerRestartTimer) {
            return;
        }

        if (this.workerRestartAttempts >= WORKER_RESTART_MAX_ATTEMPTS) {
            console.error(
                `[EmbeddingService] Worker restart attempts exceeded (${WORKER_RESTART_MAX_ATTEMPTS}); ` +
                `keeping worker mode disabled for this service lifecycle. Last reason: ${reason}`
            );
            return;
        }

        const attempt = this.workerRestartAttempts + 1;
        const delay = Math.min(
            WORKER_RESTART_BASE_DELAY_MS * Math.pow(2, this.workerRestartAttempts),
            WORKER_RESTART_MAX_DELAY_MS,
        );
        this.workerRestartAttempts = attempt;

        console.warn(
            `[EmbeddingService] Scheduling worker restart attempt ${attempt}/${WORKER_RESTART_MAX_ATTEMPTS} ` +
            `in ${delay}ms (reason: ${reason})`
        );

        this.workerRestartTimer = setTimeout(() => {
            this.workerRestartTimer = null;
            this.tryStartWorkerMode()
                .then((started) => {
                    if (!started) {
                        this.scheduleWorkerRestart('restart-init-failed');
                    }
                })
                .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[EmbeddingService] Worker restart attempt failed: ${message}`);
                    this.scheduleWorkerRestart('restart-init-failed');
                });
        }, delay);
    }

    private handleWorkerMessage(raw: unknown): void {
        if (!raw || typeof raw !== 'object') {
            return;
        }

        const message = raw as Record<string, unknown>;

        // ── Handle event messages from the worker ─────────────────────
        if (message.type === 'event') {
            if (message.method === 'status.changed') {
                const payload = message.payload;
                if (payload && typeof payload === 'object') {
                    const status = payload as Partial<WorkerStatusSnapshot>;
                    const prev = this.workerStatusSnapshot;
                    this.workerStatusSnapshot = {
                        available: typeof status.available === 'boolean' ? status.available : (prev?.available ?? false),
                        initializing: typeof status.initializing === 'boolean' ? status.initializing : (prev?.initializing ?? false),
                        chunkCount: typeof status.chunkCount === 'number' ? status.chunkCount : (prev?.chunkCount ?? 0),
                        projectPath: typeof status.projectPath === 'string' ? status.projectPath : (prev?.projectPath ?? this.config.projectPath),
                        reason: typeof status.reason === 'string' ? status.reason : prev?.reason,
                    };
                    if (typeof status.available === 'boolean') {
                        this.workerReady = status.available;
                    }
                    // Refresh status bar to reflect the latest worker state.
                    // This fires when background indexing completes (initializing
                    // transitions from true → false) or when chunkCount updates.
                    const snap = this.workerStatusSnapshot;
                    if (snap.available && !snap.initializing) {
                        this.showStatusBar(
                            `$(check) MI: Indexed (${snap.chunkCount})`,
                            `Semantic worker ready — ${snap.chunkCount} chunks indexed`
                        );
                    } else if (snap.available && snap.initializing) {
                        this.showStatusBar(
                            '$(sync~spin) MI: Indexing…',
                            'Semantic worker — building initial index in background'
                        );
                    } else if (!snap.available) {
                        this.showStatusBar(
                            '$(warning) MI: Worker Unavailable',
                            snap.reason || 'Semantic worker is unavailable'
                        );
                    }
                }
            } else if (message.method === 'worker.log') {
                const payload = message.payload as WorkerLogEventPayload | undefined;
                if (payload && typeof payload.message === 'string') {
                    const level = payload.level ?? 'info';
                    switch (level) {
                        case 'error':
                            console.error(`[EmbeddingWorker] ${payload.message}`);
                            break;
                        case 'warn':
                            console.warn(`[EmbeddingWorker] ${payload.message}`);
                            break;
                        case 'debug':
                            console.debug(`[EmbeddingWorker] ${payload.message}`);
                            break;
                        default:
                            console.log(`[EmbeddingWorker] ${payload.message}`);
                    }
                }
            } else if (message.method === 'index.progress') {
                // Progress events are informational — update status bar if in worker mode
                const payload = message.payload as Record<string, unknown> | undefined;
                if (payload) {
                    const stage = payload.stage as string;
                    const detail = payload.detail as string;
                    if (stage === 'embedding' || stage === 'updating') {
                        this.showStatusBar(`$(sync~spin) MI: ${stage}…`, detail || 'Worker indexing');
                    } else if (stage === 'complete') {
                        const chunkCount = this.workerStatusSnapshot?.chunkCount ?? 0;
                        this.showStatusBar(
                            `$(check) MI: Indexed (${chunkCount})`,
                            `Semantic worker ready — ${chunkCount} chunks indexed`
                        );
                    }
                }
            }
            return;
        }

        if (message.type !== 'response') {
            return;
        }

        const id = message.id;
        if (typeof id !== 'string') {
            return;
        }

        const pending = this.workerPendingRequests.get(id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.workerPendingRequests.delete(id);

        const response = message as unknown as IpcResponseMessage;
        if (response.ok) {
            pending.resolve(response.payload);
            return;
        }

        const errorMessage = response.error?.message || 'Unknown worker error';
        pending.reject(new Error(errorMessage));
    }

    private rejectAllPendingWorkerRequests(reason: Error): void {
        for (const [, pending] of this.workerPendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(reason);
        }
        this.workerPendingRequests.clear();
    }

    private sendWorkerRequest<TRequest, TResponse>(
        method: IpcRequestMethod,
        payload: TRequest,
        timeoutMs = DEFAULT_WORKER_REQUEST_TIMEOUT_MS,
    ): Promise<TResponse> {
        if (!this.workerProcess || typeof this.workerProcess.send !== 'function') {
            return Promise.reject(new Error('[EmbeddingService] Worker process is not available'));
        }

        const id = `ws-req-${++this.workerRequestSeq}`;

        return new Promise<TResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.workerPendingRequests.delete(id);
                reject(new Error(`[EmbeddingService] Worker request timed out: ${method}`));
            }, timeoutMs);

            this.workerPendingRequests.set(id, {
                resolve: (value: unknown) => resolve(value as TResponse),
                reject,
                timeout,
            });

            try {
                this.workerProcess!.send({
                    v: IPC_PROTOCOL_VERSION,
                    id,
                    ts: Date.now(),
                    type: 'request',
                    method,
                    payload,
                });
            } catch (error) {
                clearTimeout(timeout);
                this.workerPendingRequests.delete(id);
                reject(error);
            }
        });
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
                    '  Native runtime bundle does not match this VS Code runtime.\n' +
                    '  Deleting cached bundle so the next attempt re-downloads the correct one.'
                );
                // Evict the bad bundle so the next start() attempt triggers a fresh download.
                invalidateSemanticNativeRuntime();
                vscode.window.showWarningMessage(
                    'MI Copilot: Semantic search unavailable — runtime binary mismatch. Reloading window will re-download the correct bundle.',
                    'Reload Window'
                ).then(choice => {
                    if (choice === 'Reload Window') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
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
