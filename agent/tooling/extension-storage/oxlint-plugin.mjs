import { relative, resolve } from 'node:path';
import { CONFIG_OWNERS } from '../../extensions/_shared/config-owners.mts';
import {
    extensionOwner,
    isVendoredExtension,
} from '../extension-boundaries/classifier.mjs';

const configFiles = new Set(
    Object.values(CONFIG_OWNERS).flatMap((owner) =>
        [owner.file, owner.legacyFile].filter(Boolean),
    ),
);
const localConfigFiles = new Set(
    [...configFiles].map((file) => file.split('/').at(-1)),
);
const settingsKeys = new Set(
    Object.values(CONFIG_OWNERS)
        .map((owner) => owner.settingsKey)
        .filter(Boolean),
);
// These resources are owned by Pi or external packages, not this storage layout.
const resourceNames = new Set([
    'settings.json',
    'auth.json',
    'models.json',
    'keybindings.json',
    '.env',
    'AGENTS.md',
    'SYSTEM.md',
    'APPEND_SYSTEM.md',
    'agents',
    'roles',
    'skills',
    'extensions',
    'prompts',
    'themes',
    'sessions',
    'bin',
    'git',
    'npm',
    'node_modules',
    'mcp.json',
    'plannotator.json',
]);
const exemptFiles = new Set([
    '_shared/extension-paths.ts',
    '_shared/config-loader.ts',
    '_shared/scripts/extension-layout-migration.ts',
    'sandbox/runtime/integration-fixtures.ts',
]);
// Recovery must read these exact old files. It must not become a general storage bypass.
const recoveryFiles = new Map([
    [
        'sandbox/capabilities/migration.ts',
        new Set(['sandbox.capabilities.json', 'sandbox.global.json']),
    ],
    [
        'sandbox/capabilities/legacy-authority.ts',
        new Set(['sandbox.capabilities.json']),
    ],
]);
const AGENT = '\0agent\0',
    HOME = '\0home\0',
    MANAGED = '\0managed\0',
    MODULE = '\0module\0',
    UNKNOWN = '\0unknown\0';

function propertyName(node) {
    return node.computed ? node.property?.value : node.property?.name;
}

function piTail(value) {
    const parts = value.split(/[\\/]+/).filter(Boolean);
    let start = parts.indexOf(AGENT) + 1;
    if (!start) {
        const pi = parts.indexOf('.pi');
        if (pi < 0) return undefined;
        if (parts[pi + 1] === 'agent') start = pi + 2;
        else if ([HOME, '~'].includes(parts[pi - 1])) return undefined;
        else start = pi + 1;
    }
    return parts.slice(start).filter((part) => part !== '.');
}

