import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

import {
    collectLiteralModuleSpecifiers,
    isPublicExtensionEntrypoint,
    isVendoredExtension,
} from './classifier.mjs';

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_FILE = /(?:^|\.)((?:integration\.)?test|spec)\.[cm]?[jt]sx?$/i;
const STANDALONE_DIRECTORIES = new Set([
    'benchmarks',
    'e2e',
    'evals',
    'scripts',
]);
const TEST_SUPPORT_FILES = new Set([
    'integration-fixtures.ts',
    'runtime-harness.preload.ts',
    'test-runtime-fixture.ts',
]);

function normalized(path) {
    return path.replaceAll('\\', '/');
}

function sourceFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            const metadata = lstatSync(path);
            if (metadata.isSymbolicLink()) continue;
            if (metadata.isDirectory()) {
                if (name === 'node_modules') continue;
                if (!isVendoredExtension(path, root)) visit(path);
                continue;
            }
            if (
                SOURCE_FILE.test(name) &&
                !name.endsWith('.d.ts') &&
                !TEST_FILE.test(name)
            ) {
                files.push(resolve(path));
            }
        }
    };
    visit(root);
    return files;
}

export function extensionSourceRole(path, extensionsRoot) {
    const candidate = normalized(relative(extensionsRoot, path));
    const parts = candidate.split('/');
    const basename = parts.at(-1);
    if (
        parts[0] === '__tests__' ||
        parts.includes('testing') ||
        TEST_SUPPORT_FILES.has(basename)
    ) {
        return 'test-support';
    }
    if (parts.some((part) => STANDALONE_DIRECTORIES.has(part))) {
        return 'standalone';
    }
    return 'runtime';
}

function isDeclaredEntrypoint(path, extensionsRoot) {
    const source = readFileSync(path, 'utf8');
    return (
        isPublicExtensionEntrypoint(path, extensionsRoot) ||
        /\bexport\s+default\s+(?:async\s+)?function\b/.test(source) ||
        /\bimport\.meta\.main\b/.test(source) ||
        /@extension-reachability-root\b/.test(source)
    );
}

function resolutionCandidates(importer, specifier) {
    const clean = specifier.split(/[?#]/, 1)[0];
    const base = resolve(dirname(importer), clean);
    const extension = extname(base);
    const stem = extension ? base.slice(0, -extension.length) : base;
    return [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.cts`,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.mts`,
        `${stem}.cts`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
        join(base, 'index.mts'),
        join(base, 'index.cts'),
    ];
}

function resolveLocalModule(importer, specifier, sourceSet) {
    if (!specifier.startsWith('.')) return undefined;
    return resolutionCandidates(importer, specifier).find((candidate) =>
        sourceSet.has(candidate),
    );
}

export function findUnreachableExtensionModules(extensionsRoot) {
    const root = resolve(extensionsRoot);
    const allSources = sourceFiles(root);
    const sources = allSources.filter(
        (path) => extensionSourceRole(path, root) !== 'test-support',
    );
    const sourceSet = new Set(sources);
    const roots = sources.filter(
        (path) =>
            extensionSourceRole(path, root) === 'standalone' ||
            isDeclaredEntrypoint(path, root),
    );
    const reachable = new Set();
    const pending = [...roots];
    while (pending.length > 0) {
        const importer = pending.pop();
        if (!importer || reachable.has(importer)) continue;
        reachable.add(importer);
        const source = readFileSync(importer, 'utf8');
        for (const { specifier } of collectLiteralModuleSpecifiers(source)) {
            const imported = resolveLocalModule(importer, specifier, sourceSet);
            if (imported && !reachable.has(imported)) pending.push(imported);
        }
    }
    return sources
        .filter((path) => !reachable.has(path))
        .map((path) => normalized(relative(root, path)))
        .sort((left, right) => left.localeCompare(right));
}
