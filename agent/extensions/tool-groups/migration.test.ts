import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { parseRoleSource } from '../../../../projects/pi-integrations/pi-roles/src/roles.ts';
import {
    PI_LENS_READ_ONLY_TOOLS,
    PI_LENS_WRITE_TOOLS,
    TOOL_GROUP_DEFINITIONS,
} from '../_shared/tool-groups/definitions.ts';
import {
    isToolGroupsPackageLast,
    TOOL_GROUPS_PACKAGE_SOURCE,
} from '../_shared/tool-groups/package-order.ts';
import { resolveToolAliases } from '../_shared/tool-groups/resolver.ts';
import { TOOL_GROUP_PREFIX } from '../_shared/tool-groups/types.ts';

// ── fixture available tool names (union of all known tools in this repo) ─
const ALL_TOOLS: string[] = [
    'read',
    'grep',
    'find',
    'ls',
    'write',
    'edit',
    'safe_bash',
    'bash',
    'hypa_shell',
    'contact_supervisor',
    'intercom',
    'web_search',
    'fetch_content',
    'get_search_content',
    'mcp',
    'mcp:context7',
    'mcp:deepwiki',
    'mcp:exa',
    'mcp:youtube-transcript',
    'mcp:youtube-mcp-server',
    'memory',
    'session_search',
    'memory_search',
    'ask_user_question',
    'subagent',
    'todo',
    'write_plan',
    'edit_plan',
    'plan_submit',
    'plan_annotate',
    'session_plan',
    'propose_commit_plan',
    'ast_grep',
    ...PI_LENS_WRITE_TOOLS,
];

// ── expected pre-migration concrete tool SETS (order-insensitive) ─────
const EXPECTED = {
    roles: {
        ask: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'ask_user_question',
            'memory_search',
            'session_search',
            'mcp',
            'web_search',
            'fetch_content',
            'get_search_content',
        ]),
        commiter: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'safe_bash',
            'ask_user_question',
            'memory_search',
            'propose_commit_plan',
        ]),
        'herdr-expert': new Set([
            'safe_bash',
            'hypa_shell',
            'bash',
            'read',
            'ls',
            'grep',
            'find',
            'mcp:deepwiki',
            'mcp:context7',
            'web_search',
            'fetch_content',
            'get_search_content',
        ]),
        plan: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'ask_user_question',
            'write_plan',
            'edit_plan',
            'web_search',
            'fetch_content',
            'get_search_content',
            'mcp',
            'memory',
            'session_search',
            'memory_search',
            'subagent',
            'todo',
            'safe_bash',
            'plan_submit',
            'plan_annotate',
        ]),
        'quick-planner': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'ask_user_question',
            'web_search',
            'fetch_content',
            'get_search_content',
            'mcp',
            'session_plan',
            'session_search',
            'memory_search',
            'todo',
            'subagent',
        ]),
    },
    agents: {
        architect: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'memory_search',
            'mcp:context7',
            'mcp:deepwiki',
            'web_search',
            'fetch_content',
            'get_search_content',
        ]),
        'code-simplifier': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'edit',
            'write',
            'safe_bash',
        ]),
        'expert-reviewer': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'memory_search',
            'mcp:context7',
            'mcp:deepwiki',
            'web_search',
            'fetch_content',
            'get_search_content',
            'intercom',
        ]),
        'factual-researcher': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'safe_bash',
            'mcp:context7',
            'mcp:deepwiki',
            'mcp:exa',
            'web_search',
            'fetch_content',
            'get_search_content',
            'intercom',
            'contact_supervisor',
        ]),
        'performance-reviewer': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'memory_search',
            'mcp:context7',
            'mcp:deepwiki',
            'web_search',
            'fetch_content',
            'get_search_content',
            'intercom',
        ]),
        'pi-expert': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'safe_bash',
            'mcp:context7',
            'mcp:deepwiki',
            'web_search',
            'fetch_content',
            'get_search_content',
            'intercom',
            'contact_supervisor',
        ]),
        'plan-reviewer': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'ast_grep',
            'write',
        ]),
        'sdd-orchestrator': new Set([
            'read',
            'write',
            'edit',
            'grep',
            'find',
            'ls',
            'safe_bash',
            'subagent',
            'intercom',
        ]),
        'task-doer': new Set([
            'read',
            'edit',
            'write',
            'find',
            'ls',
            'grep',
            'safe_bash',
            'contact_supervisor',
        ]),
        videographer: new Set([
            'fetch_content',
            'web_search',
            'get_search_content',
            'mcp:youtube-transcript',
            'mcp:youtube-mcp-server',
        ]),
    },
    subagents: {
        worker: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'write',
            'edit',
            'safe_bash',
            'contact_supervisor',
        ]),
        scout: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'safe_bash',
            'write',
            'intercom',
        ]),
        planner: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'write_plan',
            'intercom',
        ]),
        delegate: new Set([
            'read',
            'grep',
            'find',
            'ls',
            'write',
            'edit',
            'safe_bash',
            'contact_supervisor',
        ]),
        'context-builder': new Set([
            'read',
            'grep',
            'find',
            'ls',
            'safe_bash',
            'write',
            'web_search',
            'get_search_content',
            'fetch_content',
            'ast_grep_search',
            'intercom',
        ]),
    },
};

