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
// copy-native-modules.js
//
// Builds a platform/electron-specific native runtime bundle zip for
// semantic search lazy-download distribution (GitHub Releases/CDN).
//
// Bundle contents include native/large dependencies required at runtime:
//   - better-sqlite3       (C++ addon — needs Electron-compatible .node binary)
//   - onnxruntime-node     (pre-compiled native ONNX runtime per OS/arch)
//   - @xenova/transformers (pure JS, but externalized from webpack because its
//                           circular deps and optional native deps (sharp, canvas)
//                           cause TDZ errors when bundled — loaded at runtime via
//                           requireSemanticNativeModule instead)
//
// Run AFTER rebuild-native.js so better-sqlite3 uses Electron-compatible binary.
// ============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT_DEFAULT = path.join(PROJECT_ROOT, 'native-runtime-artifacts');

const REQUIRED_MODULES = [
    'better-sqlite3',
    'onnxruntime-node',
    // @xenova/transformers is pure JS but is externalized from the webpack bundle
    // to avoid circular-dependency TDZ errors and optional-native-dep failures
    // (sharp, canvas) that occur when webpack inlines it. It must ship in the
    // runtime bundle so requireSemanticNativeModule can load it at runtime.
    '@xenova/transformers',
];

/**
 * Optional dependencies of @xenova/transformers that are NOT needed for text
 * embedding. These are native modules compiled for host Node.js ABI (not
 * rebuilt for Electron) so we must NOT copy their real binaries.
 *
 * IMPORTANT: we cannot simply omit these — @xenova/transformers/src/utils/image.js
 * has a top-level static `import sharp from 'sharp'` and throws at module
 * evaluation time when running in Node.js without any image library:
 *
 *   } else {
 *     throw new Error('Unable to load image processing library.');
 *   }
 *
 * To prevent this we install a truthy stub that makes `if (sharp)` pass so the
 * module loads, but actual image processing is never invoked for text embeddings.
 */
const OPTIONAL_DEPS_STUB = new Set([
    'sharp',
    'canvas',
]);

/**
 * Create a minimal stub package for a module that must exist (to satisfy static
 * ESM imports) but whose real native binary we do not want to include.
 *
 * The stub exports a function (truthy) so checks like `if (sharp)` pass, but
 * calling it throws a clear error. This is safe because image/canvas APIs are
 * never invoked in text-only embedding pipelines.
 */
function createNullStub(moduleName, targetNodeModules) {
    const stubDir = path.join(targetNodeModules, moduleName);
    if (fs.existsSync(path.join(stubDir, 'package.json'))) {
        return; // already stubbed or copied
    }
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
        name: moduleName,
        version: '0.0.0-stub',
        main: 'index.js',
        description: `Stub: ${moduleName} not needed for text-only embedding`,
    }, null, 2));
    fs.writeFileSync(path.join(stubDir, 'index.js'),
        `// Stub for ${moduleName}.\n` +
        `// Makes static 'import ${moduleName}' resolve (truthy) without pulling in\n` +
        `// the real native binary (which would need Electron ABI recompilation).\n` +
        `// Actual ${moduleName} operations are never called in text-only pipelines.\n` +
        `function ${moduleName.replace(/[^a-zA-Z0-9]/g, '_')}Stub() {\n` +
        `    throw new Error('${moduleName} is not available in the text embedding runtime (stub)');\n` +
        `}\n` +
        `module.exports = ${moduleName.replace(/[^a-zA-Z0-9]/g, '_')}Stub;\n`
    );
    console.log(`  ↷ created null stub for optional native dep: ${moduleName}`);
}

function getArgValue(name, fallback = undefined) {
    const index = process.argv.indexOf(name);
    if (index === -1 || index + 1 >= process.argv.length) {
        return fallback;
    }
    return process.argv[index + 1];
}

const runtimePlatform = getArgValue('--platform', process.platform);
const runtimeArch = getArgValue('--arch', process.arch);
const runtimeElectron = getArgValue('--electron-version', process.env.ELECTRON_VERSION || process.versions.electron || 'unknown');
const runtimeKey = `${runtimePlatform}-${runtimeArch}-electron-${runtimeElectron}`;
const outputRoot = path.resolve(getArgValue('--out-dir', OUTPUT_ROOT_DEFAULT));
const bundleBaseName = getArgValue('--bundle-name', `native-runtime-${runtimeKey}`);

const bundleRoot = path.join(outputRoot, runtimeKey);
const bundleNodeModules = path.join(bundleRoot, 'node_modules');
const bundleZipPath = path.join(outputRoot, `${bundleBaseName}.zip`);
const bundleShaPath = `${bundleZipPath}.sha256`;

