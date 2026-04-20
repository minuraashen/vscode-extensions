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

import * as vscode from 'vscode';
import { VSCodeEmbeddingService } from './vscode-service';

/**
 * Debounce interval for FS watcher events.
 * Multiple rapid saves on the same file are collapsed into one re-index.
 */
const DEBOUNCE_MS = 2_000;

/**
 * Creates a VSCode FileSystemWatcher scoped to MI XML and source files
 * within a given project path. Change events are forwarded to the
 * embedding service for incremental re-indexing.
 *
 * @param projectPath - Absolute path to the MI project root
 * @param service - The VSCode embedding service instance to notify on changes
 * @returns A Disposable that stops the watcher when disposed
 */
export function createEmbeddingFileWatcher(
    projectPath: string,
    service: VSCodeEmbeddingService
): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    // Pending debounced file paths
    const pendingFiles = new Map<string, NodeJS.Timeout>();

    const scheduleReindex = (filePath: string) => {
        const existing = pendingFiles.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(async () => {
            pendingFiles.delete(filePath);
            try {
                await service.notifyFileChange(filePath);
            } catch (error) {
                console.error(`[EmbeddingWatcher] Failed to reindex ${filePath}:`, error);
            }
        }, DEBOUNCE_MS);
        pendingFiles.set(filePath, timer);
    };

    // Watch XML files (Synapse configs)
    const xmlPattern = new vscode.RelativePattern(projectPath, '**/*.xml');
    const xmlWatcher = vscode.workspace.createFileSystemWatcher(xmlPattern);

    xmlWatcher.onDidChange((uri) => scheduleReindex(uri.fsPath));
    xmlWatcher.onDidCreate((uri) => scheduleReindex(uri.fsPath));
    xmlWatcher.onDidDelete((uri) => scheduleReindex(uri.fsPath));
    disposables.push(xmlWatcher);

    // Watch YAML/properties files (MI configs)
    const configPattern = new vscode.RelativePattern(projectPath, '**/*.{yaml,yml,properties}');
    const configWatcher = vscode.workspace.createFileSystemWatcher(configPattern);

    configWatcher.onDidChange((uri) => scheduleReindex(uri.fsPath));
    configWatcher.onDidCreate((uri) => scheduleReindex(uri.fsPath));
    configWatcher.onDidDelete((uri) => scheduleReindex(uri.fsPath));
    disposables.push(configWatcher);

    // Watch data mapper configs
    const dmcPattern = new vscode.RelativePattern(projectPath, '**/*.dmc');
    const dmcWatcher = vscode.workspace.createFileSystemWatcher(dmcPattern);

    dmcWatcher.onDidChange((uri) => scheduleReindex(uri.fsPath));
    dmcWatcher.onDidCreate((uri) => scheduleReindex(uri.fsPath));
    dmcWatcher.onDidDelete((uri) => scheduleReindex(uri.fsPath));
    disposables.push(dmcWatcher);

    return {
        dispose() {
            // Clear pending debounce timers
            for (const timer of pendingFiles.values()) {
                clearTimeout(timer);
            }
            pendingFiles.clear();
            // Dispose all watchers
            for (const d of disposables) {
                d.dispose();
            }
        },
    };
}