for (const expected of [
    EXPECTED.roles.ask,
    EXPECTED.roles.commiter,
    EXPECTED.roles.plan,
    EXPECTED.roles['quick-planner'],
    EXPECTED.agents.architect,
    EXPECTED.agents['expert-reviewer'],
    EXPECTED.agents['performance-reviewer'],
    EXPECTED.agents['pi-expert'],
    EXPECTED.agents['plan-reviewer'],
    EXPECTED.agents['sdd-orchestrator'],
    EXPECTED.subagents.scout,
    EXPECTED.subagents.planner,
    EXPECTED.subagents['context-builder'],
]) {
    for (const tool of PI_LENS_READ_ONLY_TOOLS) expected.add(tool);
}

for (const expected of [
    EXPECTED.agents['code-simplifier'],
    EXPECTED.agents['task-doer'],
    EXPECTED.subagents.worker,
    EXPECTED.subagents.delegate,
]) {
    for (const tool of PI_LENS_WRITE_TOOLS) expected.add(tool);
}

// ── helpers ───────────────────────────────────────────────────────────

function agentDir(): string {
    return getAgentDir();
}

/** Read and parse YAML frontmatter from a markdown file. */
function parseFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return {};
    const yaml = match[1];

    // Simple line-based YAML parser (handles only scalar values and arrays)
    const result: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentArray: string[] | null = null;

    for (const line of yaml.split('\n')) {
        const keyMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
        if (keyMatch) {
            // Flush any pending array
            if (currentKey && currentArray !== null) {
                result[currentKey] = currentArray;
                currentArray = null;
            }
            currentKey = keyMatch[1];
            let val = keyMatch[2].trim();
            if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
            ) {
                val = val.slice(1, -1);
            }
            if (val === '' || val === '|' || val === '>') {
                // Multi-line or empty — start array context
                currentArray = [];
            } else {
                result[currentKey] = val;
                currentArray = null;
            }
        } else if (currentKey && currentArray !== null) {
            const trimmed = line.trim();
            if (trimmed.startsWith('- ')) {
                currentArray.push(trimmed.slice(2).trim());
            } else if (trimmed.startsWith('-')) {
                currentArray.push(trimmed.slice(1).trim());
            } else if (trimmed !== '') {
                // continuation line — append to last array element? skip
            }
        }
    }
    // Flush final array
    if (currentKey && currentArray !== null) {
        result[currentKey] = currentArray;
    }

    return result;
}

/** Parse a comma-separated tools string into an array of trimmed tool names. */
function parseCommaTools(val: unknown): string[] {
    if (typeof val !== 'string') return [];
    return val
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** Parse tools frontmatter value — either a comma string or an inline YAML array. */
function getFrontmatterTools(fm: Record<string, unknown>): string[] {
    const raw = fm['tools'];
    if (Array.isArray(raw)) {
        return (raw as string[])
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }
    return parseCommaTools(raw);
}

/** Read settings JSON and return parsed object. */
function readSettings(): Record<string, unknown> {
    const path = join(agentDir(), 'settings.json');
    try {
        const raw = readFileSync(path, 'utf-8');
        return JSON.parse(raw) as Record<string, unknown>;
    } catch (cause) {
        throw new Error(`Failed to read/parse settings.json: ${path}`, {
            cause,
        });
    }
}

/** Read dedicated global tool-groups JSON. */
function readConfiguredGroups(): Record<string, string[]> {
    const path = join(agentDir(), 'tool-groups.json');
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<
            string,
            unknown
        >;
        return raw['groups'] as Record<string, string[]>;
    } catch (cause) {
        throw new Error(`Failed to read/parse tool-groups.json: ${path}`, {
            cause,
        });
    }
}

/** Read a markdown file's content from the appropriate directory. */
function readMd(dir: string, name: string): string {
    const path = join(agentDir(), dir, `${name}.md`);
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
}