/**
 * Find the nearest node_modules/.pnpm store by walking up from PROJECT_ROOT.
 * In a pnpm monorepo the store lives at the workspace root, not the package root.
 */
function findPnpmStore() {
    let dir = PROJECT_ROOT;
    for (let i = 0; i < 10; i++) {
        const candidate = path.join(dir, 'node_modules', '.pnpm');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

const PNPM_STORE_DIR = findPnpmStore();
const copiedModules = new Set();

function copyDirSync(src, dest, skipFn) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (skipFn && skipFn(srcPath, entry)) {
            continue;
        }

        // Skip unnecessary directories
        if (entry.isDirectory()) {
            if (['.git', 'test', 'tests', 'docs', 'doc', 'benchmark', 'benchmarks', 'examples', 'example', '.github'].includes(entry.name)) {
                continue;
            }
            copyDirSync(srcPath, destPath, skipFn);
        } else {
            if (entry.name.match(/\.(md|markdown|ts|map)$/i) && entry.name !== 'package.json') {
                continue;
            }
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Returns a skip function for onnxruntime-node that prunes all platform/arch
 * binary directories under bin/napi-v* except the target runtimePlatform
 * and runtimeArch.
 *
 * onnxruntime-node ships ~92MB of binaries across 6 platform/arch combos.
 * This filter keeps only the target platform tree (~15-23MB).
 *
 * @param {string} onnxSrcRoot — absolute path to the onnxruntime-node package dir
 */
function makeOnnxFilter(onnxSrcRoot) {
    return function skipFn(srcPath, entry) {
        if (!entry.isDirectory()) return false;
        const rel = path.relative(onnxSrcRoot, srcPath);
        const parts = rel.split(path.sep);
        // Structure: bin/napi-v*/<platform>/<arch>/
        if (parts[0] === 'bin' && parts.length >= 3 && /^napi-v\d+$/.test(parts[1])) {
            if (parts[2] !== runtimePlatform) return true;
            if (parts.length >= 4 && parts[3] !== runtimeArch) return true;
        }
        return false;
    };
}

/**
 * Resolve a module directory from node_modules, handling scoped packages
 * and pnpm symlinks.
 *
 * Search order:
 *   1. <PROJECT_ROOT>/node_modules/<module>      (hoisted symlink)
 *   2. require.resolve from PROJECT_ROOT         (standard Node resolution)
 *   3. pnpm virtual store scan — look inside every .pnpm/<pkg>/node_modules/
 *      for a sibling named <module>. This handles optionalDependencies that
 *      are not hoisted but are present in the pnpm store (e.g. onnxruntime-node
 *      inside @xenova+transformers@x.y.z/node_modules/).
 */
function resolveModuleDir(moduleName) {
    // 1. Hoisted symlink
    const direct = path.join(PROJECT_ROOT, 'node_modules', moduleName);
    if (fs.existsSync(direct)) {
        return fs.realpathSync(direct);
    }

    // 2. require.resolve
    try {
        const pkgPath = require.resolve(path.join(moduleName, 'package.json'), {
            paths: [PROJECT_ROOT],
        });
        return fs.realpathSync(path.dirname(pkgPath));
    } catch {
        // fall through
    }

    // 3. Scan pnpm virtual store (.pnpm/<pkg>@<ver>/node_modules/<module>)
    if (PNPM_STORE_DIR && fs.existsSync(PNPM_STORE_DIR)) {
        try {
            const storeEntries = fs.readdirSync(PNPM_STORE_DIR);
            for (const storeEntry of storeEntries) {
                const candidate = path.join(PNPM_STORE_DIR, storeEntry, 'node_modules', moduleName);
                if (fs.existsSync(candidate)) {
                    return fs.realpathSync(candidate);
                }
            }
        } catch {
            // ignore read errors
        }
    }

    return null;
}

/**
 * Copy a module and its runtime dependencies recursively.
 *
 * @param {string} moduleName  — the npm package name to copy
 * @param {string} [parentSrcDir] — source dir of the parent (for pnpm sibling resolution)
 * @param {number} [depth=0]  — recursion depth (for indented logging)
 */
function copyModule(moduleName, depth = 0) {
    const indent = '    '.repeat(depth);
    if (copiedModules.has(moduleName)) {
        return;
    }

    const srcDir = resolveModuleDir(moduleName);
    if (!srcDir) {
        throw new Error(`${moduleName}: not found in node_modules (required for runtime bundle)`);
    }

    const pkgJsonPath = path.join(srcDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
        throw new Error(`${moduleName}: package.json not found at ${srcDir}`);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const modulePlatformConstraint = pkg.os;
    const moduleArchConstraint = pkg.cpu;

    if (Array.isArray(modulePlatformConstraint) && modulePlatformConstraint.length > 0) {
        const allowed = modulePlatformConstraint.filter((v) => !String(v).startsWith('!'));
        const denied = modulePlatformConstraint.filter((v) => String(v).startsWith('!')).map((v) => String(v).slice(1));
        if ((allowed.length > 0 && !allowed.includes(runtimePlatform)) || denied.includes(runtimePlatform)) {
            throw new Error(`${moduleName}: not compatible with platform ${runtimePlatform}`);
        }
    }

    if (Array.isArray(moduleArchConstraint) && moduleArchConstraint.length > 0) {
        const allowed = moduleArchConstraint.filter((v) => !String(v).startsWith('!'));
        const denied = moduleArchConstraint.filter((v) => String(v).startsWith('!')).map((v) => String(v).slice(1));
        if ((allowed.length > 0 && !allowed.includes(runtimeArch)) || denied.includes(runtimeArch)) {
            throw new Error(`${moduleName}: not compatible with arch ${runtimeArch}`);
        }
    }

    const destDir = path.join(bundleNodeModules, moduleName);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(path.dirname(destDir), { recursive: true });
        const skipFn = moduleName === 'onnxruntime-node' ? makeOnnxFilter(srcDir) : undefined;
        copyDirSync(srcDir, destDir, skipFn);
        console.log(`${indent}✓ copied ${moduleName}`);
    }

    copiedModules.add(moduleName);

    const dependencies = {
        ...(pkg.dependencies || {}),
        ...(pkg.optionalDependencies || {}),
    };

    for (const dep of Object.keys(dependencies)) {
        // Replace problematic optional native deps with null stubs instead of
        // copying real binaries. The stubs are truthy functions so static ESM
        // imports like `import sharp from 'sharp'` resolve without throwing at
        // module evaluation time, while actual image/canvas calls are never
        // reached in text-only embedding pipelines.
        if (OPTIONAL_DEPS_STUB.has(dep) && (pkg.optionalDependencies || {})[dep]) {
            createNullStub(dep, bundleNodeModules);
            copiedModules.add(dep);
            continue;
        }
        try {
            copyModule(dep, depth + 1);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if ((pkg.optionalDependencies || {})[dep]) {
                console.log(`${indent}  ↷ skip optional dependency ${dep}: ${message}`);
                continue;
            }
            throw error;
        }
    }
}

function ensureCleanDir(dirPath) {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeRuntimeMetadata() {
    const metadata = {
        runtimeKey,
        platform: runtimePlatform,
        arch: runtimeArch,
        electronVersion: runtimeElectron,
        generatedAt: new Date().toISOString(),
        modules: Array.from(copiedModules).sort(),
    };

    fs.writeFileSync(path.join(bundleRoot, 'runtime-metadata.json'), JSON.stringify(metadata, null, 2));
}

function createBundleArchive() {
    fs.mkdirSync(outputRoot, { recursive: true });
    if (fs.existsSync(bundleZipPath)) {
        fs.rmSync(bundleZipPath, { force: true });
    }

    const zip = new AdmZip();
    zip.addLocalFolder(bundleRoot);
    zip.writeZip(bundleZipPath);
}

function writeBundleSha256() {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(bundleZipPath));
    const checksum = hash.digest('hex');
    fs.writeFileSync(bundleShaPath, `${checksum}  ${path.basename(bundleZipPath)}\n`);
    return checksum;
}

function getDirSize(dirPath) {
    let size = 0;
    if (!fs.existsSync(dirPath)) {
        return 0;
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            size += getDirSize(fullPath);
        } else {
            size += fs.statSync(fullPath).size;
        }
    }
    return size;
}

function main() {
    console.log(`\n📦 Building native runtime bundle: ${runtimeKey}`);
    console.log(`   Output root: ${outputRoot}`);

    ensureCleanDir(bundleRoot);
    fs.mkdirSync(bundleNodeModules, { recursive: true });

    for (const mod of REQUIRED_MODULES) {
        copyModule(mod);
    }

    writeRuntimeMetadata();
    createBundleArchive();
    const checksum = writeBundleSha256();

    const runtimeSizeMb = (getDirSize(bundleRoot) / 1024 / 1024).toFixed(1);
    const zipSizeMb = (fs.statSync(bundleZipPath).size / 1024 / 1024).toFixed(1);

    console.log(`\n✅ Runtime bundle created`);
    console.log(`   Runtime dir : ${bundleRoot} (${runtimeSizeMb} MB)`);
    console.log(`   Zip         : ${bundleZipPath} (${zipSizeMb} MB)`);
    console.log(`   SHA256      : ${checksum}`);
    console.log(`   SHA file    : ${bundleShaPath}\n`);
}

main();
