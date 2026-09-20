import { resolve } from 'node:path';

import { classifyExtensionImport } from './classifier.mjs';

function literalValue(node) {
    return node && typeof node.value === 'string' ? node.value : undefined;
}

function contextFilename(context) {
    return context.filename ?? context.getFilename?.();
}

const noCrossExtensionImport = {
    meta: {
        type: 'problem',
        docs: {
            description: 'enforce Pi extension ownership boundaries',
        },
        schema: [],
        messages: {
            forbidden: '{{reason}}: {{specifier}}',
        },
    },
    create(context) {
        const importer = contextFilename(context);
        const extensionsRoot = resolve(process.cwd(), 'extensions');
        const centralTestOwners = new Set();
        const check = (node, specifier) => {
            if (!importer || !specifier) return;
            const result = classifyExtensionImport({
                importer,
                specifier,
                extensionsRoot,
                centralTestOwners,
            });
            if (!result.allowed) {
                context.report({
                    node,
                    messageId: 'forbidden',
                    data: { reason: result.reason, specifier },
                });
            }
        };
        return {
            ImportDeclaration(node) {
                check(node.source, literalValue(node.source));
            },
            ExportNamedDeclaration(node) {
                check(node.source, literalValue(node.source));
            },
            ExportAllDeclaration(node) {
                check(node.source, literalValue(node.source));
            },
            ImportExpression(node) {
                check(node.source, literalValue(node.source));
            },
            CallExpression(node) {
                if (
                    node.callee?.type === 'Identifier' &&
                    node.callee.name === 'require'
                ) {
                    check(
                        node.arguments?.[0],
                        literalValue(node.arguments?.[0]),
                    );
                    return;
                }
                if (
                    node.callee?.type === 'MemberExpression' &&
                    node.callee.object?.type === 'Identifier' &&
                    node.callee.object.name === 'mock' &&
                    node.callee.property?.type === 'Identifier' &&
                    node.callee.property.name === 'module'
                ) {
                    check(
                        node.arguments?.[0],
                        literalValue(node.arguments?.[0]),
                    );
                }
            },
            TSImportEqualsDeclaration(node) {
                check(
                    node.moduleReference?.expression,
                    literalValue(node.moduleReference?.expression),
                );
            },
        };
    },
};

export default {
    meta: { name: 'pi-boundaries' },
    rules: { 'no-cross-extension-import': noCrossExtensionImport },
};
