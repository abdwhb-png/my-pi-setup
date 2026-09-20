import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
    classifyExtensionImport,
    collectLiteralModuleSpecifiers,
    isVendoredExtension,
} from './classifier.mjs';
import { findUnreachableExtensionModules } from './reachability.mjs';

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/i;

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
            if (SOURCE_FILE.test(name) && !name.endsWith('.d.ts'))
                files.push(path);
        }
    };
    visit(root);
    return files;
}

export function findExtensionBoundaryViolations(extensionsRoot) {
    const root = resolve(extensionsRoot);
    const violations = [];
    for (const importer of sourceFiles(root)) {
        const centralTestOwners = new Set();
        const source = readFileSync(importer, 'utf8');
        for (const { specifier, kind } of collectLiteralModuleSpecifiers(
            source,
        )) {
            const result = classifyExtensionImport({
                importer,
                specifier,
                extensionsRoot: root,
                centralTestOwners,
            });
            if (result.allowed) continue;
            violations.push({
                file: relative(root, importer),
                specifier,
                kind,
                reason: result.reason,
            });
        }
    }
    return violations;
}

if (import.meta.main) {
    const root = resolve(process.argv[2] ?? 'extensions');
    const violations = findExtensionBoundaryViolations(root);
    const unreachable = findUnreachableExtensionModules(root);
    if (violations.length === 0 && unreachable.length === 0) {
        console.log('Extension boundaries: OK');
        process.exit(0);
    }
    for (const violation of violations) {
        console.error(
            `${violation.file}: ${violation.specifier} (${violation.reason})`,
        );
    }
    for (const file of unreachable) {
        console.error(
            `${file}: production module is unreachable from an extension or standalone entrypoint`,
        );
    }
    console.error(
        `Extension boundaries: ${violations.length} import violation(s), ${unreachable.length} unreachable module(s)`,
    );
    process.exit(1);
}
