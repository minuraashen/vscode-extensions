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
// Copies native Node.js modules (better-sqlite3) and heavy JS libraries
// (@xenova/transformers) into dist/node_modules/ so they are available at
// runtime when the webpack bundle does `require('better-sqlite3')`.
//
// The VSIX is packaged with --no-dependencies (see package-vsix.js),
// so node_modules/ is not included. This script selectively copies only
// the modules that webpack externals reference.
//
// Run AFTER webpack build and rebuild-native.js (for production builds).
// ============================================================================

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const DIST_NODE_MODULES = path.join(DIST_DIR, 'node_modules');

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

/**
 * Modules to copy into dist/node_modules/ for runtime resolution.
 * These correspond to the `externals` entries in webpack.config.js.
 *
 * NOTE: onnxruntime-node and onnxruntime-common are listed here explicitly
 * because they are optionalDependencies of @xenova/transformers (not
 * dependencies), so the automatic dep-copy loop skips them. They are
 * required at runtime in Node/Electron contexts for ONNX inference.
 */
const EXTERNAL_MODULES = [
    'better-sqlite3',
    '@xenova/transformers',
    'onnxruntime-node',
    'onnxruntime-common',
];

/**
 * Dependencies to SKIP entirely — these have transitive deps we don't want and
 * are never imported by @xenova/transformers source (verified by grep).
 * Currently empty: all formerly-skipped packages are now stubs (see below).
 */
const SKIP_DEPS = new Set([
    // (none)
]);

/**
 * Dependencies to replace with a minimal ESM stub instead of the real package.
 *
 * @xenova/transformers statically imports all of these at module-load time even
 * though they are only used in specific contexts (browser, image pipelines, chat
 * templates). Because the imports are static (not dynamic), Node.js ESM must
 * resolve each one before executing any module code — a missing package causes
 * "Cannot find package" and kills the extension activation.
 *
 * Each stub exports exactly the named symbols referenced by transformers source
 * (verified by grep) so that ESM does not throw SyntaxError on named imports.
 *
 * Stubs are intentionally small/no-op:
 * - onnxruntime-web: never executed — onnxruntime-node is used in Node.js.
 * - sharp: guarded by `if (sharp)` in image.js; exporting null keeps it falsy.
 * - @huggingface/jinja: only called for models with a chat_template (MiniLM has none).
 */
const STUB_DEPS = new Set([
    'onnxruntime-web',
    'sharp',
    '@huggingface/jinja',
]);

