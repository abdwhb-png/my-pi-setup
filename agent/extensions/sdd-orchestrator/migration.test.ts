import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';

const AGENT_DIR = resolve(import.meta.dir, '..', '..');
const RUN_ID = 'sdd-mqxpovpu-8m9fgo';

function readAgentFile(...parts: string[]): string {
    return readFileSync(join(AGENT_DIR, ...parts), 'utf8');
}

function frontmatterTools(source: string): string[] {
    const raw = /^tools:\s*(.+)$/m.exec(source)?.[1]?.trim();
    if (!raw) return [];
    const value =
        (raw.startsWith("'") && raw.endsWith("'")) ||
        (raw.startsWith('"') && raw.endsWith('"'))
            ? raw.slice(1, -1)
            : raw;
    return value
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean);
}

function section(source: string, start: string, end?: string): string {
    const startIndex = source.indexOf(start);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    const endIndex = end ? source.indexOf(end, startIndex + start.length) : -1;
    if (end) expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex < 0 ? undefined : endIndex);
}

function expectInOrder(source: string, values: readonly string[]): void {
    let previous = -1;
    for (const value of values) {
        const index = source.indexOf(value);
        expect(index).toBeGreaterThan(previous);
        previous = index;
    }
}

function unsupportedOperation(): never {
    throw new Error('Migration status test invoked an unrelated operation.');
}

test('planning base and plan role keep Plannotator planning separate from SDD and quick planning', () => {
    const base = readAgentFile('roles', 'planning-base.md');
    const plan = readAgentFile('roles', 'plan.md');

    expect(frontmatterTools(plan)).toEqual([
        '@inspect',
        '@lens',
        '@web',
        '@docs',
        '@memory',
        'ask_user_question',
        'write_plan',
        'edit_plan',
        'subagent',
        'todo',
        'plan_submit',
        'plan_annotate',
    ]);
    expect(plan).toContain('extends: planning-base');
    expect(plan).toContain('Plannotator');
    expect(plan).toContain('`plan_submit`');
    expect(plan).toContain('plan-auto-switch');
    expect(plan).not.toMatch(/\b(?:SDD|sdd-plan|quick-planner)\b/);
    expect(plan).not.toMatch(/\bwriting-plans?\b/);
    expect(plan).not.toContain('Subagent-Driven');

    expect(base).toContain('name: planning-base');
    expect(base).toContain('Your sole responsibility is planning.');
    expect(base).toContain('Separate verified facts from assumptions');
    expect(base).toContain('Resolve material ambiguities before writing');
    expect(base).toContain(
        'When `planning-base` itself is active, persist the plan with `session_plan`',
    );
    expect(base).not.toMatch(/\b(?:Plannotator|SDD|quick-planner)\b/);
});

test('sdd-plan owns the parser-exact deterministic workflow and manual Direct handoff', () => {
    const plan = readAgentFile('roles', 'sdd-plan.md');
    const workflow = section(plan, '## Workflow', '## Boundaries');

    expect(plan).toContain('extends: planning-base');
    expect(frontmatterTools(plan)).toEqual([
        '@inspect',
        '@lens',
        '@web',
        '@docs',
        '@memory',
        'ask_user_question',
        'write_plan',
        'edit_plan',
        'subagent',
        'todo',
        'safe_bash',
        'sdd_prepare',
        'sdd_approve',
        'sdd_status',
        'sdd_result',
        'sdd_cancel',
        'sdd_direct_complete',
    ]);
    expect(plan).toContain('exact `### Task N: Title`');
    expect(plan).toContain('~~~sdd-task');
    for (const key of ['"id"', '"dependsOn"', '"files"', '"verify"']) {
        expect(plan).toContain(key);
    }
    expectInOrder(workflow, [
        '### 2. Write a Compiler-Valid Plan',
        '### 3. Review the Plan',
        '### 4. Prepare the Manifest',
    ]);
    expect(workflow).toContain('Use the `writing-plans` skill');
    expect(workflow).toContain('Launch `plan-reviewer`');
    expect(plan).toContain('until the plan is stable');
    expect(plan).toContain(
        '`sdd_prepare` owns the `orchestration-assessor` launch',
    );
    expect(plan).toContain('exactly one typed manifest approval');
    expect(plan).toContain('interactive overlay or `sdd_approve`, never both');
    expect(plan).toContain(
        'Before any non-TUI `sdd_approve` call, show the user the exact compiled decision and obtain explicit approval of those exact values',
    );
    expect(plan).toContain('switch roles manually');
    expect(plan).not.toMatch(/\b(?:Plannotator|quick-planner|plan_submit)\b/);
});

