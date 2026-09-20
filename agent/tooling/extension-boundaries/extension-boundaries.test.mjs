import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { findExtensionBoundaryViolations } from './check.mjs';
import {
    classifyExtensionImport,
    collectLiteralModuleSpecifiers,
} from './classifier.mjs';
import {
    extensionSourceRole,
    findUnreachableExtensionModules,
} from './reachability.mjs';

const root = resolve(import.meta.dir, '../../extensions');
const classify = (importer, specifier, centralTestOwners = new Set()) =>
    classifyExtensionImport({
        importer: resolve(root, importer),
        specifier,
        extensionsRoot: root,
        centralTestOwners,
    });

describe('Pi extension boundary classifier', () => {
    test('allows same-owner, shared, and package imports', () => {
        expect(classify('tool-groups/index.ts', './config.ts').allowed).toBe(
            true,
        );
        expect(
            classify('tool-groups/index.ts', '../_shared/tool-policy/index.ts')
                .allowed,
        ).toBe(true);
        expect(classify('tool-groups/index.ts', 'node:path').allowed).toBe(
            true,
        );
    });

    test('rejects sibling and shared-to-extension imports', () => {
        expect(
            classify('tool-groups/index.ts', '../pi-roles/core/roles.ts')
                .allowed,
        ).toBe(false);
        expect(
            classify(
                '_shared/file-search/path-resolver.ts',
                '../../pi-overrides/config.ts',
            ).allowed,
        ).toBe(false);
    });

    test('allows one public single-file owner but rejects central multi-owner tests', () => {
        const owners = new Set();
        expect(
            classify('__tests__/notify.test.ts', '../notify.ts', owners)
                .allowed,
        ).toBe(true);
        expect(
            classify(
                '__tests__/notify.test.ts',
                '../openai-codex-fast-mode.ts',
                owners,
            ).allowed,
        ).toBe(false);
    });

    test('requires integration tests to use the public loader', () => {
        expect(
            classify(
                '__tests__/integration/runtime.test.ts',
                '../../sandbox/runtime/service.ts',
            ).allowed,
        ).toBe(false);
    });

    test('discovers every literal module-loading form', () => {
        const source = [
            'import value from "../one";',
            'export { value } from "../two";',
            'const dynamic = import("../three");',
            'const required = require("../four");',
            'import legacy = require("../five");',
            'mock.module("../six", () => ({}));',
            'import type { Seven } from "../seven";',
            'export { type Eight } from "../eight";',
            'const worker = new URL("../nine", import.meta.url);',
        ].join('\n');
        expect(
            collectLiteralModuleSpecifiers(source).map(
                ({ specifier }) => specifier,
            ),
        ).toEqual([
            '../one',
            '../two',
            '../three',
            '../four',
            '../five',
            '../six',
            '../seven',
            '../eight',
            '../nine',
        ]);
    });
});

test('production reachability follows runtime and type-only imports without requiring test imports', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-extension-graph-'));
    const fixtureRoot = join(fixture, 'extensions');
    try {
        mkdirSync(join(fixtureRoot, 'demo'), { recursive: true });
        mkdirSync(join(fixtureRoot, 'demo', 'scripts'), { recursive: true });
        mkdirSync(join(fixtureRoot, '_shared', 'testing'), {
            recursive: true,
        });
        writeFileSync(
            join(fixtureRoot, 'demo', 'index.ts'),
            'import "./runtime.js"; export default function demo() {}',
        );
        writeFileSync(
            join(fixtureRoot, 'demo', 'runtime.ts'),
            'import type { Contract } from "./contract.ts"; export const value = 1;',
        );
        writeFileSync(
            join(fixtureRoot, 'demo', 'contract.ts'),
            'export interface Contract { value: number }',
        );
        writeFileSync(
            join(fixtureRoot, 'demo', 'orphan.ts'),
            'export const orphan = true;',
        );
        writeFileSync(
            join(fixtureRoot, 'demo', 'scripts', 'inspect.ts'),
            'process.stdout.write("ok");',
        );
        writeFileSync(
            join(fixtureRoot, '_shared', 'testing', 'fixture.ts'),
            'export const fixture = true;',
        );

        expect(
            extensionSourceRole(
                join(fixtureRoot, 'demo', 'scripts', 'inspect.ts'),
                fixtureRoot,
            ),
        ).toBe('standalone');
        expect(findUnreachableExtensionModules(fixtureRoot)).toEqual([
            'demo/orphan.ts',
        ]);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});

test('repository extension graph respects ownership boundaries', () => {
    expect(findExtensionBoundaryViolations(root)).toEqual([]);
});

test('repository production modules are reachable from declared entrypoints', () => {
    expect(findUnreachableExtensionModules(root)).toEqual([]);
});