const managedPaths = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            managed:
                'Resolve owned extension storage through extensionPath() or extensionConfigPath(), not a manually constructed Pi path.',
            legacy: 'Owned setting "{{key}}" must be loaded through loadExtensionConfig() or readExtensionConfig(), not Pi settings.json.',
        },
    },
    create(context) {
        const root = resolve(process.cwd(), 'extensions');
        const file = relative(root, context.filename).replaceAll('\\', '/');
        if (
            !extensionOwner(context.filename, root) ||
            isVendoredExtension(context.filename, root) ||
            exemptFiles.has(file) ||
            /(?:^|\/)(?:__tests__|testing)\//.test(file) ||
            /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
        )
            return {};
        const source = context.sourceCode;
        function definition(node) {
            if (node?.type !== 'Identifier') return undefined;
            for (
                let scope = source.getScope(node);
                scope;
                scope = scope.upper
            ) {
                const variable = scope.set.get(node.name);
                if (variable) return variable.defs[0];
            }
            return undefined;
        }
        function imported(node) {
            if (node?.type === 'MemberExpression') {
                const object = imported(node.object);
                if (object?.name === '*')
                    return { source: object.source, name: propertyName(node) };
                return undefined;
            }
            const def = definition(node);
            if (def?.type !== 'ImportBinding') return undefined;
            return {
                source: def.parent.source.value,
                name:
                    def.node.type === 'ImportSpecifier'
                        ? def.node.imported.name
                        : '*',
            };
        }
        function pathCall(node) {
            const binding = imported(node?.callee);
            return (
                binding &&
                ['node:path', 'path'].includes(binding.source) &&
                ['join', 'resolve'].includes(binding.name)
            );
        }
        function pathValue(node, seen = new Set()) {
            if (!node || seen.has(node)) return UNKNOWN;
            const next = new Set(seen).add(node);
            switch (node.type) {
                case 'Literal':
                    return typeof node.value === 'string'
                        ? node.value
                        : UNKNOWN;
                case 'TSAsExpression':
                case 'TSSatisfiesExpression':
                case 'TSNonNullExpression':
                case 'ChainExpression':
                case 'AwaitExpression':
                    return pathValue(node.expression ?? node.argument, next);
                case 'Identifier': {
                    if (node.name === '__dirname' && !definition(node))
                        return MODULE;
                    const binding = imported(node);
                    if (
                        binding?.source === '@earendil-works/pi-coding-agent' &&
                        binding.name === 'CONFIG_DIR_NAME'
                    )
                        return '.pi';
                    const def = definition(node);
                    if (
                        def?.type === 'Variable' &&
                        def.node.id.type === 'Identifier' &&
                        def.parent?.kind === 'const'
                    ) {
                        const value = pathValue(def.node.init, next);
                        if (value !== UNKNOWN) return value;
                    }
                    return ['agentDir', 'AGENT_DIR'].includes(node.name)
                        ? AGENT
                        : UNKNOWN;
                }
                case 'MemberExpression':
                    if (
                        node.object.type === 'MetaProperty' &&
                        node.object.meta.name === 'import' &&
                        ['dir', 'url'].includes(propertyName(node))
                    )
                        return MODULE;
                    return propertyName(node) === 'agentDir' ? AGENT : UNKNOWN;
                case 'TemplateLiteral':
                    return node.quasis
                        .map(
                            (part, index) =>
                                (part.value.cooked ?? part.value.raw) +
                                (index < node.expressions.length
                                    ? pathValue(node.expressions[index], next)
                                    : ''),
                        )
                        .join('');
                case 'BinaryExpression':
                    return node.operator === '+'
                        ? pathValue(node.left, next) +
                              pathValue(node.right, next)
                        : UNKNOWN;
                case 'CallExpression': {
                    if (pathCall(node))
                        return node.arguments
                            .map((arg) => pathValue(arg, next))
                            .join('/');
                    const binding = imported(node.callee);
                    if (
                        binding?.source === '@earendil-works/pi-coding-agent' &&
                        binding.name === 'getAgentDir'
                    )
                        return AGENT;
                    if (
                        ['node:os', 'os'].includes(binding?.source) &&
                        binding.name === 'homedir'
                    )
                        return HOME;
                    if (
                        (['node:url', 'url'].includes(binding?.source) &&
                            binding.name === 'fileURLToPath') ||
                        (['node:path', 'path'].includes(binding?.source) &&
                            binding.name === 'dirname')
                    ) {
                        if (pathValue(node.arguments[0], next) === MODULE)
                            return MODULE;
                    }
                    if (
                        binding &&
                        /\/(?:extension-paths|config-loader)(?:\.ts)?$/.test(
                            binding.source,
                        ) &&
                        ['extensionPath', 'extensionConfigPath'].includes(
                            binding.name,
                        )
                    )
                        return MANAGED;
                    return UNKNOWN;
                }
                case 'NewExpression':
                    return node.callee.name === 'URL' &&
                        pathValue(node.arguments[1], next) === MODULE
                        ? `${MODULE}/${pathValue(node.arguments[0], next)}`
                        : UNKNOWN;
                default:
                    return UNKNOWN;
            }
        }
        function unmanaged(value) {
            if (value.includes(MANAGED))
                return value.split(/[\\/]+/).includes('..');
            if (value.startsWith(MODULE + '/'))
                return localConfigFiles.has(value.split(/[\\/]+/).at(-1));
            const tail = piTail(value);
            if (!tail || tail[0] === '..') return false;
            if (!tail.length || tail[0].includes(UNKNOWN)) return false;
            if (recoveryFiles.get(file)?.has(tail.join('/'))) return false;
            if (configFiles.has(tail.join('/')) || configFiles.has(tail[0]))
                return true;
            return !resourceNames.has(tail[0]) || tail.includes('..');
        }
        function settingsObject(node, seen = new Set()) {
            if (!node || seen.has(node)) return false;
            const next = new Set(seen).add(node);
            if (
                [
                    'TSAsExpression',
                    'TSSatisfiesExpression',
                    'TSNonNullExpression',
                    'ChainExpression',
                    'AwaitExpression',
                ].includes(node.type)
            )
                return settingsObject(node.expression ?? node.argument, next);
            if (node.type === 'Identifier') {
                const def = definition(node);
                return (
                    def?.type === 'Variable' &&
                    def.node.id.type === 'Identifier' &&
                    def.parent?.kind === 'const' &&
                    settingsObject(def.node.init, next)
                );
            }
            if (node.type !== 'CallExpression') return false;
            if (
                node.callee.type === 'MemberExpression' &&
                ['getGlobalSettings', 'getProjectSettings'].includes(
                    propertyName(node.callee),
                )
            )
                return true;
            if (
                node.callee.object?.name !== 'JSON' ||
                propertyName(node.callee) !== 'parse'
            )
                return false;
            let read = node.arguments[0];
            if (read?.type === 'AwaitExpression') read = read.argument;
            const binding = imported(read?.callee);
            return (
                ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(
                    binding?.source,
                ) &&
                ['readFile', 'readFileSync'].includes(binding.name) &&
                piTail(pathValue(read.arguments[0]))?.join('/') ===
                    'settings.json'
            );
        }
        function checkSetting(node, key) {
            if (settingsKeys.has(key))
                context.report({ node, messageId: 'legacy', data: { key } });
        }
        function checkPath(node) {
            if (unmanaged(pathValue(node)))
                context.report({ node, messageId: 'managed' });
        }
        function checkSettingsWrite(node, seen = new Set()) {
            if (!node || seen.has(node)) return;
            seen.add(node);
            if (node.type === 'Identifier') {
                const def = definition(node);
                if (def?.type === 'Variable' && def.parent?.kind === 'const')
                    checkSettingsWrite(def.node.init, seen);
            } else if (node.type === 'ObjectExpression') {
                for (const property of node.properties) {
                    if (property.type === 'SpreadElement')
                        checkSettingsWrite(property.argument, seen);
                    else
                        checkSetting(
                            property,
                            property.computed
                                ? pathValue(property.key)
                                : (property.key.name ?? property.key.value),
                        );
                }
            }
        }
        return {
            CallExpression(node) {
                const binding = imported(node.callee);
                if (pathCall(node)) {
                    checkPath(node);
                } else if (
                    [
                        'node:fs',
                        'fs',
                        'node:fs/promises',
                        'fs/promises',
                    ].includes(binding?.source) ||
                    (node.callee.object?.name === 'Bun' &&
                        ['file', 'write'].includes(propertyName(node.callee)))
                ) {
                    checkPath(node.arguments[0]);
                    if (
                        /^(?:copyFile|cp|rename|link|symlink)(?:Sync)?$/.test(
                            binding?.name,
                        )
                    )
                        checkPath(node.arguments[1]);
                    if (
                        piTail(pathValue(node.arguments[0]))?.join('/') ===
                        'settings.json'
                    ) {
                        const content = node.arguments[1];
                        if (
                            content?.callee?.object?.name === 'JSON' &&
                            propertyName(content.callee) === 'stringify'
                        )
                            checkSettingsWrite(content.arguments[0]);
                    }
                }
            },
            NewExpression: checkPath,
            TemplateLiteral: checkPath,
            MemberExpression(node) {
                if (settingsObject(node.object))
                    checkSetting(
                        node,
                        node.computed
                            ? pathValue(node.property)
                            : propertyName(node),
                    );
            },
            VariableDeclarator(node) {
                if (
                    node.id.type !== 'ObjectPattern' ||
                    !settingsObject(node.init)
                )
                    return;
                for (const property of node.id.properties) {
                    if (property.type === 'Property')
                        checkSetting(
                            property,
                            property.computed
                                ? pathValue(property.key)
                                : (property.key.name ?? property.key.value),
                        );
                }
            },
            BinaryExpression(node) {
                if (node.operator === 'in' && settingsObject(node.right))
                    checkSetting(node, pathValue(node.left));
                if (node.operator === '+') checkPath(node);
            },
        };
    },
};

export default {
    meta: { name: 'pi-storage' },
    rules: { 'managed-paths': managedPaths },
};