test('plan role preserves the Plannotator review loop and automatic implementation handoff', () => {
    const plan = readAgentFile('roles', 'plan.md');
    const workflow = section(plan, '## Workflow', '## Fallback');

    expectInOrder(workflow, [
        '### 1. Discovery and Research',
        '### 2. Resolve Ambiguities',
        '### 3. Write the Plan',
        '### 4. Submit for Browser Review',
        '### 5. Annotate Non-Plan Files',
    ]);
    expect(workflow).toContain('RED, GREEN, refactor');
    expect(workflow).toContain('Call `plan_submit` with the saved plan path');
    expect(workflow).toContain(
        'let `plan-auto-switch` perform the configured implementation-role handoff',
    );
    expect(workflow).toContain('Update the same file');
    expect(workflow).toContain('submit the same path again');
});

test('quick-planner inherits the planning method without referencing other planning workflows', () => {
    const quick = readAgentFile('roles', 'quick-planner.md');

    expect(quick).toContain('extends: planning-base');
    expect(frontmatterTools(quick)).toEqual([
        '@inspect',
        '@lens',
        '@docs',
        'ask_user_question',
        'session_plan',
        'session_search',
        'memory_search',
        'todo',
        'subagent',
    ]);
    expect(quick).toContain('`session_plan`');
    expect(quick).not.toMatch(/\b(?:SDD|sdd-plan|Plannotator)\b/);
    expect(quick).not.toContain('sdd_');
    expect(quick).not.toMatch(/\bwriting-plans?\b/);
});

test('legacy agent operates only on an explicitly authorized exact run', () => {
    const legacy = readAgentFile('agents', 'sdd-orchestrator.md');

    expect(legacy).toContain('description: Legacy-only');
    expect(frontmatterTools(legacy)).toEqual([
        '@inspect',
        '@lens',
        '@implement',
        'subagent',
        'intercom',
    ]);
    expect(legacy).toContain('explicit user authorization for one exact run ID');
    expectInOrder(legacy, [
        '`^[A-Za-z0-9][A-Za-z0-9_-]*$`',
        '`<runId>.json`',
    ]);
    expect(legacy).toContain(
        'Reject traversal-shaped or otherwise invalid IDs before constructing a path or accessing any file',
    );
    expect(legacy).toContain('`<runId>.json`');
    expect(legacy).toContain('explicitly authorizes deletion');
    expect(legacy).not.toContain('Run continuously');
    expect(legacy).not.toContain('first entry alphabetically');
    expect(legacy).not.toContain('Go to step 1');
    expect(legacy).not.toMatch(/`\.sdd\/(?:queue|progress|results)\//);
    for (const directory of ['queue', 'progress', 'results']) {
        expect(legacy).toContain(
            `~/.pi/agent/.sdd/${directory}/<runId>.json`,
        );
    }
});

test('portable legacy fixture survives dynamic extension import and temporary-store status', async () => {
    const temporaryAgentDir = mkdtempSync(join(tmpdir(), 'sdd-migration-'));
    try {
        const queueDirectory = join(temporaryAgentDir, '.sdd', 'queue');
        mkdirSync(queueDirectory, { recursive: true });
        const temporaryQueuePath = join(queueDirectory, `${RUN_ID}.json`);
        const portablePlanPath =
            '~/projects/pi-integrations/pi-roles/docs/plans/portable.md';
        const queueBefore = `${JSON.stringify(
            { runId: RUN_ID, planPath: portablePlanPath },
            null,
            2,
        )}\n`;
        writeFileSync(temporaryQueuePath, queueBefore);

        const { registerSddExtension } = await import('./index.ts');
        const { SddStore } = await import('./store.ts');
        const tools = new Map<
            string,
            {
                execute: (...args: unknown[]) => Promise<{
                    content: Array<{ text: string }>;
                    details: { snapshot: unknown };
                }>;
            }
        >();
        const pi = {
            registerTool(tool: { name: string }) {
                tools.set(tool.name, tool as never);
            },
            registerCommand() {},
            appendEntry() {},
            on() {},
        };
        registerSddExtension(pi as never, {
            agentDir: temporaryAgentDir,
            store: new SddStore(temporaryAgentDir),
            delegation: { run: unsupportedOperation, dispose() {} },
            workflow: {
                run: unsupportedOperation,
                cancel: unsupportedOperation,
                completeDirect: unsupportedOperation,
                reconcile: unsupportedOperation,
            },
        } as never);

        const status = tools.get('sdd_status');
        expect(status).toBeDefined();
        const result = await status!.execute(
            'migration-status',
            { runId: RUN_ID },
            undefined,
            undefined,
            { cwd: temporaryAgentDir, mode: 'print' },
        );
        expect(result.content[0].text).toContain(
            `${RUN_ID}: legacy_queued (${portablePlanPath})`,
        );
        expect(result.details.snapshot).toMatchObject({
            runId: RUN_ID,
            status: 'legacy_queued',
            planPath: portablePlanPath,
        });
        const temporaryQueueAfter = readFileSync(temporaryQueuePath, 'utf8');
        expect(temporaryQueueAfter).toBe(queueBefore);
    } finally {
        rmSync(temporaryAgentDir, { recursive: true, force: true });
    }
});
