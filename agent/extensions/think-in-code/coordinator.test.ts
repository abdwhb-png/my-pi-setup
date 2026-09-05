import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import type {
    ExtensionContext,
    TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    claimSafeExecutionBroker,
    publishSafeExecutionService,
    releaseSafeExecutionBroker,
} from "../_shared/safe-execution/broker.ts";
import {
    claimAnalysisSandboxBroker,
    publishAnalysisSandboxService,
    releaseAnalysisSandboxBroker,
} from "../_shared/analysis/sandbox-analysis-broker.ts";
import type { SafeExecutionService } from "../_shared/safe-execution/core.ts";
import type { AnalysisSandboxService } from "../sandbox/analysis/client.ts";
import { normalizeAnalysisRequest } from "../sandbox/analysis/protocol.ts";
import { runQuickJsAnalysis } from "../sandbox/analysis/quickjs-worker.ts";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "./config.ts";
import { ThinkStore, __getRawDatabase } from "./storage/store.ts";
import { ThinkCoordinator, __test } from "./coordinator.ts";
import type { ExecuteRequest } from "./types.ts";

const ownerSymbol = Symbol("coordinator-test");

function ctx(cwd: string): ExtensionContext {
    return {
        cwd,
        hasUI: false,
        ui: {},
    } as unknown as ExtensionContext;
}

function fakeSafeExecution(
    textFor: (command: string) => string,
): SafeExecutionService {
    return {
        execute: mock(async (request) => {
            const text = textFor(request.command);
            return {
                content: [{ type: "text" as const, text }],
                details: undefined,
            };
        }),
    };
}

function fakeAnalysis(
    result: { output: string; stderr?: string },
): AnalysisSandboxService {
    return {
        run: mock(async () => ({
            output: result.output,
            stderr: result.stderr ?? "",
            runtime: "quickjs" as const,
            durationMs: 1,
            truncated: false,
        })),
        shutdown: async () => undefined,
    };
}

