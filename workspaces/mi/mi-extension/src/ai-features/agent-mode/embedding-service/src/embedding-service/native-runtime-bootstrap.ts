import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import axios from 'axios';
import AdmZip from 'adm-zip';

const REQUIRED_MODULES = [
    'better-sqlite3',
    'onnxruntime-node',
    '@xenova/transformers',
];

let bootstrapPromise: Promise<boolean> | null = null;
let runtimeNodeModulesPath: string | null = null;
let lastBootstrapFailureReason: string | null = null;

export interface NativeRuntimeBootstrapConfig {
    enabled?: boolean;
    runtimeDir?: string;
    manifestUrl?: string;
    bundleUrl?: string;
    bundleSha256?: string;
}

interface NativeRuntimeBundleManifestEntry {
    url: string;
    sha256?: string;
}

interface NativeRuntimeBundleManifest {
    bundles?: Record<string, NativeRuntimeBundleManifestEntry>;
}

const DEFAULT_NATIVE_RUNTIME_MANIFEST_URL =
    'https://github.com/minuraashen/vscode-extensions/releases/download/mi-native-runtime-1.0.0/manifest.json';

const runtimeConfig: NativeRuntimeBootstrapConfig = {};

export function configureSemanticNativeRuntimeBootstrap(config?: NativeRuntimeBootstrapConfig): void {
    const newEnabled = config?.enabled;
    const newRuntimeDir = config?.runtimeDir?.trim();
    const newManifestUrl = config?.manifestUrl?.trim();
    const newBundleUrl = config?.bundleUrl?.trim();
    const newBundleSha256 = config?.bundleSha256?.trim();

    // Only invalidate cached bootstrap state when something actually changed.
    // Mode toggles (worker ↔ in-process) call this with the same config, so
    // preserving the state avoids redundant re-checks and keeps runtimeNodeModulesPath set.
    const changed =
        newEnabled !== runtimeConfig.enabled ||
        newRuntimeDir !== runtimeConfig.runtimeDir ||
        newManifestUrl !== runtimeConfig.manifestUrl ||
        newBundleUrl !== runtimeConfig.bundleUrl ||
        newBundleSha256 !== runtimeConfig.bundleSha256;

    runtimeConfig.enabled = newEnabled;
    runtimeConfig.runtimeDir = newRuntimeDir;
    runtimeConfig.manifestUrl = newManifestUrl;
    runtimeConfig.bundleUrl = newBundleUrl;
    runtimeConfig.bundleSha256 = newBundleSha256;

    if (changed) {
        bootstrapPromise = null;
        runtimeNodeModulesPath = null;
        lastBootstrapFailureReason = null;
    }
}

function setFailureReason(reason: string): void {
    lastBootstrapFailureReason = reason;
}

function clearFailureReason(): void {
    lastBootstrapFailureReason = null;
}

/**
 * Invalidate cached bootstrap state and delete the on-disk runtime bundle.
 *
 * Call this when a native module load fails due to an ABI mismatch.
 * The next call to ensureSemanticNativeRuntimeDependencies() will
 * re-download a fresh bundle rather than reusing the bad one.
 */
export function invalidateSemanticNativeRuntime(): void {
    bootstrapPromise = null;
    runtimeNodeModulesPath = null;
    lastBootstrapFailureReason = null;

    const runtimeDir = path.join(getRuntimeRootDir(), getRuntimeKey());
    try {
        if (fs.existsSync(runtimeDir)) {
            fs.rmSync(runtimeDir, { recursive: true, force: true });
            console.log('[NativeRuntime] Deleted cached runtime bundle (ABI mismatch); will re-download on next attempt');
        }
    } catch (e) {
        console.warn('[NativeRuntime] Could not delete cached runtime bundle:', e);
    }
}

export function getSemanticNativeRuntimeFailureReason(): string | undefined {
    return lastBootstrapFailureReason ?? undefined;
}

function tryCreateRuntimeRequire(nodeModulesDir: string): NodeRequire | null {
    try {
        return createRequire(path.join(nodeModulesDir, '__mi-semantic-runtime-loader__.js'));
    } catch {
        return null;
    }
}

function getEffectiveBoolean(
    configValue: boolean | undefined,
    envName: string,
    defaultValue: boolean,
): boolean {
    if (typeof configValue === 'boolean') {
        return configValue;
    }
    const envValue = process.env[envName];
    if (typeof envValue === 'string' && envValue.length > 0) {
        return envValue.toLowerCase() === 'true';
    }
    return defaultValue;
}

