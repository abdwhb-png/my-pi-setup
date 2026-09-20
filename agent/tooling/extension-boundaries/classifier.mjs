import { dirname, extname, relative, resolve } from 'node:path';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const VENDORED_OWNERS = new Set([
    'aldoborrero-pi-agent-kit',
    'ogulcancelik-pi-extensions',
]);

function normalized(path) {
    return path.replaceAll('\\', '/');
}

function relativeToExtensions(path, extensionsRoot) {
    const candidate = normalized(relative(extensionsRoot, path));
    return candidate === '' || candidate === '.' ? '' : candidate;
}

export function extensionOwner(path, extensionsRoot) {
    const candidate = relativeToExtensions(path, extensionsRoot);
    if (!candidate || candidate === '..' || candidate.startsWith('../')) {
        return undefined;
    }
    const [first] = candidate.split('/');
    return SOURCE_EXTENSION.test(first)
        ? first.slice(0, -extname(first).length)
        : first;
}

export function isVendoredExtension(path, extensionsRoot) {
    const owner = extensionOwner(path, extensionsRoot);
    return owner !== undefined && VENDORED_OWNERS.has(owner);
}

export function isIntegrationTest(path, extensionsRoot) {
    return relativeToExtensions(path, extensionsRoot).startsWith(
        '__tests__/integration/',
    );
}

export function isCentralTest(path, extensionsRoot) {
    return relativeToExtensions(path, extensionsRoot).startsWith('__tests__/');
}

export function isPublicExtensionEntrypoint(path, extensionsRoot) {
    const candidate = relativeToExtensions(path, extensionsRoot);
    if (!candidate || candidate.startsWith('../')) return false;
    const parts = candidate.split('/');
    if (parts.length === 1) return SOURCE_EXTENSION.test(parts[0]);
    return (
        parts.length === 2 &&
        parts[1] === `index${extname(parts[1])}` &&
        SOURCE_EXTENSION.test(parts[1])
    );
}

function targetPath(importer, specifier) {
    const clean = specifier.split(/[?#]/, 1)[0];
    return resolve(dirname(importer), clean);
}

export function classifyExtensionImport({
    importer,
    specifier,
    extensionsRoot,
    centralTestOwners = new Set(),
}) {
    if (!specifier.startsWith('.')) return { allowed: true };

    const sourceOwner = extensionOwner(importer, extensionsRoot);
    const target = targetPath(importer, specifier);
    const targetOwner = extensionOwner(target, extensionsRoot);
    if (!sourceOwner || !targetOwner) return { allowed: true };
    if (VENDORED_OWNERS.has(sourceOwner) || VENDORED_OWNERS.has(targetOwner)) {
        return { allowed: true };
    }

    if (sourceOwner === '__tests__') {
        if (targetOwner === '_shared' || targetOwner === '__tests__') {
            return { allowed: true, targetOwner };
        }
        if (isIntegrationTest(importer, extensionsRoot)) {
            return {
                allowed: false,
                targetOwner,
                reason: 'Integration tests must load public extension entrypoints through the Pi harness',
            };
        }
        if (!isPublicExtensionEntrypoint(target, extensionsRoot)) {
            return {
                allowed: false,
                targetOwner,
                reason: 'Central unit tests may import only one public single-file extension entrypoint',
            };
        }
        centralTestOwners.add(targetOwner);
        if (centralTestOwners.size > 1) {
            return {
                allowed: false,
                targetOwner,
                reason: 'Multi-extension tests belong in extensions/__tests__/integration',
            };
        }
        return { allowed: true, targetOwner };
    }

    if (targetOwner === '_shared' || targetOwner === sourceOwner) {
        return { allowed: true, targetOwner };
    }
    return {
        allowed: false,
        targetOwner,
        reason:
            sourceOwner === '_shared'
                ? 'Shared code must not depend on an extension implementation'
                : `Extension ${sourceOwner} must use a shared contract instead of importing ${targetOwner}`,
    };
}

export function collectLiteralModuleSpecifiers(source) {
    const parseableSource = source.startsWith('#!')
        ? source.replace(/^#![^\n]*(?:\n|$)/, '')
        : source;
    const imports = new Bun.Transpiler({ loader: 'ts' })
        .scanImports(parseableSource)
        .map(({ path, kind }) => ({ specifier: path, kind }));
    const mockModules = [];
    const pattern = /\bmock\s*\.\s*module\s*\(\s*(["'])([^"']+)\1/g;
    for (const match of parseableSource.matchAll(pattern)) {
        mockModules.push({ specifier: match[2], kind: 'mock-module' });
    }
    const erasedImports = [];
    const erasedPatterns = [
        /\bimport\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?(["'])([^"']+)\1/g,
        /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+(["'])([^"']+)\1/g,
    ];
    for (const erasedPattern of erasedPatterns) {
        for (const match of parseableSource.matchAll(erasedPattern)) {
            erasedImports.push({
                specifier: match[2],
                kind: 'type-only-import',
            });
        }
    }
    const moduleUrls = [];
    const moduleUrlPattern =
        /\bnew\s+URL\s*\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;
    for (const match of parseableSource.matchAll(moduleUrlPattern)) {
        moduleUrls.push({ specifier: match[2], kind: 'module-url' });
    }

    const seen = new Set();
    return [...imports, ...mockModules, ...erasedImports, ...moduleUrls].filter(
        (entry) => {
            if (seen.has(entry.specifier)) return false;
            seen.add(entry.specifier);
            return true;
        },
    );
}