describe("ThinkCoordinator", () => {
    let home: string | undefined;
    let store: ThinkStore | undefined;
    let coordinator: ThinkCoordinator | undefined;

    beforeEach(() => {
        claimSafeExecutionBroker(ownerSymbol);
        claimAnalysisSandboxBroker(ownerSymbol);
    });

    afterEach(async () => {
        coordinator?.close();
        store?.close();
        releaseSafeExecutionBroker(ownerSymbol);
        releaseAnalysisSandboxBroker(ownerSymbol);
        if (home) await rm(home, { recursive: true, force: true });
        home = undefined;
        store = undefined;
        coordinator = undefined;
    });

    async function setup(
        safeExec?: SafeExecutionService,
        analysis?: AnalysisSandboxService,
    ): Promise<{ store: ThinkStore; coordinator: ThinkCoordinator }> {
        home = await mkdtemp(join(tmpdir(), "think-in-code-coord-"));
        const storeRoot = join(home, "store");
        await mkdir(storeRoot, { recursive: true });
        const safe = safeExec ?? fakeSafeExecution(() => "ok");
        publishSafeExecutionService(ownerSymbol, safe);
        const analysisSvc =
            analysis ?? fakeAnalysis({ output: "derived text" });
        publishAnalysisSandboxService(ownerSymbol, analysisSvc);
        store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot,
            canonicalPath: "/workspace/proj",
        });
        coordinator = new ThinkCoordinator({ store, config: DEFAULT_THINK_IN_CODE_CONFIG });
        return { store, coordinator };
    }

    it("preserves guard denial evidence and shows no raw stdout", async () => {
        const { SafeExecutionError } = await import(
            "../_shared/safe-execution/failure.ts"
        );
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new SafeExecutionError(
                    "guard",
                    "dangerous command blocked",
                    "dangerous command blocked",
                );
            }),
        };
        const { coordinator } = await setup(
            safeExec,
            fakeAnalysis({ output: "ignored" }),
        );
        const request: ExecuteRequest = {
            id: "exec-1",
            language: "javascript",
            program: "1+1",
            source: { kind: "command", command: "sudo something" },
        };
        const result = await coordinator.execute(request, ctx("/workspace/proj"));
        expect(safeExec.execute).toHaveBeenCalledTimes(1);
        expect(result.content[0]?.text).toContain("dangerous");
        expect(result.details.blockedReason).toContain("dangerous");
        expect(result.details.archiveIds).toEqual([]);
    });

    it("strips raw stdout from a non-zero-exit safe-execution error", async () => {
        const secret = "SECRET_TOKEN_FROM_FAILING_COMMAND_DO_NOT_LEAK";
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error(
                    `${secret}\n\nCommand exited with code 1`,
                );
            }),
        };
        const { coordinator } = await setup(safeExec);
        const result = await coordinator.execute(
            {
                id: "exec-nonzero",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "cat secret.txt; exit 1" },
            },
            ctx("/workspace/proj"),
        );
        // Raw bytes must never appear; only the safe exit-code suffix reaches
        // the LLM-facing content text and details.blockedReason.
        expect(result.content[0]?.text).toBe("Command exited with code 1");
        expect(result.details.blockedReason).toBe("Command exited with code 1");
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("strips raw stdout from a timed-out safe-execution error", async () => {
        const secret = "STDOUT_FROM_INFINITE_LOOP_DO_NOT_LEAK";
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error(
                    `${secret}\n\nCommand timed out after 30 seconds`,
                );
            }),
        };
        const { coordinator } = await setup(safeExec);
        const result = await coordinator.execute(
            {
                id: "exec-timeout",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "yes" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.content[0]?.text).toBe(
            "Command timed out after 30 seconds",
        );
        expect(result.details.blockedReason).toBe(
            "Command timed out after 30 seconds",
        );
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("strips raw stdout from an aborted safe-execution error", async () => {
        const secret = "ABORTED_STDOUT_DO_NOT_LEAK";
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error(`${secret}\n\nCommand aborted`);
            }),
        };
        const { coordinator } = await setup(safeExec);
        const result = await coordinator.execute(
            {
                id: "exec-abort",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "long-running" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.content[0]?.text).toBe("Command aborted");
        expect(result.details.blockedReason).toBe("Command aborted");
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("scrubs raw stdout from a raw safe-execution error with no recognizable suffix", async () => {
        // Even when bash.js throws a plain Error with no recognizable suffix,
        // we must not surface the raw message to the LLM. The coordinator
        // reclassifies it as a generic failure and never includes the raw
        // message in content, details, INDEX search, or streamed updates.
        const secret = "SUPER_SECRET_RAW_PAYLOAD_NO_SUFFIX";
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error(secret);
            }),
        };
        const { coordinator } = await setup(safeExec);
        const result = await coordinator.execute(
            {
                id: "exec-raw-error",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
        );
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(result.content[0]?.text).not.toContain(secret);
        expect(result.details.blockedReason ?? "").not.toContain(secret);
    });

    it("does not index raw stdout from safe-execution errors into the search index", async () => {
        const secret = "INDEXED_SECRET_FROM_FAILING_COMMAND_DO_NOT_LEAK";
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error(`${secret}\n\nCommand exited with code 2`);
            }),
        };
        const { coordinator } = await setup(safeExec);
        // Force an archive so the index step actually runs.
        await coordinator.execute(
            {
                id: "exec-archive",
                language: "javascript",
                program: "INPUT",
                source: { kind: "content", content: "harmless" },
            },
            ctx("/workspace/proj"),
        );
        await coordinator.execute(
            {
                id: "exec-fail-indexed",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "failing" },
            },
            ctx("/workspace/proj"),
        );
        const search = await coordinator.search({
            id: "search-secret",
            query: secret,
        });
        expect(search.details.archiveIds.length).toBe(0);
        for (const row of search.content) {
            expect(row.text).not.toContain(secret);
        }
    });

    it("archives nonzero command output for isolated analysis without public leaks", async () => {
        const raw = "FAILED_COMMAND_STDERR_SECRET_DO_NOT_LEAK";
        const { SafeExecutionError } = await import(
            "../_shared/safe-execution/failure.ts"
        );
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new SafeExecutionError(
                    "bash_exit",
                    "Command exited with code 17",
                    raw,
                );
            }),
        };
        const analysis = fakeAnalysis({ output: "failure-derived" });
        const { coordinator, store } = await setup(safeExec, analysis);

        const result = await coordinator.execute(
            {
                id: "exec-failed-command-archive",
                language: "javascript",
                program: "export default INPUT",
                source: { kind: "command", command: "failing-command" },
            },
            ctx("/workspace/proj"),
        );

        expect(analysis.run).toHaveBeenCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({ INPUT: raw }),
            }),
            undefined,
        );
        expect(result.content[0]?.text).toBe("failure-derived");
        expect(result.details.blockedReason).toBeUndefined();
        expect(result.details.archiveIds).toHaveLength(2);
        expect(store.readArchives([result.details.archiveIds[0]!], 1024)[0]?.data).toBe(raw);
        expect(JSON.stringify(result)).not.toContain(raw);
    });

    it("archives failed batch command output for isolated analysis without public leaks", async () => {
        const raw = "FAILED_BATCH_STDERR_SECRET_DO_NOT_LEAK";
        const { SafeExecutionError } = await import(
            "../_shared/safe-execution/failure.ts"
        );
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new SafeExecutionError(
                    "bash_exit",
                    "Command exited with code 9",
                    raw,
                );
            }),
        };
        const analysis = fakeAnalysis({ output: "batch-failure-derived" });
        const { coordinator, store } = await setup(safeExec, analysis);

        const result = await coordinator.batchExecute(
            {
                id: "batch-failed-command-archive",
                language: "javascript",
                program: "export default INPUTS.length",
                items: [{ id: "failed", command: "failing-command" }],
            },
            ctx("/workspace/proj"),
        );

        expect(analysis.run).toHaveBeenCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({
                    INPUTS: [
                        expect.objectContaining({ output: raw }),
                    ],
                }),
            }),
            undefined,
        );
        expect(result.content[0]?.text).toBe("batch-failure-derived");
        expect(result.details.items).toEqual([
            expect.objectContaining({
                id: "failed",
                status: "failed",
                byteCount: Buffer.byteLength(raw, "utf8"),
            }),
        ]);
        expect(result.details.archiveIds).toHaveLength(2);
        expect(store.readArchives([result.details.archiveIds[0]!], 1024)[0]?.data).toBe(raw);
        expect(JSON.stringify(result)).not.toContain(raw);
    });

    it("injects bounded raw command and archive data into the analyzer", async () => {
        const analysis = fakeAnalysis({ output: "derived" });
        const { coordinator } = await setup(
            fakeSafeExecution(() => "command-payload"),
            analysis,
        );
        const first = await coordinator.execute(
            {
                id: "exec-raw-1",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "printf payload" },
            },
            ctx("/workspace/proj"),
        );
        expect(analysis.run).toHaveBeenLastCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({ INPUT: "command-payload" }),
            }),
            undefined,
        );
        const sourceArchiveId = first.details.archiveIds[0]!;
        await coordinator.execute(
            {
                id: "exec-raw-2",
                language: "javascript",
                program: "INPUT",
                source: { kind: "archives", archiveIds: [sourceArchiveId] },
            },
            ctx("/workspace/proj"),
        );
        expect(analysis.run).toHaveBeenLastCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({ INPUT: "command-payload" }),
            }),
            undefined,
        );
    });

    it("archives complete analyzer output separately from the returned view", async () => {
        const output = "analysis-complete-output";
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "source"),
            fakeAnalysis({ output }),
        );
        const result = await coordinator.execute(
            {
                id: "exec-analysis-archive",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo source" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.details.archiveIds).toHaveLength(2);
        const analysisArchive = store.readArchives([result.details.archiveIds[1]!], 1024)[0];
        expect(analysisArchive?.data).toBe(output);
    });

    it("never returns raw archive bytes to the LLM and only emits derived content", async () => {
        const safeExec = fakeSafeExecution(() =>
            "raw-bytes-that-must-not-leak: sk-abcdefghijklmnopqrstuv",
        );
        const { coordinator } = await setup(
            safeExec,
            fakeAnalysis({ output: "DERIVED" }),
        );
        const result = await coordinator.execute(
            {
                id: "exec-2",
                language: "javascript",
                program: "INPUT.length",
                source: { kind: "command", command: "echo raw" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.content[0]?.text).toBe("DERIVED");
        expect(result.details.derivedBytes).toBe(7);
        expect(result.details.archiveIds.length).toBe(2);
        // Raw bytes must not appear in content text or details.
        expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnopqrstuv");
    });

    it("archives every output and indexes a bounded summary after capture", async () => {
        const safeExec = fakeSafeExecution(() => "archive-target payload");
        const { coordinator, store } = await setup(
            safeExec,
            fakeAnalysis({ output: "summary line" }),
        );
        const result = await coordinator.execute(
            {
                id: "exec-3",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "ls" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.details.archiveIds.length).toBe(2);
        const db = __getRawDatabase(store);
        const rowCount = (
            db.query("SELECT COUNT(*) AS c FROM documents").get() as { c: number }
        ).c;
        expect(rowCount).toBeGreaterThan(0);
    });

    it("makes storage failure visible but does not bypass isolation", async () => {
        const safeExec = fakeSafeExecution(() => "ok");
        const { coordinator } = await setup(
            safeExec,
            fakeAnalysis({ output: "ok" }),
        );
        // Force index failure by closing the store mid-call.
        coordinator.store.close();
        const result = await coordinator.execute(
            {
                id: "exec-4",
                language: "javascript",
                program: "1",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
        );
        // Storage failure is visible via captureWarnings (the archive step
        // runs first; with the store closed, it throws).
        expect(result.details.captureWarnings.length).toBeGreaterThan(0);
        expect(result.details.archiveIds.length).toBe(0);
    });

    it("blocks execute when safe execution or analysis is unavailable", async () => {
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error("Safe execution unavailable: stub");
            }),
        };
        const { coordinator } = await setup(safeExec, fakeAnalysis({ output: "x" }));
        const result = await coordinator.execute(
            {
                id: "exec-5",
                language: "javascript",
                program: "1",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.details.blockedReason).toContain("Safe execution unavailable");
    });

    it("rejects execute_file paths that escape the project root", async () => {
        const { coordinator } = await setup();
        const result = await coordinator.executeFile(
            {
                id: "exec-file-1",
                path: "../../etc/passwd",
                language: "javascript",
                program: "FILE_PATH",
            },
            ctx(home!),
        );
        expect(result.details.blockedReason).toContain("escapes project root");
    });

    it("rejects an absent execute_file before archive or analysis without leaking cwd", async () => {
        const analysis = fakeAnalysis({ output: "must not run" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        const result = await coordinator.executeFile(
            {
                id: "exec-file-absent",
                path: "missing.txt",
                language: "javascript",
                program: "FILE_PATH",
            },
            ctx(home!),
        );
        expect(result.details.blockedReason).toBe("File not found: missing.txt");
        expect(result.details.archiveIds).toEqual([]);
        expect(analysis.run).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(home!);
        expect(store.archiveBytes()).toBe(0);
    });

    it("rejects an execute_file directory before archive or analysis", async () => {
        const analysis = fakeAnalysis({ output: "must not run" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        await mkdir(join(home!, "subdir"), { recursive: true });
        const dirResult = await coordinator.executeFile(
            {
                id: "exec-file-directory",
                path: "subdir",
                language: "javascript",
                program: "FILE_PATH",
            },
            ctx(home!),
        );
        expect(dirResult.details.blockedReason).toContain("not a regular file");
        expect(dirResult.details.archiveIds).toEqual([]);
        expect(analysis.run).not.toHaveBeenCalled();
        expect(store.archiveBytes()).toBe(0);
    });

    it("rejects a FIFO without blocking on open", async () => {
        const analysis = fakeAnalysis({ output: "must not run" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        const fifoPath = join(home!, "input.fifo");
        const created = Bun.spawnSync(["mkfifo", fifoPath]);
        expect(created.exitCode).toBe(0);

        const result = await Promise.race([
            coordinator.executeFile(
                {
                    id: "exec-file-fifo",
                    path: "input.fifo",
                    language: "javascript",
                    program: "FILE_CONTENT",
                },
                ctx(home!),
            ),
            Bun.sleep(1_000).then(() => {
                throw new Error("FIFO open blocked");
            }),
        ]);

        expect(result.details.blockedReason).toContain("not a regular file");
        expect(result.details.archiveIds).toEqual([]);
        expect(analysis.run).not.toHaveBeenCalled();
        expect(store.archiveBytes()).toBe(0);
    });

    it("accepts an internal symlink and canonicalizes FILE_PATH", async () => {
        const analysis = fakeAnalysis({ output: "derived" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        await mkdir(join(home!, "nested"), { recursive: true });
        const target = join(home!, "nested", "target.txt");
        await writeFile(target, "internal target", "utf8");
        await symlink(join("nested", "target.txt"), join(home!, "link.txt"));

        const result = await coordinator.executeFile(
            {
                id: "exec-file-internal-link",
                path: "link.txt",
                language: "javascript",
                program: "FILE_PATH",
            },
            ctx(home!),
        );

        expect(result.details.blockedReason).toBeUndefined();
        expect(result.details.archiveIds).toHaveLength(2);
        expect(analysis.run).toHaveBeenCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({
                    FILE_CONTENT: "internal target",
                    FILE_PATH: target,
                }),
            }),
            undefined,
        );
        expect(store.archiveBytes()).toBeGreaterThan(0);
    });

    it("rejects an outgoing symlink from the opened descriptor before archive or analysis", async () => {
        const analysis = fakeAnalysis({ output: "must not run" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        const outside = await mkdtemp(join(tmpdir(), "think-file-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "outside", "utf8");
            await symlink(
                join(outside, "secret.txt"),
                join(home!, "outgoing.txt"),
            );

            const result = await coordinator.executeFile(
                {
                    id: "exec-file-outgoing-link",
                    path: "outgoing.txt",
                    language: "javascript",
                    program: "FILE_PATH",
                },
                ctx(home!),
            );

            expect(result.details.blockedReason).toContain("escapes project root");
            expect(result.details.archiveIds).toEqual([]);
            expect(analysis.run).not.toHaveBeenCalled();
            expect(store.archiveBytes()).toBe(0);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("rejects invalid UTF-8 before archive or analysis without transcoding", async () => {
        const analysis = fakeAnalysis({ output: "must not run" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        await writeFile(
            join(home!, "binary.dat"),
            Buffer.from([0x41, 0xc3, 0x28, 0x42]),
        );

        const result = await coordinator.executeFile(
            {
                id: "exec-file-binary",
                path: "binary.dat",
                language: "javascript",
                program: "FILE_CONTENT",
            },
            ctx(home!),
        );

        expect(result.details.blockedReason).toContain("valid UTF-8");
        expect(result.details.archiveIds).toEqual([]);
        expect(analysis.run).not.toHaveBeenCalled();
        expect(store.archiveBytes()).toBe(0);
        expect(JSON.stringify(result)).not.toContain("\ufffd");
    });

    it("rejects binary NUL bytes even when the payload is valid UTF-8", async () => {
        const analysis = fakeAnalysis({ output: "must not run" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        await writeFile(
            join(home!, "binary-with-nul.dat"),
            Buffer.from([0x41, 0, 0x42]),
        );

        const result = await coordinator.executeFile(
            {
                id: "exec-file-binary-nul",
                path: "binary-with-nul.dat",
                language: "javascript",
                program: "FILE_CONTENT",
            },
            ctx(home!),
        );

        expect(result.details.blockedReason).toContain("appears binary");
        expect(result.details.archiveIds).toEqual([]);
        expect(analysis.run).not.toHaveBeenCalled();
        expect(store.archiveBytes()).toBe(0);
    });

    it("accepts exactly 64 MiB ASCII through normalizeAnalysisRequest with immutable file bindings", async () => {
        const normalizedRequests: unknown[] = [];
        const analysis: AnalysisSandboxService = {
            run: mock(async (request) => {
                const normalized = normalizeAnalysisRequest(request);
                normalizedRequests.push(normalized);
                const worker = await runQuickJsAnalysis({
                    ...normalized,
                    program: `export default (() => {
                        const before = FILE_PATH;
                        try { FILE_PATH = "mutated"; } catch {}
                        return FILE_PATH === before ? "immutable" : "mutable";
                    })()`,
                });
                return {
                    output: worker.output,
                    stderr: worker.stderr,
                    runtime: "quickjs" as const,
                    durationMs: 1,
                    truncated: false,
                };
            }),
            shutdown: async () => undefined,
        };
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        const exact = 64 * 1024 * 1024;
        await writeFile(join(home!, "exact.txt"), Buffer.alloc(exact, 0x41));

        const result = await coordinator.executeFile(
            {
                id: "exec-file-exact",
                path: "exact.txt",
                language: "javascript",
                program: "export default FILE_CONTENT.length",
                bindings: { FILE_CONTENT: "caller value", FILE_PATH: "/caller" },
            },
            ctx(home!),
        );

        expect(result.details.blockedReason).toBeUndefined();
        expect(result.details.archiveIds).toHaveLength(2);
        expect(result.content[0]?.text).toBe("immutable");
        expect(result.details.sourceBytes).toBe(exact);
        expect(store.archiveBytes()).toBeGreaterThanOrEqual(exact);
        expect(normalizedRequests).toHaveLength(1);
        const normalized = normalizedRequests[0] as {
            worker: string;
            bindings: Record<string, unknown>;
            mount?: unknown;
        };
        expect(normalized.worker).toBe("quickjs");
        expect(normalized.bindings.FILE_CONTENT).toBe("A".repeat(exact));
        expect(normalized.bindings.FILE_PATH).toBe(join(home!, "exact.txt"));
        expect(normalized.mount).toBeUndefined();
    });

    it("rejects 64 MiB plus one byte before archive or analysis", async () => {
        const analysis = fakeAnalysis({ output: "must not run" });
        const { coordinator, store } = await setup(
            fakeSafeExecution(() => "must not run"),
            analysis,
        );
        await writeFile(
            join(home!, "oversized.txt"),
            Buffer.alloc(64 * 1024 * 1024 + 1, 0x41),
        );

        const result = await coordinator.executeFile(
            {
                id: "exec-file-oversized",
                path: "oversized.txt",
                language: "javascript",
                program: "FILE_CONTENT",
            },
            ctx(home!),
        );

        expect(result.details.blockedReason).toContain("exceeds 64 MiB");
        expect(result.details.archiveIds).toEqual([]);
        expect(analysis.run).not.toHaveBeenCalled();
        expect(store.archiveBytes()).toBe(0);
    });

    it("bounds a file that grows after stat to the expected size plus one byte", async () => {
        const payload = Buffer.from("grow");
        let requestedBytes = 0;
        const file = {
            read: mock(
                async (
                    buffer: Buffer,
                    _offset: number,
                    length: number,
                    position: number,
                ) => {
                    requestedBytes += length;
                    const available = Math.min(
                        length,
                        payload.byteLength - position,
                    );
                    payload.copy(buffer, 0, position, position + available);
                    return { bytesRead: available };
                },
            ),
        };

        await expect(__test.readBoundedFile(file, 3)).rejects.toThrow(
            "File changed while reading",
        );
        expect(requestedBytes).toBe(4);
    });

    it("maps EACCES without exposing the host error path", () => {
        const hostPath = "/private/host/secret.txt";
        const error = Object.assign(new Error(`EACCES: ${hostPath}`), {
            code: "EACCES",
        });
        const reason = __test.fileFailureReason(error, "locked.txt");
        expect(reason).toBe("Unable to read file: locked.txt");
        expect(reason).not.toContain(hostPath);
    });

    it("keeps batch results and analyzer inputs in original item order", async () => {
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                if (request.command === "first") await Bun.sleep(25);
                return {
                    content: [{ type: "text" as const, text: `raw-${request.command}` }],
                    details: undefined,
                };
            }),
        };
        const analysis = fakeAnalysis({ output: "ordered" });
        const { coordinator } = await setup(safeExec, analysis);
        const result = await coordinator.batchExecute(
            {
                id: "batch-order",
                language: "javascript",
                program: "INPUTS",
                items: [
                    { id: "a", command: "first" },
                    { id: "b", command: "second" },
                ],
            },
            ctx("/workspace/proj"),
        );
        expect(result.details.items.map((item) => item.id)).toEqual(["a", "b"]);
        const request = (analysis.run as ReturnType<typeof mock>).mock.calls.at(-1)?.[0] as {
            bindings: { INPUTS: Array<{ id: string; output?: string }> };
        };
        expect(request.bindings.INPUTS).toEqual([
            expect.objectContaining({ id: "a", output: "raw-first" }),
            expect.objectContaining({ id: "b", output: "raw-second" }),
        ]);
    });

    it("forwards the real tool call identity and a sanitized progress callback", async () => {
        const safeExec = fakeSafeExecution(() => "ok");
        const { coordinator } = await setup(safeExec);
        const onUpdate = mock(() => undefined);
        await coordinator.execute(
            {
                id: "real-pi-call-id",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
            { onUpdate },
        );
        const recorded = (safeExec.execute as ReturnType<typeof mock>).mock
            .calls[0]?.[0] as {
            toolCallId: string;
            onUpdate?: (partial: unknown) => void;
        };
        expect(recorded.toolCallId).toBe("real-pi-call-id");
        // The forwarded callback must be the sanitizing wrapper, never the
        // parent's raw onUpdate. Identity and toolCallId are preserved by the
        // outer Pi tool wiring; the coordinator only owns the streaming
        // content that reaches partialResult.
        expect(typeof recorded.onUpdate).toBe("function");
        expect(recorded.onUpdate).not.toBe(onUpdate);
    });

    it("strips raw stdout/stderr content from streamed safe-execution updates", async () => {
        // Simulate the real bash partialResult shape: content with raw text
        // that must never reach the parent's onUpdate, plus details metadata
        // that the wrapper may forward.
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                const onUpdate = request.onUpdate as
                    | ((partial: unknown) => void)
                    | undefined;
                onUpdate?.({
                    content: [
                        {
                            type: "text",
                            text: "SECRET_TOKEN_RAW_OUTPUT_MUST_NOT_LEAK",
                        },
                    ],
                    details: {
                        truncation: { truncated: false },
                        fullOutputPath: null,
                    },
                });
                onUpdate?.({
                    content: [{ type: "text", text: "second-chunk" }],
                    details: undefined,
                });
                return {
                    content: [{ type: "text" as const, text: "ok" }],
                    details: undefined,
                };
            }),
        };
        const { coordinator } = await setup(
            safeExec,
            fakeAnalysis({ output: "derived" }),
        );
        const parentUpdates: unknown[] = [];
        await coordinator.execute(
            {
                id: "exec-stream-1",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
            { onUpdate: (partial) => parentUpdates.push(partial) },
        );
        // No raw bytes from safe execution may reach the parent callback.
        const serialized = JSON.stringify(parentUpdates);
        expect(serialized).not.toContain("SECRET_TOKEN_RAW_OUTPUT_MUST_NOT_LEAK");
        expect(serialized).not.toContain("second-chunk");
        // The final Think result must remain bounded and derived.
        // details metadata from safe execution is allowed to surface as it is
        // truncation/path information, not command bytes.
        for (const update of parentUpdates) {
            const content = (update as { content?: unknown[] }).content;
            expect(Array.isArray(content)).toBe(true);
            if (Array.isArray(content)) {
                for (const block of content) {
                    const text = (block as { text?: string }).text ?? "";
                    expect(text).not.toContain("SECRET_TOKEN_RAW_OUTPUT_MUST_NOT_LEAK");
                    expect(text).not.toContain("second-chunk");
                }
            }
        }
    });

    it("strips raw stdout/stderr content from batch execute streamed updates", async () => {
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                const onUpdate = request.onUpdate as
                    | ((partial: unknown) => void)
                    | undefined;
                onUpdate?.({
                    content: [
                        {
                            type: "text",
                            text: `RAW-${request.command}-STDOUT-DO-NOT-LEAK`,
                        },
                    ],
                    details: { truncation: { truncated: false } },
                });
                return {
                    content: [
                        { type: "text" as const, text: `out-${request.command}` },
                    ],
                    details: undefined,
                };
            }),
        };
        const { coordinator } = await setup(
            safeExec,
            fakeAnalysis({ output: "batch-derived" }),
        );
        const parentUpdates: unknown[] = [];
        await coordinator.batchExecute(
            {
                id: "batch-stream-1",
                language: "javascript",
                program: "INPUTS",
                items: [{ id: "a", command: "alpha" }],
            },
            ctx("/workspace/proj"),
            { onUpdate: (partial) => parentUpdates.push(partial) },
        );
        const serialized = JSON.stringify(parentUpdates);
        expect(serialized).not.toContain("RAW-alpha-STDOUT-DO-NOT-LEAK");
        for (const update of parentUpdates) {
            const content = (update as { content?: unknown[] }).content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
                const text = (block as { text?: string }).text ?? "";
                expect(text).not.toContain("RAW-alpha-STDOUT-DO-NOT-LEAK");
            }
        }
    });

    it("whitelists only safe TruncationResult fields and drops fullOutputPath from streamed updates", async () => {
        // Use the real TruncationResult shape verified against
        // @earendil-works/pi-coding-agent. The `content` field carries up
        // to ~50 KiB of raw stdout/stderr bytes and MUST NOT leak through
        // the sanitizer. The fake here is intentionally not content-free.
        const truncationWithContent: TruncationResult = {
            content: "RAW_TRUNCATED_BODY_DO_NOT_LEAK_TO_LLM",
            truncated: true,
            truncatedBy: "bytes",
            totalLines: 9999,
            totalBytes: 9999,
            outputLines: 100,
            outputBytes: 500,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines: 2000,
            maxBytes: 50_000,
        };
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                const onUpdate = request.onUpdate as
                    | ((partial: unknown) => void)
                    | undefined;
                onUpdate?.({
                    content: [
                        { type: "text", text: "RAW_BYTES_MUST_NOT_LEAK" },
                    ],
                    details: {
                        truncation: truncationWithContent,
                        fullOutputPath: "/tmp/raw-snapshot.txt",
                    },
                });
                return {
                    content: [{ type: "text" as const, text: "ok" }],
                    details: undefined,
                };
            }),
        };
        const { coordinator } = await setup(safeExec);
        const parentUpdates: unknown[] = [];
        await coordinator.execute(
            {
                id: "exec-meta",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
            { onUpdate: (partial) => parentUpdates.push(partial) },
        );
        expect(parentUpdates).toHaveLength(1);
        const update = parentUpdates[0] as {
            content: unknown[];
            details?: Record<string, unknown>;
        };
        // Raw bytes never reach the parent callback.
        expect(JSON.stringify(update)).not.toContain(
            "RAW_TRUNCATED_BODY_DO_NOT_LEAK_TO_LLM",
        );
        expect(JSON.stringify(update)).not.toContain(
            "RAW_BYTES_MUST_NOT_LEAK",
        );
        // content must be emptied; only the whitelisted truncation metadata
        // is forwarded so Pi TUI keeps its rendering signal. fullOutputPath
        // is dropped because it points to a temp file holding raw stdout.
        expect(update.content).toEqual([]);
        expect(update.details?.fullOutputPath).toBeUndefined();
        const sanitized = update.details?.truncation as TruncationResult;
        expect(sanitized).toBeDefined();
        expect((sanitized as { content?: unknown }).content).toBeUndefined();
        expect(sanitized.truncated).toBe(true);
        expect(sanitized.truncatedBy).toBe("bytes");
        expect(sanitized.totalLines).toBe(9999);
        expect(sanitized.totalBytes).toBe(9999);
        expect(sanitized.outputLines).toBe(100);
        expect(sanitized.outputBytes).toBe(500);
        expect(sanitized.lastLinePartial).toBe(false);
        expect(sanitized.firstLineExceedsLimit).toBe(false);
        expect(sanitized.maxLines).toBe(2000);
        expect(sanitized.maxBytes).toBe(50_000);
    });

    it("forwards a real bash-shaped truncation.content path through details.truncation without exposing raw bytes", async () => {
        // Mirror the real Bash partial-update path: text content + details
        // with the bash.js TruncationResult that carries raw content. The
        // sanitizer MUST strip the text block AND the truncation.content
        // string; both reach Pi through the partialResult envelope.
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                const onUpdate = request.onUpdate as
                    | ((partial: unknown) => void)
                    | undefined;
                onUpdate?.({
                    content: [
                        {
                            type: "text",
                            text: "STREAMING_RAW_FROM_BASH_DO_NOT_LEAK",
                        },
                    ],
                    details: {
                        truncation: {
                            content:
                                "PI_BASH_TAIL_DO_NOT_LEAK_TO_LLM",
                            truncated: true,
                            truncatedBy: "bytes",
                            totalLines: 12345,
                            totalBytes: 123456,
                            outputLines: 2000,
                            outputBytes: 50000,
                            lastLinePartial: false,
                            firstLineExceedsLimit: false,
                            maxLines: 2000,
                            maxBytes: 50000,
                        } satisfies TruncationResult,
                        fullOutputPath: "/tmp/raw-snapshot.txt",
                    },
                });
                return {
                    content: [{ type: "text" as const, text: "ok" }],
                    details: undefined,
                };
            }),
        };
        const { coordinator } = await setup(safeExec);
        const parentUpdates: unknown[] = [];
        await coordinator.execute(
            {
                id: "exec-stream-trunc",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "cat huge" },
            },
            ctx("/workspace/proj"),
            { onUpdate: (partial) => parentUpdates.push(partial) },
        );
        expect(parentUpdates).toHaveLength(1);
        const serialized = JSON.stringify(parentUpdates[0]);
        expect(serialized).not.toContain(
            "STREAMING_RAW_FROM_BASH_DO_NOT_LEAK",
        );
        expect(serialized).not.toContain("PI_BASH_TAIL_DO_NOT_LEAK_TO_LLM");
        const update = parentUpdates[0] as {
            details?: { truncation?: { content?: unknown } };
        };
        expect(update.details?.truncation?.content).toBeUndefined();
    });

    it("executeFile never returns analyzer error.message verbatim or unbounded when the program echoes FILE_CONTENT", async () => {
        // P1: a JavaScript analyzer program can `throw new Error(FILE_CONTENT)`.
        // quickjs-worker.ts:97-99 emits "<name>: <message>"; the coordinator
        // must never copy that raw text into content/details nor surface it
        // unbounded. The success path is bounded to maxResultBytes (64 KiB).
        const secret = "FILE_CONTENT_SECRET_DO_NOT_LEAK";
        const fileContent = secret.repeat(200); // ~12 KiB to also test bound
        const analysisFailure: AnalysisSandboxService = {
            run: mock(async () => {
                throw new Error(
                    `Error: ${secret}\n\n${fileContent.slice(0, 256)}`,
                );
            }),
            shutdown: async () => undefined,
        };
        const { coordinator } = await setup(
            fakeSafeExecution(() => "unused"),
            analysisFailure,
        );
        const homeDir = await mkdtemp(join(tmpdir(), "think-file-secret-"));
        try {
            const target = join(homeDir, "secrets.txt");
            await writeFile(target, fileContent, "utf8");
            const result = await coordinator.executeFile(
                {
                    id: "exec-file-secret",
                    path: "secrets.txt",
                    language: "javascript",
                    program: "throw new Error(FILE_CONTENT)",
                },
                ctx(homeDir),
            );
            // The full secret (or anything repeated from FILE_CONTENT) must
            // not appear in content[0].text or details.blockedReason, and
            // every surface (including JSON.stringify of the whole result)
            // must stay secret-free.
            expect(result.content[0]?.text ?? "").not.toContain(secret);
            expect(result.details.blockedReason ?? "").not.toContain(secret);
            // The bounded reason must never echo the analyzer stderr; it
            // should be a generic shape that does not start with "Error:"
            // or "Command".
            expect(result.content[0]?.text ?? "").not.toMatch(/^Error:/);
            expect(JSON.stringify(result)).not.toContain(secret);
            // Bound: even very large analyzer errors must not blow past
            // the documented 64 KiB cap; we allow a margin for the framing.
            const reasonBytes = Buffer.byteLength(
                result.content[0]?.text ?? "",
                "utf8",
            );
            const blockedBytes = Buffer.byteLength(
                result.details.blockedReason ?? "",
                "utf8",
            );
            expect(reasonBytes).toBeLessThanOrEqual(256);
            expect(blockedBytes).toBeLessThanOrEqual(256);
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it("execute analyzer error keeps INPUT secret out of content/details and stays generic", async () => {
        // P2: analyzer failure on command path must not echo the secret
        // INPUT from any bindings. The reason must not mention bash or
        // safe execution (those are unrelated to analyzer failures).
        const secret = "ANALYZER_INPUT_SECRET_DO_NOT_LEAK";
        const analysisFailure: AnalysisSandboxService = {
            run: mock(async () => {
                throw new Error(
                    `ReferenceError: ${secret} is not defined\n at line 5`,
                );
            }),
            shutdown: async () => undefined,
        };
        const { coordinator } = await setup(
            fakeSafeExecution(() => "SAFE_OUTPUT"),
            analysisFailure,
        );
        const result = await coordinator.execute(
            {
                id: "exec-analyzer-fail",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.content[0]?.text ?? "").not.toContain(secret);
        expect(result.details.blockedReason ?? "").not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
        // The reason must not mention safe-execution terminology because the
        // failure is an analyzer failure, not a safe-execution one.
        expect(
            (result.content[0]?.text ?? "").toLowerCase(),
        ).not.toContain("safe execution");
        expect(
            (result.details.blockedReason ?? "").toLowerCase(),
        ).not.toContain("safe execution");
    });

    it("batch analyzer error keeps INPUTS secret out of every public surface and stays generic", async () => {
        const secret = "ANALYZER_INPUTS_SECRET_DO_NOT_LEAK";
        const analysisFailure: AnalysisSandboxService = {
            run: mock(async () => {
                throw new Error(`SyntaxError: ${secret} unexpected token`);
            }),
            shutdown: async () => undefined,
        };
        const { coordinator } = await setup(
            fakeSafeExecution(() => "OK"),
            analysisFailure,
        );
        const result = await coordinator.batchExecute(
            {
                id: "batch-analyzer-fail",
                language: "python",
                program: "INPUTS",
                items: [{ id: "x", command: "echo" }],
            },
            ctx("/workspace/proj"),
        );
        expect(result.content[0]?.text ?? "").not.toContain(secret);
        expect(result.details.blockedReason ?? "").not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(
            (result.content[0]?.text ?? "").toLowerCase(),
        ).not.toContain("safe execution");
        expect(
            (result.details.blockedReason ?? "").toLowerCase(),
        ).not.toContain("safe execution");
    });

    it("surfaces a stale-missing archive as 'Archive not found' rather than a generic command failure", async () => {
        // P2 fix: source/store validation errors must reach the model
        // with their static actionable message so it can distinguish
        // "archive was archived but is gone" from a command failure.
        // safeFailureReason previously redacted both to the same opaque
        // "Command failed (raw output redacted)".
        const { coordinator } = await setup();
        const result = await coordinator.execute(
            {
                id: "exec-stale-archive",
                language: "javascript",
                program: "INPUT",
                source: {
                    kind: "archives",
                    // A well-formed archive id that does not exist in
                    // the store.
                    archiveIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
                },
            },
            ctx("/workspace/proj"),
        );
        expect(result.details.blockedReason).toBe(
            "Archive not found: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        expect(result.content[0]?.text).toBe(
            "Archive not found: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
    });

    it("surfaces a malformed archive id as 'Invalid archive id' rather than a generic command failure", async () => {
        const { coordinator } = await setup();
        const bad = "id with spaces";
        const result = await coordinator.execute(
            {
                id: "exec-bad-archive",
                language: "javascript",
                program: "INPUT",
                source: {
                    kind: "archives",
                    archiveIds: [bad],
                },
            },
            ctx("/workspace/proj"),
        );
        expect(result.details.blockedReason).toBe(
            `Invalid archive id: ${bad}`,
        );
    });

    it("does not honor the 'Safe execution unavailable' prefix when it originates from an analyzer error", async () => {
        // P2: a Python/QuickJS program can raise an exception whose message
        // begins with "Safe execution unavailable: " plus attacker-chosen
        // text. The coordinator must not classify that as an unavailable
        // safe-execution reason and must never surface the attacker tail.
        const tail = "ATTACKER_TAIL_DO_NOT_LEAK";
        const analysisFailure: AnalysisSandboxService = {
            run: mock(async () => {
                throw new Error(`Safe execution unavailable: ${tail}`);
            }),
            shutdown: async () => undefined,
        };
        const { coordinator } = await setup(
            fakeSafeExecution(() => ""),
            analysisFailure,
        );
        const result = await coordinator.execute(
            {
                id: "exec-spoof",
                language: "python",
                program: "raise Exception('Safe execution unavailable: ...')",
                source: { kind: "content", content: "harmless" },
            },
            ctx("/workspace/proj"),
        );
        expect(result.content[0]?.text ?? "").not.toContain(tail);
        expect(result.details.blockedReason ?? "").not.toContain(tail);
        expect(JSON.stringify(result)).not.toContain(tail);
        expect(
            (result.content[0]?.text ?? "").toLowerCase(),
        ).not.toContain("safe execution unavailable");
    });

    it("preserves the abort signal through the sanitizing wrapper", async () => {
        let forwardedSignal: AbortSignal | undefined;
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                forwardedSignal = request.signal;
                return {
                    content: [{ type: "text" as const, text: "ok" }],
                    details: undefined,
                };
            }),
        };
        const { coordinator } = await setup(safeExec);
        const controller = new AbortController();
        await coordinator.execute(
            {
                id: "abort-1",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
            { signal: controller.signal },
        );
        expect(forwardedSignal).toBe(controller.signal);
    });

    it("uses UTF-8 bytes for the 64 KiB-derived boundary and details", async () => {
        const output = "🙂".repeat(20_000);
        const { coordinator } = await setup(
            fakeSafeExecution(() => "source"),
            fakeAnalysis({ output }),
        );
        const result = await coordinator.execute(
            {
                id: "utf8-cap",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
        );
        const returned = result.content[0]!.text;
        expect(Buffer.byteLength(returned, "utf8")).toBeLessThanOrEqual(64 * 1024);
        expect(returned.endsWith("�")).toBe(false);
        expect(result.details.derivedBytes).toBe(Buffer.byteLength(output, "utf8"));
        expect(result.details.truncated).toBe(true);
    });

    it("prevents caller bindings from overriding trusted source bindings", async () => {
        const analysis = fakeAnalysis({ output: "ok" });
        const { coordinator } = await setup(fakeSafeExecution(() => "trusted"), analysis);
        await coordinator.execute(
            {
                id: "reserved-input",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
                bindings: { INPUT: "attacker" },
            },
            ctx("/workspace/proj"),
        );
        expect(analysis.run).toHaveBeenLastCalledWith(
            expect.objectContaining({ bindings: expect.objectContaining({ INPUT: "trusted" }) }),
            undefined,
        );

        await writeFile(join(home!, "trusted.txt"), "trusted-file");
        await coordinator.executeFile(
            {
                id: "reserved-file",
                language: "javascript",
                program: "FILE_CONTENT",
                path: "trusted.txt",
                bindings: { FILE_CONTENT: "attacker", FILE_PATH: "/attacker" },
            },
            ctx(home!),
        );
        expect(analysis.run).toHaveBeenLastCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({
                    FILE_CONTENT: "trusted-file",
                    FILE_PATH: join(home!, "trusted.txt"),
                }),
            }),
            undefined,
        );
    });

    it("runs retention after an archive write exceeds quota", async () => {
        home = await mkdtemp(join(tmpdir(), "think-in-code-quota-after-write-"));
        const config = { ...DEFAULT_THINK_IN_CODE_CONFIG, projectQuotaBytes: 5 };
        const storeRoot = join(home, "store");
        await mkdir(storeRoot, { recursive: true });
        publishSafeExecutionService(ownerSymbol, fakeSafeExecution(() => "123456789"));
        publishAnalysisSandboxService(ownerSymbol, fakeAnalysis({ output: "x" }));
        store = new ThinkStore({ config, storeRoot, canonicalPath: "/workspace/proj" });
        coordinator = new ThinkCoordinator({ store, config });
        await coordinator.execute(
            {
                id: "quota-write",
                language: "javascript",
                program: "INPUT",
                source: { kind: "command", command: "echo" },
            },
            ctx("/workspace/proj"),
        );
        expect(store.archiveBytes()).toBeLessThanOrEqual(5);
    });

    it("scrubs raw stdout from batch item errors in INPUTS, details.items, content, and streamed updates", async () => {
        const secret = "BATCH_ITEM_SECRET_DO_NOT_LEAK";
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                const cmd = (request as { command: string }).command;
                if (cmd === "fail") {
                    throw new Error(`${secret}\n\nCommand exited with code 7`);
                }
                return {
                    content: [
                        { type: "text" as const, text: `ok-${cmd}` },
                    ],
                    details: undefined,
                };
            }),
        };
        const analysis = mock(async () => ({
            output: "batch-derived",
            stderr: "",
            runtime: "quickjs" as const,
            durationMs: 1,
            truncated: false,
        }));
        const analysisService: AnalysisSandboxService = {
            run: analysis,
            shutdown: async () => undefined,
        };
        const { coordinator } = await setup(safeExec, analysisService);
        const parentUpdates: unknown[] = [];
        const result = await coordinator.batchExecute(
            {
                id: "batch-fail",
                language: "javascript",
                program: "INPUTS",
                items: [
                    { id: "good", command: "pass" },
                    { id: "bad", command: "fail" },
                ],
            },
            ctx("/workspace/proj"),
            { onUpdate: (partial) => parentUpdates.push(partial) },
        );
        // 1. Final content text must never contain the secret.
        expect(result.content[0]?.text ?? "").not.toContain(secret);
        // 2. The per-item error in details.items must be sanitized.
        const badItem = result.details.items.find((i) => i.id === "bad");
        expect(badItem).toBeDefined();
        expect(badItem?.error ?? "").not.toContain(secret);
        expect(badItem?.error).toBe("Command exited with code 7");
        expect(badItem?.status).toBe("failed");
        // 3. The analyzer INPUTS binding never carries the secret.
        expect(analysis).toHaveBeenCalled();
        const mockCallsArr = analysis.mock.calls as unknown as Array<
            [unknown]
        >;
        const lastCall = mockCallsArr.at(-1)?.[0] as unknown as
            | { bindings: Record<string, string> }
            | undefined;
        expect(lastCall?.bindings.INPUTS ?? "").not.toContain(secret);
        // 4. Streamed updates forwarded to Pi must never include the secret.
        for (const update of parentUpdates) {
            const text = JSON.stringify(update);
            expect(text).not.toContain(secret);
        }
        // 5. Top-level serialization must remain secret-free.
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("aborted batch items report blocked status and a sanitized reason", async () => {
        const secret = "ABORTED_BATCH_STDOUT_DO_NOT_LEAK";
        const controller = new AbortController();
        controller.abort();
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error(`${secret}\n\nCommand aborted`);
            }),
        };
        const { coordinator } = await setup(safeExec);
        const result = await coordinator.batchExecute(
            {
                id: "batch-aborted",
                language: "javascript",
                program: "INPUTS",
                items: [{ id: "aborted", command: "long" }],
            },
            ctx("/workspace/proj"),
            { signal: controller.signal },
        );
        const item = result.details.items.find((i) => i.id === "aborted");
        expect(item?.status).toBe("blocked");
        expect(item?.error).toBe("Command aborted");
        expect(result.content[0]?.text ?? "").not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("non-aborted failed batch items still report failed status with sanitized reason", async () => {
        const secret = "BATCH_FAILED_STDOUT_DO_NOT_LEAK";
        const safeExec: SafeExecutionService = {
            execute: mock(async () => {
                throw new Error(`${secret}\n\nCommand exited with code 9`);
            }),
        };
        const { coordinator } = await setup(safeExec);
        const result = await coordinator.batchExecute(
            {
                id: "batch-failed",
                language: "javascript",
                program: "INPUTS",
                items: [{ id: "fail", command: "failing" }],
            },
            ctx("/workspace/proj"),
        );
        const item = result.details.items.find((i) => i.id === "fail");
        expect(item?.status).toBe("failed");
        expect(item?.error).toBe("Command exited with code 9");
        expect(result.content[0]?.text ?? "").not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it("runs batch execute with bounded concurrency and reports per-item status", async () => {
        const safeExec: SafeExecutionService = {
            execute: mock(async (request) => {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `output-${(request as { command: string }).command}`,
                        },
                    ],
                    details: undefined,
                };
            }),
        };
        const { coordinator } = await setup(
            safeExec,
            fakeAnalysis({ output: "batch-derived" }),
        );
        const result = await coordinator.batchExecute(
            {
                id: "batch-1",
                language: "javascript",
                program: "INPUTS",
                items: [
                    { id: "a", command: "a" },
                    { id: "b", command: "b" },
                    { id: "c", command: "c" },
                    { id: "d", command: "d" },
                ],
            },
            ctx("/workspace/proj"),
        );
        expect(result.details.items.length).toBe(4);
        expect(result.details.items.every((i) => i.status === "succeeded")).toBe(
            true,
        );
        expect(safeExec.execute).toHaveBeenCalledTimes(4);
        expect(result.content[0]?.text).toBe("batch-derived");
    });

    it("rejects batches above the configured ceiling", async () => {
        const { coordinator } = await setup();
        const items = Array.from({ length: 17 }, (_, i) => ({
            id: `i${i}`,
            command: `cmd${i}`,
        }));
        await expect(
            coordinator.batchExecute(
                {
                    id: "batch-2",
                    language: "javascript",
                    program: "INPUTS",
                    items,
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/Batch execute exceeds/);
    });

    it("limits search results to 20 hits and bounds snippets", async () => {
        const { coordinator, store } = await setup();
        for (let i = 0; i < 30; i += 1) {
            store.index({
                kind: "document-summary",
                source: `src-${i}`,
                text: `unique_alpha_beta_marker_${i}`,
            });
        }
        const result = coordinator.search({ id: "search-1", query: "alpha_beta_marker", limit: 100 });
        const archiveIds = result.details.archiveIds;
        expect(archiveIds.length).toBeLessThanOrEqual(20);
        expect(result.content[0]?.text.length ?? 0).toBeGreaterThan(0);
    });

    it("protects INPUTS from caller overrides in batch execute", async () => {
        // The batch coordinator only sets INPUTS — callers cannot inject
        // their own bindings alongside it (the schema forbids them). Even if
        // someone bypassed the schema and passed bindings, the coordinator
        // would not honor them.
        const analysis = fakeAnalysis({ output: "batch-derived" });
        const safeExec = fakeSafeExecution(() => "safe");
        const { coordinator } = await setup(safeExec, analysis);
        await coordinator.batchExecute(
            {
                id: "batch-inputs-isolation",
                language: "javascript",
                program: "INPUTS",
                items: [{ id: "a", command: "echo" }],
            },
            ctx("/workspace/proj"),
        );
        const lastCall = (analysis.run as ReturnType<typeof mock>).mock.calls.at(-1);
        const request = lastCall?.[0] as {
            bindings: { INPUTS: Array<{ id: string; output?: string }> };
        };
        expect(request.bindings).toHaveProperty("INPUTS");
        expect(request.bindings).not.toHaveProperty("INPUT");
        expect(request.bindings).not.toHaveProperty("FILE_CONTENT");
        expect(request.bindings).not.toHaveProperty("FILE_PATH");
        // Structured INPUTS must include per-item output, not caller input.
        expect(request.bindings.INPUTS).toHaveLength(1);
        expect(request.bindings.INPUTS[0]?.output).toBe("safe");
    });

    it("drives the analyzer result from real command output and re-analyzes without leaking raw bytes", async () => {
        // Stage 1: run a command and capture its output as the analyzer input.
        const safeExec = fakeSafeExecution(() => "alpha-42");
        const analysis = fakeAnalysis({
            output: "42",
        });
        const { coordinator, store } = await setup(safeExec, analysis);
        const first = await coordinator.execute(
            {
                id: "pipeline-stage-1",
                language: "javascript",
                program: "Number(INPUT.split('-')[1])",
                source: { kind: "command", command: "echo alpha-42" },
            },
            ctx("/workspace/proj"),
        );
        expect(analysis.run).toHaveBeenLastCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({ INPUT: "alpha-42" }),
            }),
            undefined,
        );
        const sourceArchiveId = first.details.archiveIds[0]!;
        expect(first.details.archiveIds).toHaveLength(2);
        expect(store.archiveBytes()).toBeGreaterThan(0);

        // Stage 2: re-analyze the same archive with a different program. The
        // analyzer must receive the bounded archive bytes via INPUT, and the
        // LLM-facing text must remain bounded.
        const reanalysis = fakeAnalysis({
            output: "REPLAY",
        });
        publishAnalysisSandboxService(ownerSymbol, reanalysis);
        const second = await coordinator.execute(
            {
                id: "pipeline-stage-2",
                language: "javascript",
                program: "INPUT.toUpperCase()",
                source: { kind: "archives", archiveIds: [sourceArchiveId] },
            },
            ctx("/workspace/proj"),
        );
        expect(reanalysis.run).toHaveBeenLastCalledWith(
            expect.objectContaining({
                bindings: expect.objectContaining({ INPUT: "alpha-42" }),
            }),
            undefined,
        );
        // LLM must only see the bounded analyzer view; raw archive bytes
        // never appear in the tool result text or details.
        expect(second.content[0]?.text).toBe("REPLAY");
        const serialized = JSON.stringify(second);
        expect(serialized).not.toContain("alpha-42");
    });

    it("redacts every secret in the indexed command-source field across distinct pattern kinds", async () => {
        // End-to-end: command with two distinct secret kinds is indexed as
        // command-summary. The store redaction must mask every secret while
        // preserving the assignment keys.
        const safeExec = fakeSafeExecution(() => "ALPHA_BETA_MARKER");
        const analysis = fakeAnalysis({ output: "ALPHA_BETA_MARKER response" });
        const { coordinator, store } = await setup(safeExec, analysis);
        await coordinator.execute(
            {
                id: "multi-secret-cmd",
                language: "javascript",
                program: "INPUT",
                source: {
                    kind: "command",
                    command:
                        "curl -H 'Authorization: Bearer zzzzzzzzzzzzzzzzzzzzzz' "
                        + "https://example.test/api && export API_KEY=top-secret-value",
                },
            },
            ctx("/workspace/proj"),
        );
        const hits = store.search("ALPHA_BETA_MARKER", 5);
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) {
            expect(hit.source).not.toContain("zzzzzzzzzzzzzzzzzzzzzz");
            expect(hit.source).not.toContain("top-secret-value");
            expect(hit.source).toContain("[REDACTED]");
            expect(hit.source).toContain("export API_KEY=");
            expect(hit.source).toContain("Authorization:");
        }
    });
});
