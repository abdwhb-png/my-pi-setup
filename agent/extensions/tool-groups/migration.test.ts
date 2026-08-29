import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { parseRoleSource } from '../../../../projects/pi-integrations/pi-roles/src/roles.ts';
import {
    isToolGroupsPackageLast,
    TOOL_GROUPS_PACKAGE_SOURCE,
} from '../_shared/tool-groups/package-order.ts';
import { resolveToolAliases } from '../_shared/tool-groups/resolver.ts';

function agentDir(): string {
    return getAgentDir();
}

function parseFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return {};

    const result: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentArray: string[] | null = null;

    for (const line of match[1].split('\n')) {
        const keyMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
        if (keyMatch) {
            if (currentKey && currentArray) result[currentKey] = currentArray;
            currentKey = keyMatch[1];
            let value = keyMatch[2].trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }
            if (value === '' || value === '|' || value === '>') {
                currentArray = [];
            } else {
                result[currentKey] = value;
                currentArray = null;
            }
        } else if (currentKey && currentArray) {
            const value = line.trim();
            if (value.startsWith('- ')) currentArray.push(value.slice(2).trim());
        }
    }
    if (currentKey && currentArray) result[currentKey] = currentArray;
    return result;
}

function getFrontmatterTools(frontmatter: Record<string, unknown>): string[] {
    const raw = frontmatter.tools;
    if (Array.isArray(raw)) {
        return raw.filter((tool): tool is string => typeof tool === 'string');
    }
    if (typeof raw !== 'string') return [];
    return raw
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean);
}

function readSettings(): Record<string, unknown> {
    const path = join(agentDir(), 'settings.json');
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch (cause) {
        throw new Error(`Failed to read/parse settings.json: ${path}`, {
            cause,
        });
    }
}

function readConfiguredGroups(): Record<string, string[]> {
    const path = join(agentDir(), 'tool-groups.json');
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !('groups' in parsed)) {
            throw new Error('missing groups object');
        }
        const groups = parsed.groups;
        if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
            throw new Error('groups must be an object');
        }
        for (const [name, members] of Object.entries(groups)) {
            if (
                !name ||
                !Array.isArray(members) ||
                !members.every((member) => typeof member === 'string')
            ) {
                throw new Error(`invalid group: ${name}`);
            }
        }
        return groups as Record<string, string[]>;
    } catch (cause) {
        throw new Error(`Failed to read/parse tool-groups.json: ${path}`, {
            cause,
        });
    }
}

function configuredMarkdownTools(
    directory: 'roles' | 'agents',
): Array<{ name: string; path: string; content: string; tools: string[] }> {
    const root = join(agentDir(), directory);
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .filter((name) => name.endsWith('.md'))
        .map((name) => {
            const path = join(root, name);
            const content = readFileSync(path, 'utf8');
            return {
                name,
                path,
                content,
                tools: getFrontmatterTools(parseFrontmatter(content)),
            };
        })
        .filter((entry) => entry.tools.length > 0);
}

function configuredSubagentTools(): Array<{ name: string; tools: string[] }> {
    const settings = readSettings();
    const subagents = settings.subagents;
    if (!subagents || typeof subagents !== 'object') return [];
    const overrides = (subagents as Record<string, unknown>).agentOverrides;
    if (!overrides || typeof overrides !== 'object') return [];

    return Object.entries(overrides).flatMap(([name, config]) => {
        if (!config || typeof config !== 'object') return [];
        const tools = (config as Record<string, unknown>).tools;
        return Array.isArray(tools) &&
            tools.every((tool) => typeof tool === 'string')
            ? [{ name, tools }]
            : [];
    });
}

function availableConcreteNames(
    groups: Record<string, string[]>,
    activeNames: string[] = [],
): string[] {
    return [
        ...new Set(
            [...Object.values(groups).flat(), ...activeNames].filter(
                (name) => !name.startsWith('@'),
            ),
        ),
    ];
}

function validateGroupGraph(groups: Record<string, string[]>): string[] {
    const issues: string[] = [];
    const available = availableConcreteNames(groups);

    for (const [name, members] of Object.entries(groups)) {
        if (members.length === 0) issues.push(`${name}: empty group`);
        if (new Set(members).size !== members.length) {
            issues.push(`${name}: duplicate members`);
        }
        const result = resolveToolAliases([`@${name}`], available, groups);
        for (const diagnostic of result.diagnostics) {
            issues.push(`${name}: ${diagnostic.code}: ${diagnostic.member}`);
        }
        if (result.names.length === 0) issues.push(`${name}: empty resolution`);
    }
    return issues;
}

function validateToolList(
    label: string,
    tools: string[],
    groups: Record<string, string[]>,
): string[] {
    const issues: string[] = [];
    if (new Set(tools).size !== tools.length) {
        issues.push(`${label}: duplicate tools`);
    }
    const result = resolveToolAliases(
        tools,
        availableConcreteNames(groups, tools),
        groups,
    );
    for (const diagnostic of result.diagnostics) {
        issues.push(`${label}: ${diagnostic.code}: ${diagnostic.member}`);
    }
    if (result.names.length === 0) issues.push(`${label}: empty resolution`);
    if (new Set(result.names).size !== result.names.length) {
        issues.push(`${label}: duplicate resolved tools`);
    }
    return issues;
}

function resolveGroup(
    name: string,
    groups: Record<string, string[]>,
): string[] {
    return resolveToolAliases(
        [`@${name}`],
        availableConcreteNames(groups),
        groups,
    ).names;
}

