import { publishShellRuntime, releaseShellRuntime } from '../sandbox/capabilities/runtime.ts';
import { emptyGrants } from '../sandbox/capabilities/authority.ts';
import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import { archiveOriginalToolResult } from '../save-tokens/tool-results/archive.ts';
import { createToolResultHandler } from '../save-tokens/tool-results/core.ts';
import bashExecution from './index.ts';
import piOverrides from '../pi-overrides/index.ts';
import { createToolGroupsExtension } from '../tool-groups/index.ts';

test.each(['before', 'after'] as const)('real Pi compression preserves provenance when registered %s the receipt hook', async order => {
    const cwd = await mkdtemp(resolve(import.meta.dir, '.compressed-provenance-'));
    const previous = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = cwd;
    const owner = Symbol('compressed-provenance');
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: 'disabled' });
    publishShellRuntime(owner, () => ({ state: 'ready', projectRoot: cwd, requestedProfile: 'host', profile: 'host', grants: { ...emptyGrants(), host: true }, requestedGrants: emptyGrants(), authorityPath: '/unused' }));
    let callsToBackend = 0;
    const handler = createToolResultHandler({ backend: { id: 'headroom', compress: async () => { callsToBackend++; return { output: 'derived summary' }; } }, aggregates: false, archiveOriginal: archiveOriginalToolResult });
    const compressor = (pi: ExtensionAPI) => { pi.on('tool_result', event => handler(event, { provider: 'test', id: 'test', contextWindow: 100000 })); };
    const session = await createTestSession({ cwd, extensionFactories: order === 'before' ? [compressor, bashExecution] : [bashExecution, compressor] });
    try {
        const running = session.run(when('Produce output', [calls('safe_bash', { command: "printf 'datum\\n%.0s' {1..500}" }), says('done')]));
        const contexts: string[] = [];
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => { contexts.push(JSON.stringify(context.messages)); return original(model, context, options); };
        await running;
        const result = session.events.toolResultsFor('safe_bash').at(-1)!;
        expect(result.isError, result.text).toBe(false);
        expect(result.text).toContain('derived summary');
        expect(result.details).toMatchObject({ execution: { status: 'unsandboxed', exitCode: 0 }, compression: { sourceExecution: { status: 'unsandboxed', exitCode: 0 } } });
        const details = result.details as { compression: { archivePath: string } };
        expect(await readFile(details.compression.archivePath, 'utf8')).toBe('datum\n'.repeat(500));
        expect(contexts.at(-1)).toContain('Execution provenance:');
        expect(contexts.at(-1)).toContain('unsandboxed');
        expect(callsToBackend).toBe(1);
    } finally {
        session.dispose();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        if (previous === undefined) delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
        else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previous;
        await rm(cwd, { recursive: true, force: true });
    }
}, 30000);

