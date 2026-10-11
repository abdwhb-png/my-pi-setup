import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpToolName } from '@earendil-works/pi-coding-agent';
import { startFixtureMcp } from '../../extensions/__tests__/integration/fixtures/local-mcp.ts';

const candidateRoot = process.env.PI_SUBAGENTS_CANDIDATE_ROOT;
if (!candidateRoot)
    throw new Error(
        'Set PI_SUBAGENTS_CANDIDATE_ROOT to the built package. Daily settings are never changed.',
    );
const installedRoot = dirname(
    realpathSync(fileURLToPath(import.meta.resolve('pi-subagents'))),
);
const samples = Number(process.env.PI_BASELINE_SAMPLES ?? 20);
const warmups = Number(process.env.PI_BASELINE_WARMUPS ?? 5);
const scenarios = process.env.PI_BASELINE_SCENARIOS?.split(',') ?? [
    'foreground',
    'async',
    'parallel',
    'dependent',
    'interrupt-resume',
];
const results: unknown[] = [];
const output = resolve(
    process.env.PI_BASELINE_OUTPUT ??
        join(tmpdir(), 'pi-delegation-baseline.json'),
);
const fixture = join(import.meta.dir, 'fixture-provider.ts');

async function* measureArm(scenario: string, arm: 'reference' | 'candidate') {
    const root = mkdtempSync(join(tmpdir(), 'pi-baseline-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const packageRoot = realpathSync(
        arm === 'reference' ? installedRoot : candidateRoot,
    );
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    mkdirSync(join(agentDir, 'agents'), { recursive: true });
    writeFileSync(join(cwd, 'proof.txt'), 'baseline-proof');
    writeFileSync(
        join(agentDir, 'agents', 'reader.md'),
        '---\nname: reader\ndescription: Deterministic baseline reader\n---\nInspect the fixture.\n',
    );
    const overrides = Object.fromEntries(
        ['reader', 'scout'].map((agent) => [
            agent,
            { model: 'baseline-child/target', thinking: 'high' },
        ]),
    );
    const projectOverrides = Object.fromEntries(
        ['reader', 'scout'].map((agent) => [
            agent,
            {
                tools:
                    scenario === 'foreground'
                        ? ['read']
                        : ['read', 'mcp:fixture/echo'],
            },
        ]),
    );
    const calls: string[] = [];
    let mcpInitializations = 0;
    const server = startFixtureMcp(calls, (request) => {
        if (request.method === 'POST')
            void request
                .clone()
                .json()
                .then((body) => {
                    if (body.method === 'initialize') mcpInitializations++;
                });
    });
    writeFileSync(
        join(agentDir, 'mcp.json'),
        JSON.stringify({
            mcpServers: {
                fixture: { url: `${server.url}mcp`, exposure: 'direct' },
            },
        }),
    );
    writeFileSync(
        join(agentDir, 'settings.json'),
        JSON.stringify({
            packages: [packageRoot],
            extensions: [fixture],
            subagents: {
                control: { enabled: false },
                intercomBridge: { mode: 'off' },
                subagentOnlyExtensions: [fixture],
                agentOverrides: overrides,
            },
        }),
    );
    writeFileSync(
        join(cwd, '.pi', 'settings.json'),
        JSON.stringify({ subagents: { agentOverrides: projectOverrides } }),
    );
    const child = spawn(
        process.execPath,
        [
            process.env.PI_TEST_CLI ?? join(homedir(), '.pi', 'bin', 'pi'),
            '--mode',
            'rpc',
            '--offline',
            '--no-session',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-context-files',
            '--approve',
            '--provider',
            'baseline-parent',
            '--model',
            'driver',
        ],
        {
            cwd,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                PATH: process.env.PATH,
                HOME: root,
                PI_CODING_AGENT_DIR: agentDir,
                PI_PACKAGE_FINALIZER_ACTIVE: '1',
                PI_OFFLINE: '1',
                PI_BASELINE_ARM: arm,
                PI_SUBAGENTS_TEMP_ROOT: join(root, 'runs'),
            },
        },
    );
    const exited = once(child, 'exit');
    let buffer = '',
        stderr = '',
        seq = 0;
    const events: Record<string, any>[] = [];
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines)
            if (line.startsWith('{')) {
                try {
                    events.push(JSON.parse(line));
                } catch {
                    /* Non-JSON diagnostics are kept in stderr by Pi. */
                }
            }
    });
    child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-12000);
    });
    async function wait(
        predicate: (event: Record<string, any>) => boolean,
        offset = 0,
    ) {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            const error = events
                .slice(offset)
                .find((event) => event.type === 'baseline_error');
            if (error) throw new Error(JSON.stringify(error));
            const event = events.slice(offset).find(predicate);
            if (event) return event;
            if (child.exitCode !== null) break;
            await Bun.sleep(20);
        }
        throw new Error(
            `Missing baseline event (${arm}/${scenario}): ${JSON.stringify(events.slice(-8))}\n${stderr}`,
        );
    }
    async function command(message: string) {
        const id = `command-${++seq}`;
        child.stdin.write(
            JSON.stringify({ type: 'prompt', id, message }) + '\n',
        );
        await wait(
            (event) =>
                event.type === 'response' &&
                event.id === id &&
                event.command === 'prompt',
        );
    }
    function evidence() {
        const path = join(cwd, 'calls.jsonl');
        return existsSync(path)
            ? readFileSync(path, 'utf8')
                  .trim()
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line))
            : [];
    }
    let activeId: string | undefined;
    try {
        const ready = await wait((event) => event.type === 'baseline_ready');
        const warmOffset = events.length;
        await command('/baseline warm');
        await wait((event) => event.type === 'agent_end', warmOffset);
        if (arm === 'candidate' && scenario === 'foreground') {
            const preflightOffset = events.length;
            await command('/baseline preflight builtin');
            const preflight = await wait(
                (event) =>
                    event.type === 'baseline_receipt' && event.id === 'builtin',
                preflightOffset,
            );
            if (
                !preflight.result.ok ||
                !String(preflight.result.contract.model).startsWith(
                    'baseline-child/target',
                )
            )
                throw new Error(
                    `Builtin preflight: ${JSON.stringify(preflight)}`,
                );
            results.push({
                kind: 'qualification',
                arm,
                packageRoot,
                preflight: preflight.result,
            });
            const directOffset = events.length,
                callOffset = evidence().length;
            await command('/baseline direct builtin-direct');
            await wait((event) => event.type === 'agent_end', directOffset);
            const proof = evidence().slice(callOffset);
            if (
                !proof.length ||
                proof[0].model !== 'baseline-child/target' ||
                proof[0].reasoning !== 'high'
            )
                throw new Error(
                    `Builtin execution contract: ${JSON.stringify(proof)}`,
                );
            results.push({
                kind: 'qualification',
                arm,
                path: 'direct-builtin',
                evidence: proof,
            });
            if (process.env.PI_BASELINE_QUALIFICATION === 'extended') {
                for (const path of [
                    'builtin-foreground',
                    'builtin-async',
                    'builtin-workflow',
                    'builtin-hold',
                ]) {
                    const id = `qualification-${path}`,
                        offset = events.length,
                        callOffset = evidence().length;
                    await command(`/baseline ${path} ${id}`);
                    let receipt = await wait(
                        (event) =>
                            event.type === 'baseline_receipt' &&
                            event.id === id,
                        offset,
                    );
                    if (path === 'builtin-hold') {
                        const deadline = Date.now() + 45000;
                        while (
                            !evidence()
                                .slice(callOffset)
                                .some((row) =>
                                    row.task.includes('"toolResult"'),
                                ) &&
                            Date.now() < deadline
                        )
                            await Bun.sleep(20);
                        const interruptOffset = events.length;
                        await command(`/baseline interrupt ${id}`);
                        await wait(
                            (event) =>
                                event.type === 'baseline_native_terminal' &&
                                event.completion.id === receipt.result.runId,
                            interruptOffset,
                        );
                        await command('/baseline change-model configuration');
                        const resumeOffset = events.length;
                        await command(`/baseline resume ${id}`);
                        receipt = await wait(
                            (event) =>
                                event.type === 'baseline_receipt' &&
                                event.id === id,
                            resumeOffset,
                        );
                        if (!receipt.result.resumedFrom)
                            throw new Error('Missing resume lineage.');
                    }
                    if (path !== 'builtin-foreground') {
                        const terminal = await wait(
                            (event) =>
                                event.type === 'baseline_native_terminal' &&
                                event.completion.id === receipt.result.runId,
                            offset,
                        );
                        if (!terminal.completion.success)
                            throw new Error(
                                `Builtin path failed: ${JSON.stringify(terminal)}`,
                            );
                        const restoredOffset = events.length;
                        await command(`/baseline inspect-restored ${id}`);
                        const restored = await wait(
                            (event) =>
                                event.type === 'baseline_receipt' &&
                                event.id === id,
                            restoredOffset,
                        );
                        if (
                            restored.result.status !== 'completed' ||
                            !restored.result.steps.length ||
                            restored.result.steps[0].value?.kind !==
                                'structured'
                        )
                            throw new Error(
                                `Restored result unavailable: ${JSON.stringify(restored)}`,
                            );
                    } else if (receipt.result.status !== 'completed')
                        throw new Error(
                            `Builtin foreground failed: ${JSON.stringify(receipt)}`,
                        );
                    const childProof = evidence().slice(callOffset);
                    if (
                        !childProof.length ||
                        childProof.some(
                            (row) =>
                                row.model !== 'baseline-child/target' ||
                                row.reasoning !== 'high' ||
                                row.tools.includes('write'),
                        )
                    )
                        throw new Error(
                            `Builtin execution mismatch: ${JSON.stringify(childProof)}`,
                        );
                    results.push({
                        kind: 'qualification',
                        arm,
                        path,
                        receipt,
                        evidence: childProof,
                    });
                    if (path === 'builtin-hold')
                        await command('/baseline restore-model configuration');
                }
                writeFileSync(
                    output,
                    JSON.stringify({ samples, warmups, results }, null, 2) +
                        '\n',
                );
            }
        }
        for (let index = -warmups; index < samples; index++) {
            const id = `${arm}-${scenario}-${index}`;
            const offset = events.length,
                callOffset = evidence().length,
                mcpOffset = calls.length,
                initializationOffset = mcpInitializations;
            const requestAt = Date.now();
            await command(
                `/baseline ${scenario === 'interrupt-resume' ? 'hold' : scenario} ${id}`,
            );
            const receipt = await wait(
                (event) => event.type === 'baseline_receipt' && event.id === id,
                offset,
            );
            let terminal = receipt;
            if (scenario !== 'foreground') {
                activeId = receipt.result.runId;
                if (scenario === 'interrupt-resume') {
                    const deadline = Date.now() + 45000;
                    while (
                        !evidence()
                            .slice(callOffset)
                            .some(
                                (row) =>
                                    row.task.includes(id) &&
                                    row.task.includes('"toolResult"') &&
                                    row.task.includes(
                                        JSON.stringify(
                                            createMcpToolName(
                                                'fixture',
                                                'echo',
                                            ),
                                        ),
                                    ),
                            ) &&
                        Date.now() < deadline
                    )
                        await Bun.sleep(20);
                    if (calls.length === mcpOffset)
                        throw new Error(
                            'Interrupt fixture did not finish its MCP probe.',
                        );
                    const interruptOffset = events.length;
                    await command(`/baseline interrupt ${id}`);
                    await wait(
                        (event) =>
                            event.type === 'baseline_native_terminal' &&
                            event.completion.id === activeId,
                        interruptOffset,
                    );
                    const resumeOffset = events.length;
                    await command(`/baseline resume ${id}`);
                    const resumed = await wait(
                        (event) =>
                            event.type === 'baseline_receipt' &&
                            event.id === id,
                        resumeOffset,
                    );
                    activeId =
                        resumed.result.runId ?? resumed.result.details?.asyncId;
                    terminal = await wait(
                        (event) =>
                            event.type === 'baseline_native_terminal' &&
                            event.completion.id === activeId,
                        resumeOffset,
                    );
                } else
                    terminal = await wait(
                        (event) =>
                            event.type === 'baseline_native_terminal' &&
                            event.completion.id === activeId,
                        offset,
                    );
                if (terminal.completion.success !== true)
                    throw new Error(
                        `Child failed: ${JSON.stringify(terminal)}`,
                    );
                activeId = undefined;
            } else if (receipt.result.status !== 'completed')
                throw new Error(
                    `Foreground failed: ${JSON.stringify(receipt)}`,
                );
            const proof = evidence().slice(callOffset);
            if (
                !proof.length ||
                proof.some(
                    (row) =>
                        row.model !== 'baseline-child/target' ||
                        row.reasoning !== 'high' ||
                        row.tools.includes('write'),
                )
            )
                throw new Error(
                    `Child contract mismatch: ${JSON.stringify(proof)}`,
                );
            const firstCall = Math.min(...proof.map((row) => row.time));
            if (scenario !== 'foreground' && calls.length === mcpOffset)
                throw new Error(
                    'Delegation did not execute its native MCP probe.',
                );
            const row = {
                arm,
                scenario,
                index,
                packageRoot,
                packageVersion: JSON.parse(
                    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
                ).version,
                sdkRoot: ready.sdkRoot,
                parentEntrypoint: ready.entrypoint,
                requestAt,
                preparationMs: receipt.end - receipt.start,
                firstProviderCallMs: firstCall - requestAt,
                completionMs: (terminal.time ?? terminal.end) - requestAt,
                sampledMaxRssBytes: Math.max(...proof.map((row) => row.rss)),
                childProcesses: new Set(
                    proof
                        .filter((row) => row.pid !== ready.pid)
                        .map((row) => row.pid),
                ).size,
                runtimes: [...new Set(proof.map((row) => row.runtime))],
                mcpCalls: calls.length - mcpOffset,
                mcpInitializations: mcpInitializations - initializationOffset,
            };
            if (index >= 0) results.push(row);
            writeFileSync(
                output,
                JSON.stringify({ samples, warmups, results }, null, 2) + '\n',
            );
            process.stdout.write(
                JSON.stringify({
                    arm,
                    scenario,
                    index,
                    completionMs: row.completionMs,
                }) + '\n',
            );
            yield row;
        }
    } catch (error) {
        writeFileSync(
            output + '.failure.json',
            JSON.stringify(
                {
                    arm,
                    scenario,
                    events,
                    evidence: evidence(),
                    stderr,
                    error: String(error),
                },
                null,
                2,
            ) + '\n',
        );
        throw error;
    } finally {
        if (activeId && child.exitCode === null) {
            const cleanupOffset = events.length;
            child.stdin.write(
                JSON.stringify({
                    type: 'prompt',
                    id: 'cleanup',
                    message: `/baseline stop ${activeId}`,
                }) + '\n',
            );
            await Promise.race([
                wait(
                    (event) =>
                        event.type === 'baseline_receipt' &&
                        event.id === activeId,
                    cleanupOffset,
                ).catch((error) => {
                    stderr += `\nCleanup control failed: ${String(error)}`;
                }),
                Bun.sleep(2000),
            ]);
        }
        // Async runners detach from the parent group. Only signal recorded PIDs still bound to this isolated root.
        for (const pid of new Set(evidence().map((row) => row.pid))) {
            if (process.platform !== 'linux' || pid === child.pid) continue;
            try {
                const environment = readFileSync(
                    `/proc/${pid}/environ`,
                    'utf8',
                ).split('\0');
                if (
                    environment.includes(
                        `PI_SUBAGENTS_TEMP_ROOT=${join(root, 'runs')}`,
                    )
                )
                    process.kill(-pid, 'SIGTERM');
            } catch (error) {
                if (
                    (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
                    (error as NodeJS.ErrnoException).code !== 'ESRCH'
                ) {
                    process.exitCode = 1;
                    process.stderr.write(
                        `Fixture process cleanup failed: ${String(error)}\n`,
                    );
                }
            }
        }
        if (child.pid && child.exitCode === null)
            process.kill(-child.pid, 'SIGTERM');
        const timer = setTimeout(() => {
            if (child.pid && child.exitCode === null)
                process.kill(-child.pid, 'SIGKILL');
        }, 2000);
        try {
            await exited;
        } finally {
            clearTimeout(timer);
            await server.stop(true);
            rmSync(root, { recursive: true, force: true });
        }
    }
}
for (const scenario of scenarios) {
    const arms = [
        measureArm(scenario, 'reference'),
        measureArm(scenario, 'candidate'),
    ];
    try {
        if (samples + warmups === 0) for (const arm of arms) await arm.next();
        for (let index = -warmups; index < samples; index++)
            for (const arm of arms) await arm.next();
    } finally {
        for (const arm of arms) await arm.return();
    }
}
process.stdout.write(`Evidence: ${output}\n`);
