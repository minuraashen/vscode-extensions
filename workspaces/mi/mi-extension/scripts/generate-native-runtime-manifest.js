/**
 * Build a semantic runtime bundle manifest from generated zip artifacts.
 *
 * Usage:
 *   node scripts/generate-native-runtime-manifest.js \
 *     --artifacts-dir ./native-runtime-artifacts \
 *     --base-url https://github.com/<owner>/<repo>/releases/download/<tag> \
 *     --out-file ./native-runtime-artifacts/manifest.json
 */

const fs = require('fs');
const path = require('path');

function getArgValue(name, fallback = undefined) {
    const index = process.argv.indexOf(name);
    if (index === -1 || index + 1 >= process.argv.length) {
        return fallback;
    }
    return process.argv[index + 1];
}

function requireArg(name) {
    const value = getArgValue(name);
    if (!value) {
        throw new Error(`Missing required argument: ${name}`);
    }
    return value;
}

function normalizeBaseUrl(baseUrl) {
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function readChecksum(shaPath) {
    if (!fs.existsSync(shaPath)) {
        return undefined;
    }
    const content = fs.readFileSync(shaPath, 'utf8').trim();
    if (!content) {
        return undefined;
    }
    return content.split(/\s+/)[0];
}

function parseRuntimeKeyFromBundle(bundleFileName) {
    const match = bundleFileName.match(/^native-runtime-(.+)\.zip$/);
    if (!match) {
        return null;
    }
    return match[1];
}

function parseRuntimeParts(runtimeKey) {
    const match = runtimeKey.match(/^(.+)-(.+)-electron-(.+)$/);
    if (!match) {
        return null;
    }
    return {
        platform: match[1],
        arch: match[2],
        electronVersion: match[3],
        electronMajor: match[3].split('.')[0],
    };
}

function addBundleEntry(bundles, key, entry) {
    if (!bundles[key]) {
        bundles[key] = entry;
    }
}

function main() {
    const artifactsDir = path.resolve(requireArg('--artifacts-dir'));
    const baseUrl = normalizeBaseUrl(requireArg('--base-url'));
    const outFile = path.resolve(getArgValue('--out-file', path.join(artifactsDir, 'manifest.json')));

    if (!fs.existsSync(artifactsDir)) {
        throw new Error(`Artifacts directory not found: ${artifactsDir}`);
    }

    const bundleFiles = fs.readdirSync(artifactsDir)
        .filter((name) => name.endsWith('.zip') && name.startsWith('native-runtime-'))
        .sort();

    if (bundleFiles.length === 0) {
        throw new Error(`No native runtime zip files found in ${artifactsDir}`);
    }

    const bundles = {};

    for (const bundleFile of bundleFiles) {
        const runtimeKey = parseRuntimeKeyFromBundle(bundleFile);
        if (!runtimeKey) {
            continue;
        }

        const runtimeParts = parseRuntimeParts(runtimeKey);
        if (!runtimeParts) {
            console.warn(`Skipping bundle with unrecognized runtime key: ${bundleFile}`);
            continue;
        }

        const sha256 = readChecksum(path.join(artifactsDir, `${bundleFile}.sha256`));
        const entry = {
            url: `${baseUrl}/${bundleFile}`,
            ...(sha256 ? { sha256 } : {}),
        };

        addBundleEntry(bundles, runtimeKey, entry);
        addBundleEntry(bundles, `${runtimeParts.platform}-${runtimeParts.arch}-electron-${runtimeParts.electronMajor}`, entry);
        addBundleEntry(bundles, `${runtimeParts.platform}-${runtimeParts.arch}`, entry);
    }

    const manifest = {
        generatedAt: new Date().toISOString(),
        bundles,
    };

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));

    console.log(`Manifest written: ${outFile}`);
    console.log(`Bundle entries: ${Object.keys(bundles).length}`);
}

main();