function getEffectiveString(configValue: string | undefined, envName: string): string | undefined {
    if (typeof configValue === 'string' && configValue.length > 0) {
        return configValue;
    }
    const envValue = process.env[envName]?.trim();
    return envValue && envValue.length > 0 ? envValue : undefined;
}

function getDefaultManifestUrl(): string {
    const envValue = process.env.MI_COPILOT_NATIVE_BUNDLE_MANIFEST_URL?.trim();
    if (envValue && envValue.length > 0) {
        return envValue;
    }

    return DEFAULT_NATIVE_RUNTIME_MANIFEST_URL;
}

function getRuntimeRootDir(): string {
    const explicitDir = getEffectiveString(runtimeConfig.runtimeDir, 'MI_COPILOT_NATIVE_RUNTIME_DIR');
    if (explicitDir) {
        return path.resolve(explicitDir);
    }
    return path.join(os.homedir(), '.wso2-mi', 'copilot', 'native-runtime');
}

function getRuntimeKey(): string {
    const electronVersion = process.versions.electron || 'unknown';
    return `${process.platform}-${process.arch}-electron-${electronVersion}`;
}

function hasRequiredModulesIn(baseNodeModulesDir: string): boolean {
    return REQUIRED_MODULES.every((moduleName) => {
        const moduleDir = path.join(baseNodeModulesDir, moduleName);
        return fs.existsSync(path.join(moduleDir, 'package.json'));
    });
}

function tryResolveAllModules(): boolean {
    return REQUIRED_MODULES.every((moduleName) => {
        try {
            require.resolve(`${moduleName}/package.json`);
            return true;
        } catch {
            return false;
        }
    });
}

function registerNodeModulesPath(nodeModulesDir: string): void {
    if (!fs.existsSync(nodeModulesDir)) {
        return;
    }

    const resolved = path.resolve(nodeModulesDir);
    const delimiter = path.delimiter;
    const existing = process.env.NODE_PATH || '';
    const parts = existing.split(delimiter).filter(Boolean);
    if (!parts.includes(resolved)) {
        process.env.NODE_PATH = existing ? `${resolved}${delimiter}${existing}` : resolved;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('module');
    const globalPaths: string[] = Module.globalPaths;
    if (!globalPaths.includes(resolved)) {
        globalPaths.unshift(resolved);
    }
    if (typeof Module._initPaths === 'function') {
        Module._initPaths();
    }
}

function inferExtractRoot(extractDir: string): string {
    const directNodeModules = path.join(extractDir, 'node_modules');
    if (fs.existsSync(directNodeModules)) {
        return extractDir;
    }

    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const subDirs = entries.filter((entry) => entry.isDirectory());
    if (subDirs.length === 1) {
        const candidate = path.join(extractDir, subDirs[0].name);
        if (fs.existsSync(path.join(candidate, 'node_modules'))) {
            return candidate;
        }
    }

    return extractDir;
}

function verifySha256(filePath: string, expectedSha256: string): void {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    const actual = hash.digest('hex');
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new Error(`Native runtime bundle checksum mismatch (expected ${expectedSha256}, got ${actual})`);
    }
}

function validateRuntimeMetadata(runtimeDir: string): boolean {
    const metadataPath = path.join(runtimeDir, 'runtime-metadata.json');
    if (!fs.existsSync(metadataPath)) {
        return false;
    }

    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        const expectedElectronVersion = process.versions.electron || 'unknown';
        if (metadata.electronVersion !== expectedElectronVersion) {
            console.warn(
                `[NativeRuntime] Runtime metadata Electron version mismatch: ` +
                `expected ${expectedElectronVersion}, got ${metadata.electronVersion}. ` +
                `Will re-download correct version.`
            );
            return false;
        }
        return true;
    } catch (e) {
        console.warn('[NativeRuntime] Failed to validate runtime metadata:', e);
        return false;
    }
}

function getRuntimeManifestLookupKeys(): string[] {
    const electronVersion = process.versions.electron || 'unknown';
    const electronMajor = electronVersion.split('.')[0] || 'unknown';
    const platform = process.platform;
    const arch = process.arch;

    return [
        `${platform}-${arch}-electron-${electronVersion}`,
        `${platform}-${arch}-electron-${electronMajor}`,
        `${platform}-${arch}`,
    ];
}

