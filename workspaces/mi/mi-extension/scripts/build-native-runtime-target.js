#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawnSync, execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

/**
 * Well-known mapping of VS Code minor versions to Electron major.minor.
 * Keep in sync with rebuild-native.js.
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

function getArgValue(name, fallback = undefined) {
    const index = process.argv.indexOf(name);
    if (index === -1 || index + 1 >= process.argv.length) {
        return fallback;
    }
    return process.argv[index + 1];
}

function hasArg(name) {
    return process.argv.includes(name);
}

function run(command, args, dryRun = false) {
    const printable = `${command} ${args.join(' ')}`;
    console.log(`\n$ ${printable}`);

    if (dryRun) {
        return;
    }

    const result = spawnSync(command, args, {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`Command failed with exit code ${result.status}: ${printable}`);
    }
}

/**
 * Auto-detect electron version from the installed VS Code, falling back to
 * the minimum supported version declared in engines.vscode.
 * Mirrors the detection logic in rebuild-native.js.
 */
function autoDetectElectronVersion() {
    // 1. Try `code --version`
    try {
        const cliVersion = execSync('code --version 2>/dev/null', { encoding: 'utf8', timeout: 5000 })
            .split('\n')[0].trim();
        if (/^\d+\.\d+\.\d+/.test(cliVersion)) {
            const key = cliVersion.split('.').slice(0, 2).join('.');
            const electron = VSCODE_TO_ELECTRON[key];
            if (electron) {
                console.log(`ℹ️  Detected VS Code ${cliVersion} → Electron ${electron} (via CLI)`);
                return electron;
            }
        }
    } catch { /* CLI not available */ }

    // 2. macOS: read from app bundle
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
                        const key = appPkg.version.split('.').slice(0, 2).join('.');
                        const electron = VSCODE_TO_ELECTRON[key];
                        if (electron) {
                            console.log(`ℹ️  Detected VS Code ${appPkg.version} → Electron ${electron} (via app bundle)`);
                            return electron;
                        }
                    }
                }
            }
        } catch { /* mdfind not available */ }
    }

    // 3. Fallback: engines.vscode from package.json
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const minVersion = (pkg.engines?.vscode || '').replace(/^[\^~>=<]+/, '');
    const key = minVersion.split('.').slice(0, 2).join('.');
    const electron = VSCODE_TO_ELECTRON[key];
    if (electron) {
        console.log(`ℹ️  Using engines.vscode ${minVersion} → Electron ${electron} (fallback)`);
        return electron;
    }

    return null;
}

function printUsage() {
    console.log(`
Usage:
  node scripts/build-native-runtime-target.js [--platform <os>] [--arch <arch>] [--electron-version <version>] [--dry-run]

  All arguments are optional — platform and arch default to the current machine,
  electron-version is auto-detected from the installed VS Code.

Example:
  node scripts/build-native-runtime-target.js
  node scripts/build-native-runtime-target.js --platform linux --arch x64 --electron-version 34.3.0
`);
}

function main() {
    if (hasArg('--help') || hasArg('-h')) {
        printUsage();
        return;
    }

    const dryRun = hasArg('--dry-run');
    const platform = getArgValue('--platform', process.platform);
    const arch = getArgValue('--arch', process.arch);

    let electronVersion = getArgValue('--electron-version');
    if (!electronVersion) {
        electronVersion = autoDetectElectronVersion();
        if (!electronVersion) {
            throw new Error(
                'Could not auto-detect Electron version. ' +
                'Pass --electron-version explicitly or update VSCODE_TO_ELECTRON in the script.'
            );
        }
    }

    console.log('\n🔧 Building native runtime target bundle');
    console.log(`   platform        : ${platform}`);
    console.log(`   arch            : ${arch}`);
    console.log(`   electronVersion : ${electronVersion}`);
    console.log(`   dryRun          : ${dryRun ? 'yes' : 'no'}`);

    run('node', [
        'scripts/rebuild-native.js',
        '--electron-version', electronVersion,
        '--arch', arch,
    ], dryRun);

    run('node', [
        'scripts/copy-native-modules.js',
        '--platform', platform,
        '--arch', arch,
        '--electron-version', electronVersion,
    ], dryRun);

    console.log(`\n✅ Native runtime target bundle build ${dryRun ? 'dry-run ' : ''}completed.`);
}

try {
    main();
} catch (error) {
    console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