// ── Stub specifications ───────────────────────────────────────────────────
//
// Content for each stub. Must export every named symbol that transformers
// imports with `import { X } from 'pkg'`, otherwise Node.js ESM throws
// SyntaxError. Default exports must have the correct truthiness (see sharp).
//
const STUB_CONTENT = {
    // backends/onnx.js: `import * as ONNX_WEB from 'onnxruntime-web'`
    // Used only in browser contexts; onnxruntime-node handles Node.js.
    'onnxruntime-web': 'export default {};\n',

    // utils/image.js: `import sharp from 'sharp'`
    // The module-level guard is `} else if (sharp) { ... } else { throw }`.
    // The value must be TRUTHY so the `else if` branch is taken (setting up
    // loadImageFunction lazily) rather than the `else` branch which throws
    // "Unable to load image processing library." at activation time.
    // The actual sharp() calls inside loadImageFunction / toSharp() are never
    // reached for text/feature-extraction pipelines, so the stub body is a no-op.
    'sharp': 'export default function sharp() {};\n',

    // tokenizers.js: `import { Template } from '@huggingface/jinja'`
    // Only called for models with a chat_template field; MiniLM has none.
    '@huggingface/jinja':
        'export class Template {\n' +
        '  constructor() {}\n' +
        '  render() { return \'\'; }\n' +
        '}\n' +
        'export default { Template };\n',
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Create a minimal ESM stub for a package that must be importable but is not
 * actually used in Node.js/Electron contexts.
 * The stub exports the named symbols that transformers statically imports so
 * that Node.js ESM does not throw SyntaxError at activation time.
 */
function createStub(moduleName, destDir) {
    const content = STUB_CONTENT[moduleName];
    if (!content) {
        console.warn(`    ⚠️  No stub spec for ${moduleName} — skipping stub creation`);
        return;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(
        path.join(destDir, 'package.json'),
        JSON.stringify({ name: moduleName, version: '0.0.0-stub', type: 'module', main: 'index.js' }, null, 2)
    );
    fs.writeFileSync(path.join(destDir, 'index.js'), `// stub: not used in Node.js/Electron\n${content}`);
    console.log(`    ○  ${moduleName} (stub created)`);
}

/**
 * Recursively copy a directory, skipping unnecessary files to minimise size.
 */
function copyDirSync(src, dest, skipPatterns = []) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        // Skip unnecessary directories
        if (entry.isDirectory()) {
            if (['.git', 'test', 'tests', 'docs', 'doc', 'benchmark', 'benchmarks', 'examples', 'example', '.github'].includes(entry.name)) {
                continue;
            }
            if (skipPatterns.some(p => entry.name.match(p))) {
                continue;
            }
            copyDirSync(srcPath, destPath, skipPatterns);
        } else {
            // Skip unnecessary files
            if (entry.name.match(/\.(md|markdown|ts|map|yml|yaml|eslint.*|prettier.*)$/i) && entry.name !== 'package.json') {
                continue;
            }
            if (entry.name === '.npmignore' || entry.name === '.gitignore') {
                continue;
            }
            fs.copyFileSync(srcPath, destPath);
        }
    }
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
 * Copy a module and its production dependencies (recursively) into
 * dist/node_modules/.
 *
 * @param {string} moduleName  — the npm package name to copy
 * @param {string} [parentSrcDir] — source dir of the parent (for pnpm sibling resolution)
 * @param {number} [depth=0]  — recursion depth (for indented logging)
 */
function copyModule(moduleName, parentSrcDir, depth = 0) {
    const indent = '    '.repeat(depth);
    const srcDir = resolveModuleDir(moduleName);
    if (!srcDir) {
        console.warn(`${indent}  ⚠️  ${moduleName}: not found — skipping`);
        return;
    }

    const destDir = path.join(DIST_NODE_MODULES, moduleName);

    // Clean existing copy only at the top level; deeper levels skip if already present
    if (depth === 0) {
        if (fs.existsSync(destDir)) {
            fs.rmSync(destDir, { recursive: true, force: true });
        }
        console.log(`  → Copying ${moduleName}...`);
    }

    copyDirSync(srcDir, destDir);

    // Also copy runtime dependencies (recursively)
    const pkgJsonPath = path.join(srcDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        const deps = Object.keys(pkg.dependencies || {});

        for (const dep of deps) {
            // Skip deps that are not needed at runtime in this extension context
            if (SKIP_DEPS.has(dep)) {
                console.log(`${indent}    ⊘  ${dep} (skipped — not needed for text embedding)`);
                continue;
            }

            const depDest = path.join(DIST_NODE_MODULES, dep);

            // Create a stub for browser-only deps that are statically imported
            // but never executed in Node.js/Electron contexts
            if (STUB_DEPS.has(dep)) {
                if (!fs.existsSync(depDest)) {
                    createStub(dep, depDest);
                }
                continue;
            }
            if (fs.existsSync(depDest)) {
                continue; // Already copied (shared or transitive dependency)
            }

            // In pnpm, deps are in the virtual store alongside the package.
            // e.g. .pnpm/better-sqlite3@11.10.0/node_modules/bindings/
            // Check: 1) nested in package, 2) sibling in pnpm virtual store, 3) hoisted
            const nestedSrc = path.join(srcDir, 'node_modules', dep);
            const pnpmSiblingSrc = path.join(srcDir, '..', dep); // pnpm virtual store layout
            const depSrc = fs.existsSync(nestedSrc) ? nestedSrc :
                           fs.existsSync(pnpmSiblingSrc) ? fs.realpathSync(pnpmSiblingSrc) :
                           resolveModuleDir(dep);

            if (depSrc && fs.existsSync(depSrc)) {
                copyDirSync(depSrc, depDest);
                // Recursively copy transitive dependencies
                copyModule(dep, srcDir, depth + 1);
            } else {
                console.warn(`${indent}    ⚠️  ${dep} (dependency of ${moduleName}): not found`);
            }
        }
    }

    if (depth === 0) {
        console.log(`  ✅ ${moduleName} copied`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
    console.log(`\n📦 Copying external modules to ${DIST_NODE_MODULES}...\n`);

    // Clean and recreate
    if (fs.existsSync(DIST_NODE_MODULES)) {
        fs.rmSync(DIST_NODE_MODULES, { recursive: true, force: true });
    }
    fs.mkdirSync(DIST_NODE_MODULES, { recursive: true });

    for (const mod of EXTERNAL_MODULES) {
        copyModule(mod);
    }

    // Report size
    const totalSize = getDirSize(DIST_NODE_MODULES);
    console.log(`\n📊 Total size of dist/node_modules/: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`✅ External module copy complete.\n`);
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

main();
