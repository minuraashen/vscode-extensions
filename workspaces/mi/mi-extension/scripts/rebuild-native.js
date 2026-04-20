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

// ============================================================================
// rebuild-native.js
//
// Downloads prebuilt Electron-compatible binaries for native Node.js addons
// (better-sqlite3). This is required because:
//   - better-sqlite3 ships a .node binary compiled for the system Node ABI
//   - VS Code extensions run inside Electron which uses a different ABI
//   - Without the correct binary, require('better-sqlite3') throws an error
//
// better-sqlite3 v11.8+ ships with prebuilt binaries for Electron 34+.
// This script uses `prebuild-install` to download the correct prebuilt
// binary for the target Electron version — NO C++ compilation required.
//
// Usage:
//   node scripts/rebuild-native.js            # auto-detect from engines.vscode
//   node scripts/rebuild-native.js --target 34.3.0  # explicit Electron version
//
// The script:
//   1. Reads the VS Code engine version from package.json
//   2. Resolves the corresponding Electron version
//   3. Uses prebuild-install to download the Electron prebuilt binary
//   4. Verifies the downloaded binary has the correct ABI
// ============================================================================

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Configuration ─────────────────────────────────────────────────────────

/** Native modules that need Electron-compatible builds */
const NATIVE_MODULES = ['better-sqlite3'];

/**
 * Well-known mapping of VS Code minor versions to Electron major.minor.
 * Updated periodically — add new entries as VS Code releases ship.
 *
 * Source: https://github.com/nicedoc/vscode-to-electron
 *         https://github.com/nicedoc/electron-releases
 */
const VSCODE_TO_ELECTRON = {
    '1.106': '37.7.0',
    '1.105': '37.5.0',
    '1.104': '36.4.0',
    '1.103': '36.3.0',
    '1.102': '35.2.0',
    '1.101': '35.1.0',
    '1.100': '34.3.0',
    '1.99': '34.2.0',
    '1.98': '34.1.0',
    '1.97': '33.3.0',
    '1.96': '33.2.0',
    '1.95': '32.2.0',
};

/**
 * Electron ABI (NODE_MODULE_VERSION) values for recent major versions.
 * Source: node-abi package / https://github.com/nicedoc/electron-releases
 * Note: these are approximate — prebuild-install resolves the exact ABI
 * at download time using the `node-abi` package.
 */
const ELECTRON_ABI_MAP = {
    '37': '136',
    '36': '135',
    '35': '133',
    '34': '132',
    '33': '130',
    '32': '128',
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Try to detect the **actually installed** VS Code version so we rebuild
 * native modules for the correct Electron ABI, not just the minimum
 * supported version from engines.vscode.
 *
 * Detection order:
 *   1. `code --version` CLI (works when VS Code is in PATH)
 *   2. macOS: read version from the VS Code .app bundle via `mdfind`
 *   3. Fallback: engines.vscode from package.json (minimum supported)
 */
function getVSCodeEngineVersion() {
    // 1. Try `code --version` — first line is the version string
    try {
        const cliVersion = execSync('code --version 2>/dev/null', { encoding: 'utf8', timeout: 5000 })
            .split('\n')[0].trim();
        if (/^\d+\.\d+\.\d+/.test(cliVersion)) {
            console.log(`ℹ️  Detected installed VS Code ${cliVersion} (via CLI)`);
            return cliVersion;
        }
    } catch { /* CLI not available */ }

    // 2. macOS: find VS Code app bundle and read its package.json
    if (process.platform === 'darwin') {
        try {
            const appPaths = execSync(
                "mdfind \"kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'\" 2>/dev/null",
                { encoding: 'utf8', timeout: 5000 }
            ).trim().split('\n').filter(Boolean);

            for (const appPath of appPaths) {
                const pkgPath = path.join(appPath, 'Contents', 'Resources', 'app', 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const appPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    if (appPkg.version && /^\d+\.\d+\.\d+/.test(appPkg.version)) {
                        console.log(`ℹ️  Detected installed VS Code ${appPkg.version} (via app bundle)`);
                        return appPkg.version;
                    }
                }
            }
        } catch { /* mdfind not available or no results */ }
    }

    // 3. Fallback: engines.vscode from package.json (minimum supported version)
    const pkg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
    );
    const minVersion = (pkg.engines?.vscode || '').replace(/^[\^~>=<]+/, '');
    console.log(`ℹ️  Using minimum supported VS Code ${minVersion} (from engines.vscode)`);
    return minVersion;
}

