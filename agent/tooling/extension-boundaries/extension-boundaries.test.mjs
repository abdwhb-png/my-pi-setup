import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { findExtensionBoundaryViolations } from './check.mjs';
import {
    classifyExtensionImport,
    collectLiteralModuleSpecifiers,
} from './classifier.mjs';

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
        ]);
    });
});

test('repository extension graph respects ownership boundaries', () => {
    expect(findExtensionBoundaryViolations(root)).toEqual([]);
});