async function resolveBundleFromManifest(manifestUrl: string): Promise<NativeRuntimeBundleManifestEntry | null> {
    if (!/^https:\/\//i.test(manifestUrl)) {
        throw new Error('Native runtime manifest URL must use HTTPS');
    }

    const response = await axios.get<NativeRuntimeBundleManifest>(manifestUrl, {
        timeout: 30_000,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const bundles = response.data?.bundles;
    if (!bundles || typeof bundles !== 'object') {
        throw new Error('Native runtime manifest does not contain a valid "bundles" map');
    }

    const keys = getRuntimeManifestLookupKeys();
    for (const key of keys) {
        const match = bundles[key];
        if (match?.url) {
            return match;
        }
    }

    return null;
}

async function downloadAndInstallRuntimeBundle(targetRuntimeDir: string): Promise<void> {
    let bundleUrl = getEffectiveString(runtimeConfig.bundleUrl, 'MI_COPILOT_NATIVE_BUNDLE_URL');
    let expectedChecksum = getEffectiveString(runtimeConfig.bundleSha256, 'MI_COPILOT_NATIVE_BUNDLE_SHA256');

    if (!bundleUrl) {
        const manifestUrl = getEffectiveString(runtimeConfig.manifestUrl, 'MI_COPILOT_NATIVE_BUNDLE_MANIFEST_URL')
            ?? getDefaultManifestUrl();
        if (manifestUrl) {
            const manifestEntry = await resolveBundleFromManifest(manifestUrl);
            if (manifestEntry) {
                bundleUrl = manifestEntry.url;
                if (!expectedChecksum && manifestEntry.sha256) {
                    expectedChecksum = manifestEntry.sha256;
                }
            } else {
                throw new Error(
                    `Native runtime manifest did not include a bundle for runtime keys: ${getRuntimeManifestLookupKeys().join(', ')}`,
                );
            }
        }
    }

    if (!bundleUrl) {
        throw new Error('Native runtime bundle URL could not be resolved from the manifest or configured override');
    }

    if (!/^https:\/\//i.test(bundleUrl)) {
        throw new Error('Native runtime bundle URL must use HTTPS');
    }

    const baseRoot = path.dirname(targetRuntimeDir);
    fs.mkdirSync(baseRoot, { recursive: true });

    const tmpRoot = path.join(baseRoot, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const zipPath = path.join(tmpRoot, 'native-runtime.zip');
    const extractDir = path.join(tmpRoot, 'extract');
    const stagingRuntimeDir = path.join(tmpRoot, 'runtime');

    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(stagingRuntimeDir, { recursive: true });

    try {
        const response = await axios.get<ArrayBuffer>(bundleUrl, {
            responseType: 'arraybuffer',
            timeout: 180_000,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 300,
        });

        fs.writeFileSync(zipPath, Buffer.from(response.data));

        if (expectedChecksum) {
            verifySha256(zipPath, expectedChecksum);
        }

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);

        const extractRoot = inferExtractRoot(extractDir);
        const extractedNodeModules = path.join(extractRoot, 'node_modules');
        if (!hasRequiredModulesIn(extractedNodeModules)) {
            throw new Error('Downloaded runtime bundle does not contain required node_modules packages');
        }

        fs.cpSync(extractRoot, stagingRuntimeDir, { recursive: true });

        const finalTmpPath = `${targetRuntimeDir}.new`;
        if (fs.existsSync(finalTmpPath)) {
            fs.rmSync(finalTmpPath, { recursive: true, force: true });
        }
        fs.renameSync(stagingRuntimeDir, finalTmpPath);

        if (fs.existsSync(targetRuntimeDir)) {
            fs.rmSync(targetRuntimeDir, { recursive: true, force: true });
        }
        fs.renameSync(finalTmpPath, targetRuntimeDir);
    } finally {
        if (fs.existsSync(tmpRoot)) {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    }
}

/**
 * Ensure native semantic-search runtime dependencies are available.
 *
 * Resolution order:
 *  1) Already-resolvable via Node module system (dev environment / NODE_PATH already set)
 *  2) Cached bundle on disk: ~/.wso2-mi/copilot/native-runtime/<platform-arch-electron>/
 *  3) Download bundle from manifest and cache it
 *
 * Success is determined by filesystem presence (hasRequiredModulesIn), NOT by
 * require.resolve. Inside a webpack-bundled VS Code extension, require.resolve
 * is intercepted by webpack and cannot reliably locate externally-downloaded
 * modules even when they exist on disk. The actual load test happens naturally
 * when requireSemanticNativeModule() is first called via createRequire.
 */
/**
 * Try loading a native module from a given node_modules directory using createRequire.
 * Returns the error message string on failure, or null on success.
 * Used to detect ABI mismatches before committing to a cached bundle.
 */
function tryLoadBinary(nodeModulesDir: string, moduleName: string): string | null {
    try {
        const testRequire = createRequire(path.join(nodeModulesDir, '__abi-verify__.js'));
        testRequire(moduleName);
        return null;
    } catch (e) {
        return (e instanceof Error ? e.message : String(e));
    }
}

export async function ensureSemanticNativeRuntimeDependencies(): Promise<boolean> {
    if (bootstrapPromise) {
        return bootstrapPromise;
    }

    bootstrapPromise = (async () => {
        const runtimeDir = path.join(getRuntimeRootDir(), getRuntimeKey());
        const runtimeNodeModulesDir = path.join(runtimeDir, 'node_modules');
        console.log('[NativeRuntime] Checking cached runtime at:', runtimeDir);
        console.log('[NativeRuntime] Runtime key:', getRuntimeKey());
        console.log('[NativeRuntime] Node.js process versions:', {
            node: process.version,
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            v8: process.versions.v8,
        });

        // Dev / already-bootstrapped: check if modules resolve without any path hint.
        // This works in raw Node.js where modules are in node_modules or NODE_PATH
        // was already populated by a prior bootstrap run in this process.
        // We still prefer the runtime bundle when it exists on disk — this ensures
        // requireSemanticNativeModule always uses the Electron-compatible binary
        // rather than a dev-node_modules copy that may have been compiled for Node.js.
        if (tryResolveAllModules() && !hasRequiredModulesIn(runtimeNodeModulesDir)) {
            clearFailureReason();
            console.log('[NativeRuntime] All modules already resolvable from NODE_PATH (no runtime bundle on disk)');
            return true;
        }

        if (hasRequiredModulesIn(runtimeNodeModulesDir)) {
            console.log('[NativeRuntime] Found cached runtime modules at:', runtimeNodeModulesDir);

            if (!validateRuntimeMetadata(runtimeDir)) {
                console.warn('[NativeRuntime] Cached runtime metadata invalid or version mismatch; will re-download');
                try {
                    fs.rmSync(runtimeDir, { recursive: true, force: true });
                    console.log('[NativeRuntime] Deleted mismatched runtime directory');
                } catch (e) {
                    console.warn('[NativeRuntime] Failed to delete mismatched runtime:', e);
                }
                // Fall through to download
            } else {
                // Metadata passed — but also verify the binary actually loads.
                // A bundle can have the right electronVersion in metadata yet contain
                // a binary compiled for the wrong ABI (e.g. built before Issue 1 fix).
                const abiError = tryLoadBinary(runtimeNodeModulesDir, 'better-sqlite3');
                if (abiError) {
                    console.warn('[NativeRuntime] Cached binary failed load test — deleting bundle for re-download:', abiError);
                    try {
                        fs.rmSync(runtimeDir, { recursive: true, force: true });
                        console.log('[NativeRuntime] Deleted bad runtime bundle');
                    } catch (e) {
                        console.warn('[NativeRuntime] Failed to delete bad runtime bundle:', e);
                    }
                    // Fall through to download
                } else {
                    registerNodeModulesPath(runtimeNodeModulesDir);
                    runtimeNodeModulesPath = runtimeNodeModulesDir;
                    clearFailureReason();
                    console.log('[NativeRuntime] Using cached runtime modules at:', runtimeNodeModulesDir);
                    return true;
                }
            }
        } else {
            console.log('[NativeRuntime] No cached runtime modules found at:', runtimeNodeModulesDir);
        }

        const runtimeDownloadEnabled = getEffectiveBoolean(
            runtimeConfig.enabled,
            'MI_COPILOT_NATIVE_RUNTIME_DOWNLOAD_ENABLED',
            true,
        );
        if (!runtimeDownloadEnabled) {
            setFailureReason('Automatic native runtime download is disabled (MI.semanticRuntime.downloadEnabled=false).');
            console.warn('[NativeRuntime] Runtime download disabled');
            return false;
        }

        try {
            await downloadAndInstallRuntimeBundle(runtimeDir);

            if (!hasRequiredModulesIn(runtimeNodeModulesDir)) {
                setFailureReason('Native runtime bundle was downloaded but required modules were not found on disk after extraction.');
                console.error('[NativeRuntime] Modules not found after extraction at:', runtimeNodeModulesDir);
                return false;
            }

            registerNodeModulesPath(runtimeNodeModulesDir);
            runtimeNodeModulesPath = runtimeNodeModulesDir;
            clearFailureReason();
            console.log('[NativeRuntime] Runtime bundle installed at:', runtimeNodeModulesDir);
            return true;
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            setFailureReason(`Failed to resolve/download runtime bundle: ${details}`);
            console.error('[NativeRuntime] Failed to download/install runtime bundle:', error);
            return false;
        }
    })();

    return bootstrapPromise;
}

export function requireSemanticNativeModule<T = unknown>(moduleName: string): T {
    if (runtimeNodeModulesPath) {
        const packageJsonPath = path.join(runtimeNodeModulesPath, moduleName, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const runtimeRequire = tryCreateRuntimeRequire(runtimeNodeModulesPath);
            if (runtimeRequire) {
                try {
                    return runtimeRequire(moduleName) as T;
                } catch (e) {
                    console.warn(`[NativeRuntime] Failed to load ${moduleName} from runtime require:`, e);
                }
            }
        }
    }

    // Safety net: runtimeNodeModulesPath not set (e.g. early-exit dev path where modules
    // resolved via NODE_PATH but we have a cached bundle on disk).
    // Anchor createRequire at the node_modules level so it can resolve sibling packages.
    const runtimeDir = path.join(getRuntimeRootDir(), getRuntimeKey());
    const fallbackNodeModules = path.join(runtimeDir, 'node_modules');
    if (fs.existsSync(path.join(fallbackNodeModules, moduleName, 'package.json'))) {
        try {
            const fallbackRequire = createRequire(path.join(fallbackNodeModules, '__loader__.js'));
            return fallbackRequire(moduleName) as T;
        } catch (e) {
            console.warn(`[NativeRuntime] Fallback module load failed for ${moduleName}:`, e);
        }
    }

    // Last resort: require from default NODE_PATH
    console.log(`[NativeRuntime] Requiring ${moduleName} from default NODE_PATH`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(moduleName) as T;
}

/**
 * Dynamically import an ES Module from the semantic runtime bundle.
 *
 * @xenova/transformers ships as an ES Module (`"type": "module"`) and cannot be
 * loaded with createRequire (a CommonJS API). This function resolves the module's
 * entry point from the runtime bundle and uses a native dynamic import() so Node's
 * ESM loader handles it correctly.
 *
 * The `new Function` wrapper prevents webpack from statically transforming the
 * import() call into a CommonJS require, which would break for file:// URLs.
 */
export async function importSemanticNativeESMModule<T = unknown>(moduleName: string): Promise<T> {
    // Bypass webpack's static import() transformation — must be a runtime-constructed
    // function so webpack cannot analyse and inline the specifier.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>;

    const nodeModulesDir = runtimeNodeModulesPath
        ?? path.join(getRuntimeRootDir(), getRuntimeKey(), 'node_modules');

    const pkgJsonPath = path.join(nodeModulesDir, moduleName, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { main?: string };
            const mainRelative = pkg.main ?? 'index.js';
            const entryPoint = path.resolve(nodeModulesDir, moduleName, mainRelative);
            if (fs.existsSync(entryPoint)) {
                // Convert to file:// URL — required on Windows (backslashes) and ensures
                // Node's ESM loader accepts an absolute path on all platforms.
                const fileUrl = pathToFileURL(entryPoint).href;
                console.log(`[NativeRuntime] ESM importing ${moduleName} from: ${fileUrl}`);
                return (await dynamicImport(fileUrl)) as T;
            }
        } catch (e) {
            console.warn(`[NativeRuntime] ESM import of ${moduleName} from runtime bundle failed:`, e);
        }
    }

    // Last resort: bare specifier (works only if NODE_PATH already contains nodeModulesDir)
    console.warn(`[NativeRuntime] ESM import fallback: loading ${moduleName} via bare specifier`);
    return (await dynamicImport(moduleName)) as T;
}