function resolveElectronVersion(vscodeVersion) {
    const parts = vscodeVersion.split('.');
    const key = `${parts[0]}.${parts[1]}`;
    return VSCODE_TO_ELECTRON[key];
}

function getElectronAbi(electronVersion) {
    const major = electronVersion.split('.')[0];
    return ELECTRON_ABI_MAP[major] || null;
}

function run(cmd, opts = {}) {
    console.log(`  $ ${cmd}`);
    return execSync(cmd, { stdio: 'inherit', ...opts });
}

function runCapture(cmd, opts = {}) {
    return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

/**
 * Resolve the actual node_modules path for a module in a pnpm monorepo.
 * pnpm uses symlinks: node_modules/<pkg> -> .pnpm/<pkg>/node_modules/<pkg>
 */
function resolveModulePath(projectRoot, moduleName) {
    const directPath = path.resolve(projectRoot, 'node_modules', moduleName);
    if (fs.existsSync(directPath)) {
        // Resolve symlinks to get the real path (pnpm stores)
        return fs.realpathSync(directPath);
    }
    return null;
}

/**
 * Remove existing .node binaries from a module directory so we can tell
 * definitively whether prebuild-install actually downloaded a new one.
 * prebuild-install exits 0 even on HTTP 404, so without clearing first
 * the old Node.js-ABI binary would stay in place undetected.
 */
function clearExistingBinaries(modDir, targetArch) {
    const releaseDir = path.join(modDir, 'build', 'Release');
    if (fs.existsSync(releaseDir)) {
        for (const f of fs.readdirSync(releaseDir).filter(f => f.endsWith('.node'))) {
            fs.rmSync(path.join(releaseDir, f), { force: true });
        }
    }
    const prebuildDir = path.join(modDir, 'prebuilds', `${process.platform}-${targetArch}`);
    if (fs.existsSync(prebuildDir)) {
        fs.rmSync(prebuildDir, { recursive: true, force: true });
    }
}

/**
 * Returns the path to the .node binary if one exists after prebuild-install,
 * checking both build/Release/ (node-gyp output) and prebuilds/<platform>-<arch>/
 * (prebuild-install output).
 */
function findBinaryPath(modDir, targetArch) {
    const releaseBinary = path.join(modDir, 'build', 'Release', 'better_sqlite3.node');
    if (fs.existsSync(releaseBinary)) return releaseBinary;

    const prebuildDir = path.join(modDir, 'prebuilds', `${process.platform}-${targetArch}`);
    if (fs.existsSync(prebuildDir)) {
        const files = fs.readdirSync(prebuildDir).filter(f => f.endsWith('.node'));
        if (files.length > 0) return path.join(prebuildDir, files[0]);
    }
    return null;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);
    let electronVersion;

    // Allow explicit override by either --target or --electron-version
    const targetIdx = args.indexOf('--target');
    const electronVersionIdx = args.indexOf('--electron-version');
    if (electronVersionIdx !== -1 && args[electronVersionIdx + 1]) {
        electronVersion = args[electronVersionIdx + 1];
    } else if (targetIdx !== -1 && args[targetIdx + 1]) {
        electronVersion = args[targetIdx + 1];
    } else {
        const vscodeVersion = getVSCodeEngineVersion();
        electronVersion = resolveElectronVersion(vscodeVersion);
        if (!electronVersion) {
            console.error(
                `❌ Cannot resolve Electron version for VS Code ${vscodeVersion}.\n` +
                `   Update VSCODE_TO_ELECTRON map in scripts/rebuild-native.js or use --target <electron-version>.`
            );
            process.exit(1);
        }
        console.log(`ℹ️  VS Code engine: ${vscodeVersion} → Electron ${electronVersion}`);
    }

    if (!/^\d+\.\d+\.\d+/.test(electronVersion)) {
        console.error(`❌ Invalid electron version: ${electronVersion}`);
        process.exit(1);
    }

    // --arch overrides process.arch for cross-compilation (e.g. build arm64 on x64)
    const archIdx = args.indexOf('--arch');
    const targetArch = (archIdx !== -1 && args[archIdx + 1]) ? args[archIdx + 1] : process.arch;

    const projectRoot = path.resolve(__dirname, '..');
    const abi = getElectronAbi(electronVersion);

    console.log(`\n🔧 Downloading Electron ${electronVersion} prebuilt binaries (ABI ${abi || 'unknown'})...\n`);

    for (const mod of NATIVE_MODULES) {
        const modDir = resolveModulePath(projectRoot, mod);
        if (!modDir) {
            console.warn(`⚠️  ${mod} not found in node_modules — skipping`);
            continue;
        }

        console.log(`  → Module: ${mod}`);
        console.log(`    Real path: ${modDir}`);

        // Use prebuild-install to download the Electron prebuilt binary.
        // better-sqlite3 v11.8+ ships prebuilt binaries for Electron 34+.
        // This downloads the correct .node binary without compiling from source.
        const prebuildArgs = [
            'prebuild-install',
            '--runtime=electron',
            `--target=${electronVersion}`,
            `--arch=${targetArch}`,
            '--tag-prefix=v',
            '--verbose',
        ];

        // Clear any existing binary first. prebuild-install exits 0 even on
        // HTTP 404 (it only warns), so without clearing we can't tell whether
        // it actually placed a new Electron-ABI binary or left the old one.
        clearExistingBinaries(modDir, targetArch);

        console.log(`  → Downloading Electron ${electronVersion} prebuilt for ${mod} (${targetArch})...`);
        const prebuildResult = spawnSync(
            'npx', prebuildArgs,
            { cwd: modDir, encoding: 'utf8', shell: process.platform === 'win32' }
        );

        // Forward captured output so the user can see what prebuild-install did.
        if (prebuildResult.stdout) process.stdout.write(prebuildResult.stdout);
        if (prebuildResult.stderr) process.stderr.write(prebuildResult.stderr);

        const prebuildOutput = (prebuildResult.stdout || '') + (prebuildResult.stderr || '');
        const prebuildFailed =
            prebuildResult.status !== 0 ||
            prebuildResult.error != null ||
            /no prebuilt binaries found/i.test(prebuildOutput) ||
            findBinaryPath(modDir, targetArch) === null;

        if (!prebuildFailed) {
            console.log(`  ✅ ${mod}: prebuilt binary downloaded for Electron ${electronVersion} (${targetArch})\n`);
        } else {
            console.error(`\n❌ prebuild-install found no prebuilt binary for ${mod}.`);
            console.error(`   (Electron ${electronVersion}, ${process.platform}-${targetArch})`);
            console.error(`   Falling back to node-gyp compilation...\n`);

            // Fallback: compile from source using node-gyp with Electron headers
            try {
                const nodeGypArgs = [
                    'node-gyp', 'rebuild',
                    '--release',
                    `--target=${electronVersion}`,
                    `--arch=${targetArch}`,
                    `--dist-url=https://electronjs.org/headers`,
                ];
                run(`npx ${nodeGypArgs.join(' ')}`, { cwd: modDir });
                console.log(`  ✅ ${mod}: compiled from source for Electron ${electronVersion}\n`);
            } catch (e2) {
                console.error(`❌ Both prebuild download and source compilation failed for ${mod}.`);
                console.error(`   See errors above for details.`);
                process.exit(1);
            }
        }

        // Verify the binary was created/downloaded
        verifyNativeBinary(modDir, mod, abi, targetArch);
    }

    console.log(`\n✅ Native module preparation complete.\n`);
}