test.each(['before', 'after'] as const)('native archive pagination remains exact with compression registered %s provenance', async order => {
    const cwd = await mkdtemp(resolve(import.meta.dir, '.archive-pages-'));
    const previous = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = cwd;
    let compressions = 0;
    const handler = createToolResultHandler({ backend: { id: 'headroom', compress: async () => { compressions++; return { output: 'compressed' }; } }, aggregates: false, minTokensByGroup: { shell: 0, read: 0, search: 0 } });
    const { hostExecution } = await import('../_shared/execution-provenance/index.ts');
    const sourceExecution = hostExecution('process');
    const path = await archiveOriginalToolResult({ toolCallId: 'paged', toolName: 'bash', text: Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n'), sourceExecution });
    const compressor = [(pi: ExtensionAPI) => { pi.on('tool_result', event => handler(event, { provider: 'test', id: 'test', contextWindow: 100000 })); }];
    const session = await createTestSession({ cwd, extensionFactories: order === 'before' ? [...compressor, bashExecution, piOverrides] : [bashExecution, piOverrides, ...compressor] });
    try {
        await session.run(when('Read the archived page', [calls('read', { path, offset: 101, limit: 3 }), says('done')]));
        const result = session.events.toolResultsFor('read').at(-1)!;
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
        expect(JSON.stringify(result.content)).toContain('line 101\\nline 102\\nline 103');
        expect(JSON.stringify(result.content)).not.toContain('line 100');
        expect(result.details).toMatchObject({ execution: { status: 'unsandboxed', tmpNamespace: 'host' }, outputArchive: { kind: 'output-text', sourceExecution } });
        expect(compressions).toBe(0);
    } finally {
        session.dispose();
        if (previous === undefined) delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
        else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previous;
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi persists host execution provenance and exposes it to the model on success and failure", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".provenance-"));
    await mkdir(resolve(cwd, ".pi"));
    await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify({ safeBash: { mode: "coexist" } }));
    const owner = Symbol("provenance-test");
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: "disabled" });
    publishShellRuntime(owner, () => ({ state: "ready", projectRoot: cwd, requestedProfile: "host", profile: "host", grants: { ...emptyGrants(), host: true }, requestedGrants: emptyGrants(), authorityPath: "/unused" }));
    const session = await createTestSession({
        cwd, extensions: [resolve(import.meta.dir, "index.ts")],
    });
    try {
        const running = session.run(when("Run both commands", [
            calls("bash", { command: "printf first" }),
            calls("safe_bash", { command: "printf second >&2; exit 37" }),
            says("Finished"),
        ]));
        const modelInputs: string[] = [];
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => {
            modelInputs.push(JSON.stringify(context.messages));
            return original(model, context, options);
        };
        await running;
        const results = session.events.messages.filter(m => m.role === "toolResult");
        expect(results).toHaveLength(2);
        expect(results[0]?.content).toEqual([{ type: "text", text: "first" }]);
        for (const result of results) expect(result.details, result.toolName).toMatchObject({
            execution: { status: "unsandboxed", backend: "local", tmpNamespace: "host" },
        });
        expect(results[1]?.isError).toBe(true);
        expect(results[1]?.details).toMatchObject({ execution: { exitCode: 37, outcome: "failed" } });
        expect(modelInputs.at(-1)).toContain("Execution provenance:");
        expect(modelInputs.at(-1)).toContain("unsandboxed");
    } finally {
        session.dispose();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("native read and search operations identify their host namespace", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".native-provenance-"));
    await writeFile(resolve(cwd, "sample.txt"), "needle\n");
    const session = await createTestSession({
        cwd, extensions: [resolve(import.meta.dir, "index.ts"), resolve(import.meta.dir, "../pi-overrides/index.ts")],
        extensionFactories: [createToolGroupsExtension(() => ({ groups: {} }), () => undefined, () => undefined)],
    });
    try {
        await session.run(when("Inspect the file", [
            calls("read", { path: resolve(cwd, "sample.txt") }),
            calls("ls", { path: cwd }),
            calls("grep", { pattern: "needle", path: cwd }),
            calls("find", { pattern: "*.txt", path: cwd }),
            says("Finished"),
        ]));
        for (const name of ["read", "ls", "grep", "find"]) {
            const result = session.events.toolResultsFor(name).at(-1);
            expect(result, name).toMatchObject({ mocked: false, isError: false });
            expect(result?.details, name).toMatchObject({
                execution: { status: "unsandboxed", backend: "host", tmpNamespace: "host" },
            });
        }
    } finally {
        session.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("user bash persists process provenance without modifying its output", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, '.user-provenance-'));
    const previousCwd = process.cwd();
    // Pi's user Bash executor uses the process cwd, as in the interactive CLI.
    process.chdir(cwd);
    const owner = Symbol('user-bash-test');
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: 'disabled' });
    publishShellRuntime(owner, () => ({ state: 'ready', projectRoot: cwd, requestedProfile: 'host', profile: 'host', grants: { ...emptyGrants(), host: true }, requestedGrants: emptyGrants(), authorityPath: '/unused' }));
    const session = await createTestSession({ cwd, extensions: [resolve(import.meta.dir, 'index.ts')] });
    try {
        const command = 'printf user-output';
        const event = await session.session.extensionRunner.emitUserBash({ type: 'user_bash', command, cwd, excludeFromContext: false });
        const result = await session.session.executeBash(command, undefined, { operations: event?.operations });
        expect(result.output).toBe('user-output');
        const receipts = session.session.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'pi.execution.user-bash.v1');
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ data: { execution: { status: 'unsandboxed', exitCode: 0 } } });
        const running = session.run(when('Continue', [says('done')]));
        const inputs: string[] = [];
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => { inputs.push(JSON.stringify(context.messages)); return original(model, context, options); };
        await running;
        expect(inputs.join('')).toContain('Execution provenance:');
        expect(inputs.join('')).toContain('unsandboxed');
    } finally {
        session.dispose();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        process.chdir(previousCwd);
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);