// ── tests ─────────────────────────────────────────────────────────────

describe('tool-groups migration', () => {
    describe('package order', () => {
        it('tool-groups package is the final packages entry', () => {
            const settings = readSettings();
            const packages = settings['packages'] as unknown[];
            expect(packages).toBeDefined();
            expect(packages.length).toBeGreaterThan(0);

            const lastRaw = packages[packages.length - 1];
            const lastSource =
                typeof lastRaw === 'string'
                    ? lastRaw
                    : (lastRaw as Record<string, unknown>).source;
            expect(lastSource).toBe(TOOL_GROUPS_PACKAGE_SOURCE);

            // Also verify via the shared utility
            const ad = agentDir();
            const last = isToolGroupsPackageLast(
                packages as Parameters<typeof isToolGroupsPackageLast>[0],
                ad,
            );
            expect(last).toBe(true);
        });
    });

    describe('configured tool groups', () => {
        it('keeps definitions out of settings.json', () => {
            expect(readSettings()['toolGroups']).toBeUndefined();
        });

        it('matches the canonical shared definitions', () => {
            expect(readConfiguredGroups()).toEqual(TOOL_GROUP_DEFINITIONS);
        });

        it('defines nested file-write and implementation capabilities', () => {
            expect(TOOL_GROUP_DEFINITIONS['files-write']).toEqual([
                'edit',
                'write',
            ]);
            expect(TOOL_GROUP_DEFINITIONS['implement']).toEqual([
                '@files-write',
                'safe_bash',
            ]);
        });

        it('assigns implementation capability without widening access', () => {
            for (const name of [
                'code-simplifier',
                'sdd-orchestrator',
                'task-doer',
            ]) {
                const tools = getFrontmatterTools(
                    parseFrontmatter(readMd('agents', name)),
                );
                expect(tools).toContain('@implement');
                expect(tools).not.toContain('edit');
                expect(tools).not.toContain('write');
                expect(tools).not.toContain('safe_bash');
            }

            const settings = readSettings();
            const subagents = settings['subagents'] as Record<string, unknown>;
            const overrides = subagents['agentOverrides'] as Record<
                string,
                Record<string, unknown>
            >;
            for (const name of ['worker', 'delegate']) {
                const tools = overrides[name]['tools'] as string[];
                expect(tools).toContain('@implement');
                expect(tools).not.toContain('edit');
                expect(tools).not.toContain('write');
                expect(tools).not.toContain('safe_bash');
            }
        });

        it('assigns lens aliases to coding roles and agents', () => {
            const assignments: Array<[string, string, string]> = [
                ['roles', 'ask', '@lens'],
                ['roles', 'commiter', '@lens'],
                ['roles', 'plan', '@lens'],
                ['roles', 'quick-planner', '@lens'],
                ['agents', 'architect', '@lens'],
                ['agents', 'code-simplifier', '@lens-write'],
                ['agents', 'expert-reviewer', '@lens'],
                ['agents', 'performance-reviewer', '@lens'],
                ['agents', 'pi-expert', '@lens'],
                ['agents', 'plan-reviewer', '@lens'],
                ['agents', 'sdd-orchestrator', '@lens'],
                ['agents', 'task-doer', '@lens-write'],
            ];

            for (const [dir, name, alias] of assignments) {
                const tools = getFrontmatterTools(
                    parseFrontmatter(readMd(dir, name)),
                );
                expect(tools).toContain(alias);
            }
        });

        it('assigns lens aliases to coding subagents', () => {
            const settings = readSettings();
            const subagents = settings['subagents'] as Record<string, unknown>;
            const overrides = subagents['agentOverrides'] as Record<
                string,
                Record<string, unknown>
            >;
            const assignments: Array<[string, string]> = [
                ['worker', '@lens-write'],
                ['delegate', '@lens-write'],
                ['scout', '@lens'],
                ['planner', '@lens'],
                ['context-builder', '@lens'],
            ];

            for (const [name, alias] of assignments) {
                expect(overrides[name]['tools']).toContain(alias);
            }
        });

        it('keeps general pi roles unrestricted', () => {
            for (const name of ['pi-agent', 'pi-caveman']) {
                const fm = parseFrontmatter(readMd('roles', name));
                expect(fm['tools']).toBeUndefined();
            }
        });
    });

    // ── roles ────────────────────────────────────────────────────────
    describe('role frontmatter tools', () => {
        const CASES: Array<[string, string, Set<string>]> = [
            ['ask', 'roles', EXPECTED.roles.ask],
            ['commiter', 'roles', EXPECTED.roles.commiter],
            ['herdr-expert', 'roles', EXPECTED.roles['herdr-expert']],
            ['plan', 'roles', EXPECTED.roles.plan],
            ['quick-planner', 'roles', EXPECTED.roles['quick-planner']],
        ];

        for (const [name, dir, expected] of CASES) {
            it(`${name}.md tools resolve to expected concrete set`, () => {
                const content = readMd(dir, name);
                parseRoleSource(
                    content,
                    join(agentDir(), dir, `${name}.md`),
                    'user',
                );
                const fm = parseFrontmatter(content);
                const rawTools = getFrontmatterTools(fm);
                expect(rawTools.length).toBeGreaterThan(0);

                const result = resolveToolAliases(
                    rawTools,
                    ALL_TOOLS,
                    readConfiguredGroups(),
                );
                const resolved = new Set(result.names);

                // No unresolved @ aliases
                const leftoverAliases = result.names.filter((n) =>
                    n.startsWith(TOOL_GROUP_PREFIX),
                );
                expect(leftoverAliases).toEqual([]);

                // No diagnostics
                expect(result.diagnostics).toEqual([]);

                // Set equivalence
                expect(resolved).toEqual(expected);
            });
        }
    });

    // ── agents ───────────────────────────────────────────────────────
    describe('agent frontmatter tools', () => {
        const CASES: Array<[string, string, Set<string>]> = [
            ['architect', 'agents', EXPECTED.agents.architect],
            ['code-simplifier', 'agents', EXPECTED.agents['code-simplifier']],
            ['expert-reviewer', 'agents', EXPECTED.agents['expert-reviewer']],
            [
                'factual-researcher',
                'agents',
                EXPECTED.agents['factual-researcher'],
            ],
            [
                'performance-reviewer',
                'agents',
                EXPECTED.agents['performance-reviewer'],
            ],
            ['pi-expert', 'agents', EXPECTED.agents['pi-expert']],
            ['plan-reviewer', 'agents', EXPECTED.agents['plan-reviewer']],
            ['sdd-orchestrator', 'agents', EXPECTED.agents['sdd-orchestrator']],
            ['task-doer', 'agents', EXPECTED.agents['task-doer']],
            ['videographer', 'agents', EXPECTED.agents.videographer],
        ];

        for (const [name, dir, expected] of CASES) {
            it(`${name}.md tools resolve to expected concrete set`, () => {
                const content = readMd(dir, name);
                const fm = parseFrontmatter(content);
                const rawTools = getFrontmatterTools(fm);
                expect(rawTools.length).toBeGreaterThan(0);

                const result = resolveToolAliases(
                    rawTools,
                    ALL_TOOLS,
                    readConfiguredGroups(),
                );
                const resolved = new Set(result.names);

                const leftoverAliases = result.names.filter((n) =>
                    n.startsWith(TOOL_GROUP_PREFIX),
                );
                expect(leftoverAliases).toEqual([]);
                expect(result.diagnostics).toEqual([]);
                expect(resolved).toEqual(expected);
            });
        }
    });

    // ── subagent overrides ───────────────────────────────────────────
    describe('subagent override tools', () => {
        const CASES: Array<[string, Set<string>]> = [
            ['worker', EXPECTED.subagents.worker],
            ['scout', EXPECTED.subagents.scout],
            ['planner', EXPECTED.subagents.planner],
            ['delegate', EXPECTED.subagents.delegate],
            ['context-builder', EXPECTED.subagents['context-builder']],
        ];

        for (const [name, expected] of CASES) {
            it(`${name} override tools resolve to expected concrete set`, () => {
                const settings = readSettings();
                const subagents = settings['subagents'] as Record<
                    string,
                    unknown
                >;
                const overrides = subagents?.['agentOverrides'] as Record<
                    string,
                    unknown
                >;
                const agentCfg = overrides?.[name] as Record<string, unknown>;
                expect(agentCfg).toBeDefined();

                const rawTools = agentCfg['tools'] as string[];
                expect(Array.isArray(rawTools)).toBe(true);
                expect(rawTools.length).toBeGreaterThan(0);

                const result = resolveToolAliases(
                    rawTools,
                    ALL_TOOLS,
                    readConfiguredGroups(),
                );
                const resolved = new Set(result.names);

                const leftoverAliases = result.names.filter((n) =>
                    n.startsWith(TOOL_GROUP_PREFIX),
                );
                expect(leftoverAliases).toEqual([]);
                expect(result.diagnostics).toEqual([]);
                expect(resolved).toEqual(expected);
            });
        }
    });
});