/**
 * Verify the .node binary exists and optionally check its ABI compatibility.
 */
function verifyNativeBinary(modDir, moduleName, expectedAbi, targetArch = process.arch) {
    // better-sqlite3 places its binary at build/Release/better_sqlite3.node
    // or in prebuilds/<platform>-<arch>/ when downloaded via prebuild-install
    const releaseBinary = path.join(modDir, 'build', 'Release', 'better_sqlite3.node');
    const prebuildDir = path.join(modDir, 'prebuilds', `${process.platform}-${targetArch}`);

    let binaryPath = null;
    if (fs.existsSync(releaseBinary)) {
        binaryPath = releaseBinary;
    } else if (fs.existsSync(prebuildDir)) {
        // Look for .node file in prebuilds directory
        const files = fs.readdirSync(prebuildDir).filter(f => f.endsWith('.node'));
        if (files.length > 0) {
            binaryPath = path.join(prebuildDir, files[0]);
        }
    }

    if (binaryPath) {
        const stats = fs.statSync(binaryPath);
        console.log(`  📋 ${moduleName}: binary at ${path.relative(modDir, binaryPath)} (${(stats.size / 1024).toFixed(0)} KB)`);

        // On macOS, we can verify the architecture
        if (process.platform === 'darwin') {
            try {
                const fileInfo = runCapture(`file "${binaryPath}"`);
                console.log(`     ${fileInfo.split(': ').pop()}`);
            } catch { /* ignore */ }
        }
    } else {
        console.warn(`  ⚠️  ${moduleName}: no .node binary found — the module may not load correctly`);
    }
}

main();