function validateProtectedBoundaries(
    groups: Record<string, string[]>,
): string[] {
    const issues: string[] = [];
    for (const required of ['files-write', 'implement']) {
        if (!groups[required]) issues.push(`missing protected group: ${required}`);
    }
    if (issues.length > 0) return issues;

    const fileWrites = new Set(resolveGroup('files-write', groups));
    for (const required of ['edit', 'write']) {
        if (!fileWrites.has(required)) {
            issues.push(`files-write missing ${required}`);
        }
    }

    const implementation = new Set(resolveGroup('implement', groups));
    for (const required of [...fileWrites, 'safe_bash']) {
        if (!implementation.has(required)) {
            issues.push(`implement missing ${required}`);
        }
    }

    const lens = new Set(groups.lens ? resolveGroup('lens', groups) : []);
    const lensWrite = new Set(
        groups['lens-write'] ? resolveGroup('lens-write', groups) : [],
    );
    const mutating = new Set([
        ...fileWrites,
        ...[...lensWrite].filter((tool) => !lens.has(tool)),
    ]);
    for (const name of ['inspect', 'review', 'lens']) {
        if (!groups[name]) continue;
        const leaked = resolveGroup(name, groups).filter((tool) =>
            mutating.has(tool),
        );
        if (leaked.length > 0) {
            issues.push(`${name} contains mutating tools: ${leaked.join(', ')}`);
        }
    }
    return issues;
}

describe('tool-groups configuration invariants', () => {
    it('documents tool groups as the preferred maintainable configuration', () => {
        const instructions = readFileSync(
            join(agentDir(), '..', 'AGENTS.md'),
            'utf8',
        );

        expect(instructions).toContain('Prefer existing tool groups');
        expect(instructions).toContain('agent/tool-groups.json');
        expect(instructions).toContain('exact least-privilege allowlist');
    });

    it('keeps the tool-groups package last', () => {
        const packages = readSettings().packages;
        expect(Array.isArray(packages)).toBe(true);
        if (!Array.isArray(packages)) throw new Error('packages must be an array');
        expect(packages.length).toBeGreaterThan(0);
        const list = packages as Parameters<typeof isToolGroupsPackageLast>[0];
        expect(isToolGroupsPackageLast(list, agentDir())).toBe(true);
        const last = list[list.length - 1];
        expect(typeof last === 'string' ? last : last.source).toBe(
            TOOL_GROUPS_PACKAGE_SOURCE,
        );
    });

    it('keeps group definitions in the dedicated mutable config', () => {
        expect(readSettings().toolGroups).toBeUndefined();
        expect(validateGroupGraph(readConfiguredGroups())).toEqual([]);
    });

    it('preserves protected write and read-only boundaries', () => {
        expect(validateProtectedBoundaries(readConfiguredGroups())).toEqual([]);
    });

    it('registers context-mode tools directly for granular role access', () => {
        const mcpConfig = JSON.parse(
            readFileSync(join(agentDir(), 'mcp.json'), 'utf8'),
        ) as {
            mcpServers?: Record<string, { directTools?: boolean | string[] }>;
        };

        expect(mcpConfig.mcpServers?.['context-mode']?.directTools).toBe(true);
    });

    it('keeps role tool-policy enforcement active in dangerous mode', () => {
        const dangerousModeConfig = JSON.parse(
            readFileSync(join(agentDir(), 'pi-dangerous-mode.json'), 'utf8'),
        ) as { protectedExtensions?: string[] };

        expect(dangerousModeConfig.protectedExtensions).toContain(
            '*tool-groups*',
        );
    });

    it('accepts valid custom groups without a canonical snapshot', () => {
        const groups = {
            inspect: ['read'],
            'files-write': ['edit', 'write'],
            implement: ['@files-write', 'safe_bash'],
            lens: ['read'],
            'lens-write': ['@lens', 'edit'],
            custom: ['@inspect', 'custom_tool'],
        };
        expect(validateGroupGraph(groups)).toEqual([]);
        expect(validateToolList('custom role', ['@custom'], groups)).toEqual(
            [],
        );
    });

    it('rejects missing aliases, cycles, and empty groups', () => {
        expect(
            validateGroupGraph({ broken: ['@missing'], empty: [], ok: ['read'] }),
        ).toEqual(
            expect.arrayContaining([
                expect.stringContaining('missing-group'),
                'empty: empty group',
                'empty: empty resolution',
            ]),
        );
        expect(
            validateGroupGraph({ left: ['@right'], right: ['@left'] }),
        ).toEqual(expect.arrayContaining([expect.stringContaining('cycle')]));
    });

    it('rejects protected boundary widening', () => {
        const groups = {
            inspect: ['read', 'edit'],
            'files-write': ['edit', 'write'],
            implement: ['@files-write', 'safe_bash'],
        };
        expect(validateProtectedBoundaries(groups)).toContain(
            'inspect contains mutating tools: edit',
        );
    });

    for (const directory of ['roles', 'agents'] as const) {
        for (const entry of configuredMarkdownTools(directory)) {
            it(`${directory}/${entry.name} has valid configurable tools`, () => {
                if (directory === 'roles') {
                    expect(() =>
                        parseRoleSource(
                            entry.content,
                            entry.path,
                            'user',
                        ),
                    ).not.toThrow();
                }
                expect(
                    validateToolList(
                        `${directory}/${entry.name}`,
                        entry.tools,
                        readConfiguredGroups(),
                    ),
                ).toEqual([]);
            });
        }
    }

    for (const entry of configuredSubagentTools()) {
        it(`subagent ${entry.name} has valid configurable tools`, () => {
            expect(
                validateToolList(
                    `subagent ${entry.name}`,
                    entry.tools,
                    readConfiguredGroups(),
                ),
            ).toEqual([]);
        });
    }
});
