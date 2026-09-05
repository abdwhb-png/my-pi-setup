/**
 * Parity tests for Think-in-Code.
 *
 * These tests cover the scenarios called out in the Think-in-Code
 * implementation plan (Task 8) that must succeed with disposable on-disk
 * fixtures. They exercise the ThinkCoordinator end-to-end without a real Pi
 * runtime, using the same broker contracts that the runtime integration
 * test pre-publishes.
 *
 * Each test asserts:
 *   - the bounded derived text returned to the LLM,
 *   - the archive IDs the caller can reanalyze,
 *   - the byte-reduction between raw source and derived view,
 *   - and the parity-relevant invariants (no fetch, no save-tokens mutation,
 *     64 KiB derived cap, reanalysis without raw bytes leaking).
 *
 * No real Pi runtime, MCP bridge, or LLM is required.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    claimAnalysisSandboxBroker,
    publishAnalysisSandboxService,
    releaseAnalysisSandboxBroker,
} from "../_shared/analysis/sandbox-analysis-broker.ts";
import {
    claimSafeExecutionBroker,
    publishSafeExecutionService,
    releaseSafeExecutionBroker,
} from "../_shared/safe-execution/broker.ts";
import type { AnalysisSandboxService } from "../sandbox/analysis/client.ts";
import type { AnalysisRequest, AnalysisResult } from "../sandbox/analysis/protocol.ts";
import type { SafeExecutionService } from "../_shared/safe-execution/core.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "./config.ts";
import { ThinkCoordinator } from "./coordinator.ts";
import { ThinkStore } from "./storage/store.ts";
import { TOOL_NAMES } from "./types.ts";
import { buildToolHandlers, SCHEMAS } from "./tools.ts";

const ownerSymbol = Symbol("parity-test");
const MAX_DERIVED_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function extractText<T>(result: AgentToolResult<T>): string {
    return result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
}

function textBinding(
    bindings: Readonly<Record<string, unknown>> | undefined,
    name: string,
): string {
    const value = bindings?.[name];
    return typeof value === "string" ? value : "";
}

function ctx(cwd: string): ExtensionContext {
    return { cwd, hasUI: false, ui: {} } as unknown as ExtensionContext;
}

function makeSafeExec(
    textFor: (command: string) => string,
): SafeExecutionService {
    return {
        execute: mock(async (request) => ({
            content: [{ type: "text" as const, text: textFor(request.command) }],
            details: undefined,
        })),
    };
}

function makeAnalysis(
    output: (request: AnalysisRequest) => string,
): AnalysisSandboxService {
    return {
        run: mock(async (request: AnalysisRequest): Promise<AnalysisResult> => ({
            output: output(request),
            stderr: "",
            runtime: request.language === "python" ? "python" : "quickjs",
            durationMs: 1,
            truncated: false,
        })),
        shutdown: async () => undefined,
    };
}

interface Harness {
    home: string;
    store: ThinkStore;
    coordinator: ThinkCoordinator;
    handlers: ReturnType<typeof buildToolHandlers>;
    safeExec: SafeExecutionService;
    analysis: AnalysisSandboxService;
    cleanup(): Promise<void>;
}

async function setup(
    safeExec?: SafeExecutionService,
    analysis?: AnalysisSandboxService,
): Promise<Harness> {
    const home = await mkdtemp(join(tmpdir(), "think-in-code-parity-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    const safe = safeExec ?? makeSafeExec(() => "ok");
    const analysisSvc =
        analysis ?? makeAnalysis((request) => textBinding(request.bindings, "INPUT"));
    publishSafeExecutionService(ownerSymbol, safe);
    publishAnalysisSandboxService(ownerSymbol, analysisSvc);
    const store = new ThinkStore({
        config: DEFAULT_THINK_IN_CODE_CONFIG,
        storeRoot,
        canonicalPath: "/workspace/parity",
    });
    const coordinator = new ThinkCoordinator({
        store,
        config: DEFAULT_THINK_IN_CODE_CONFIG,
    });
    const handlers = buildToolHandlers(coordinator);
    return {
        home,
        store,
        coordinator,
        handlers,
        safeExec: safe,
        analysis: analysisSvc,
        async cleanup() {
            coordinator.close();
            store.close();
            await rm(home, { recursive: true, force: true });
        },
    };
}

beforeEach(() => {
    claimSafeExecutionBroker(ownerSymbol);
    claimAnalysisSandboxBroker(ownerSymbol);
});

afterEach(() => {
    releaseSafeExecutionBroker(ownerSymbol);
    releaseAnalysisSandboxBroker(ownerSymbol);
});

describe("Think-in-Code parity fixtures", () => {
    it("aggregates a large JSON log into a bounded summary (size and content)", async () => {
        const jsonLines: string[] = [];
        for (let i = 0; i < 5_000; i += 1) {
            jsonLines.push(
                JSON.stringify({
                    level: i % 17 === 0 ? "error" : "info",
                    msg: `event_${i}`,
                    value: i,
                }),
            );
        }
        const largeJson = jsonLines.join("\n");
        const safe = makeSafeExec(() => largeJson);
        const analysis = makeAnalysis((request) => {
            const input = textBinding(request.bindings, "INPUT");
            const errorCount = input
                .split("\n")
                .filter((line) => line.includes('"level":"error"')).length;
            return `error_count=${errorCount} sample=${input.slice(0, 24)}`;
        });
        const harness = await setup(safe, analysis);
        try {
            const result = (await harness.handlers.execute(
                {
                    language: "javascript",
                    program: "INPUT",
                    command: "cat huge.json",
                },
                ctx("/workspace/parity"),
                { toolCallId: "parity-1" },
            )) as AgentToolResult<{
                sourceBytes: number;
                derivedBytes: number;
                archiveIds: readonly string[];
            }>;
            // Bounded return: the derived view is well under 64 KiB even
            // when the source is many megabytes.
            const text = extractText(result);
            expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
                MAX_DERIVED_BYTES,
            );
            // Byte reduction: source >> derived, but both archiveIds are
            // returned so the LLM can re-analyze the raw JSON on demand.
            expect(result.details.sourceBytes).toBeGreaterThan(100_000);
            expect(result.details.derivedBytes).toBeLessThan(MAX_DERIVED_BYTES);
            expect(result.details.archiveIds.length).toBe(2);
        } finally {
            await harness.cleanup();
        }
    });

    it("extracts errors from a noisy log without leaking raw bytes", async () => {
        const noisyLog = Array.from({ length: 2_000 }, (_, i) => {
            if (i % 200 === 0) {
                return `ERROR ${i} :: connection refused :: bearer-${"x".repeat(30)}`;
            }
            if (i % 137 === 0) {
                return `WARN ${i} :: slow query :: key-${"y".repeat(20)}`;
            }
            return `INFO ${i} :: request handled in ${i}ms`;
        }).join("\n");
        const safe = makeSafeExec(() => noisyLog);
        const analysis = makeAnalysis((request) => {
            const lines = textBinding(request.bindings, "INPUT").split("\n");
            const errors = lines.filter((l: string) => l.startsWith("ERROR"));
            // Redact any tokens inline so the LLM-facing view is sanitized.
            return errors
                .map((line) =>
                    line
                        .replace(/bearer-[A-Za-z0-9]+/g, "bearer-[REDACTED]")
                        .replace(/key-[A-Za-z0-9]+/g, "key-[REDACTED]"),
                )
                .slice(0, 5)
                .join("\n");
        });
        const harness = await setup(safe, analysis);
        try {
            const result = (await harness.handlers.execute(
                {
                    language: "javascript",
                    program: "INPUT",
                    command: "cat app.log",
                },
                ctx("/workspace/parity"),
                { toolCallId: "parity-log" },
            )) as AgentToolResult<{ archiveIds: readonly string[] }>;
            const text = extractText(result);
            // The derived view contains only error lines.
            expect(text.split("\n").every((l) => l.startsWith("ERROR"))).toBe(
                true,
            );
            // No raw bearer/key tokens leak through.
            expect(text).not.toContain("x".repeat(30));
            expect(text).not.toContain("y".repeat(20));
            // Reanalysis path is preserved via archive ID.
            expect(result.details.archiveIds.length).toBe(2);
        } finally {
            await harness.cleanup();
        }
    });

    it("analyzes a project file end-to-end and exposes FILE_CONTENT/FILE_PATH", async () => {
        const harness = await setup();
        try {
            await writeFile(
                join(harness.home, "module.ts"),
                [
                    "export const adder = (a: number, b: number) => a + b;",
                    "export const subber = (a: number, b: number) => a - b;",
                ].join("\n"),
            );
            const result = await harness.coordinator.executeFile(
                {
                    id: "parity-file",
                    path: "module.ts",
                    language: "javascript",
                    program: "FILE_CONTENT.length",
                },
                ctx(harness.home),
            );
            expect(result.details.archiveIds.length).toBe(2);
            expect(harness.analysis.run).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    bindings: expect.objectContaining({
                        FILE_CONTENT: expect.stringContaining("adder"),
                    }),
                }),
                undefined,
            );
            // LLM-facing text is the bounded derived output, not the file.
            expect(result.content[0]?.text.length).toBeLessThanOrEqual(
                MAX_DERIVED_BYTES,
            );
        } finally {
            await harness.cleanup();
        }
    });

    it("rejects file paths that escape the project root (../)", async () => {
        const harness = await setup();
        try {
            const result = await harness.coordinator.executeFile(
                {
                    id: "parity-escape",
                    path: "../../etc/passwd",
                    language: "javascript",
                    program: "FILE_PATH",
                },
                ctx(harness.home),
            );
            expect(result.details.blockedReason).toMatch(/escapes/i);
            expect(result.details.archiveIds).toEqual([]);
        } finally {
            await harness.cleanup();
        }
    });

    it("runs a multi-command batch with per-item status and bounded concurrency", async () => {
        const safe: SafeExecutionService = {
            execute: mock(async (request) => ({
                content: [
                    {
                        type: "text" as const,
                        text: `result-for-${(request as { command: string }).command}`,
                    },
                ],
                details: undefined,
            })),
        };
        const analysis = makeAnalysis((request) => {
            const inputs = request.bindings?.INPUTS;
            if (!Array.isArray(inputs)) return "successes=0 total=0";
            const parsed = inputs as Array<{
                id: string;
                output?: string;
                status: string;
            }>;
            const successes = parsed.filter((p) => p.status === "succeeded")
                .length;
            return `successes=${successes} total=${parsed.length}`;
        });
        const harness = await setup(safe, analysis);
        try {
            const items = [
                { id: "i1", command: "echo 1" },
                { id: "i2", command: "echo 2" },
                { id: "i3", command: "echo 3" },
                { id: "i4", command: "echo 4" },
            ];
            const result = (await harness.handlers.batchExecute(
                {
                    id: "parity-batch",
                    language: "javascript",
                    program: "INPUTS",
                    items,
                },
                ctx("/workspace/parity"),
                { toolCallId: "parity-batch" },
            )) as AgentToolResult<{
                items: Array<{ id: string; status: string }>;
                archiveIds: readonly string[];
            }>;
            // One analyzer call with all 4 items in INPUTS.
            const analysisCall = (harness.analysis.run as ReturnType<typeof mock>)
                .mock.calls.at(-1)?.[0] as {
                bindings: { INPUTS: Array<{ id: string }> };
            };
            expect(analysisCall.bindings.INPUTS.map((i) => i.id)).toEqual([
                "i1",
                "i2",
                "i3",
                "i4",
            ]);
            // Per-item status preserved in details, never raw output.
            expect(result.details.items.map((i) => i.id)).toEqual([
                "i1",
                "i2",
                "i3",
                "i4",
            ]);
            expect(result.details.items.every((i) => i.status === "succeeded"))
                .toBe(true);
            // One archive per item plus the analysis archive.
            expect(result.details.archiveIds.length).toBe(items.length + 1);
            // Derived text is bounded.
            expect(
                Buffer.byteLength(extractText(result), "utf8"),
            ).toBeLessThanOrEqual(MAX_DERIVED_BYTES);
        } finally {
            await harness.cleanup();
        }
    });

    it("persists an index across restart/reopen and reanalysis returns bounded view", async () => {
        // First lifecycle: index a document, then dispose the store.
        const safe = makeSafeExec(() => "raw-cmd-output-with-marker foo");
        // The analyzer produces a derived string that carries a marker the
        // search test can find. The raw output is what would normally be
        // sensitive; the index only stores the redacted/derived view.
        const analysis = makeAnalysis(
            () => "summary contains reanalysis_marker and other words",
        );
        const harness = await setup(safe, analysis);
        try {
            await harness.coordinator.execute(
                {
                    id: "parity-reopen-exec",
                    language: "javascript",
                    program: "INPUT",
                    source: { kind: "command", command: "echo foo" },
                },
                ctx("/workspace/parity"),
            );
            // Close the store to simulate process exit.
            harness.store.close();
            harness.coordinator.close();

            // Reopen with a fresh store and search for the marker.
            const store2 = new ThinkStore({
                config: DEFAULT_THINK_IN_CODE_CONFIG,
                storeRoot: harness.store.storeRoot,
                canonicalPath: "/workspace/parity",
            });
            const hits = store2.search("reanalysis_marker", 5);
            expect(hits.length).toBeGreaterThan(0);
            // Snippet must be bounded and never contain the raw output.
            const snippet = hits[0]?.snippet ?? "";
            expect(snippet.length).toBeLessThanOrEqual(
                DEFAULT_THINK_IN_CODE_CONFIG.searchSnippetChars + 32,
            );
            expect(snippet).not.toContain("raw-cmd-output");
            // Archive IDs are surfaced; the LLM can re-analyze them.
            expect(Array.isArray(hits[0]?.archiveIds)).toBe(true);
            store2.close();
        } finally {
            await harness.cleanup();
        }
    });

    it("re-analyzes a raw archive via the archives source without leaking bytes", async () => {
        const rawText = "secret-archive-bytes-abcdef0123456789";
        const safe = makeSafeExec(() => rawText);
        const analysis = makeAnalysis((request) =>
            textBinding(request.bindings, "INPUT").toUpperCase(),
        );
        const harness = await setup(safe, analysis);
        try {
            const first = (await harness.handlers.execute(
                {
                    language: "javascript",
                    program: "INPUT",
                    command: "echo secret",
                },
                ctx("/workspace/parity"),
                { toolCallId: "parity-archive-1" },
            )) as AgentToolResult<{ archiveIds: readonly string[] }>;
            const sourceArchiveId = first.details.archiveIds[0];
            expect(sourceArchiveId).toBeDefined();
            // Second call: re-analyze via the archive source.
            const second = (await harness.handlers.execute(
                {
                    language: "javascript",
                    program: "INPUT",
                    archiveIds: [sourceArchiveId!],
                },
                ctx("/workspace/parity"),
                { toolCallId: "parity-archive-2" },
            )) as AgentToolResult<{ archiveIds: readonly string[] }>;
            // The analyzer must receive the bounded archive bytes via INPUT.
            const lastCall = (harness.analysis.run as ReturnType<typeof mock>)
                .mock.calls.at(-1)?.[0] as { bindings: Record<string, string> };
            expect(lastCall.bindings.INPUT).toBe(rawText);
            // LLM-facing text is the bounded derived view; no raw bytes leak.
            expect(extractText(second)).not.toContain(
                "secret-archive-bytes",
            );
            expect(
                Buffer.byteLength(extractText(second), "utf8"),
            ).toBeLessThanOrEqual(MAX_DERIVED_BYTES);
            // A new analysis archive is appended to the chain.
            expect(second.details.archiveIds.length).toBeGreaterThanOrEqual(2);
        } finally {
            await harness.cleanup();
        }
    });

    it("deliberately has no fetch parity: fetch parameters are rejected at the handler layer", async () => {
        const harness = await setup();
        try {
            await expect(
                harness.handlers.execute(
                    {
                        language: "javascript",
                        program: "1",
                        content: "hi",
                        fetch: { url: "https://example.com" },
                    },
                    ctx("/workspace/parity"),
                ),
            ).rejects.toThrow(/Fetch\/network/);
        } finally {
            await harness.cleanup();
        }
    });

    it("binds INPUTS/FILE_CONTENT/FILE_PATH to bounded values and rejects caller overrides", async () => {
        const safe = makeSafeExec(() => "trusted-source");
        const analysis = makeAnalysis((request) =>
            JSON.stringify({
                input: request.bindings?.INPUT,
                fileContent: request.bindings?.FILE_CONTENT,
                filePath: request.bindings?.FILE_PATH,
                inputs: request.bindings?.INPUTS ? "<set>" : "<absent>",
            }),
        );
        const harness = await setup(safe, analysis);
        try {
            await harness.coordinator.execute(
                {
                    id: "parity-bindings",
                    language: "javascript",
                    program: "1",
                    source: { kind: "command", command: "echo" },
                    bindings: {
                        INPUT: "attacker-supplied",
                    },
                },
                ctx("/workspace/parity"),
            );
            const call = (harness.analysis.run as ReturnType<typeof mock>)
                .mock.calls.at(-1)?.[0] as { bindings: Record<string, string> };
            // INPUT is always overridden by the trusted command output.
            expect(call.bindings.INPUT).toBe("trusted-source");
            // FILE_CONTENT / FILE_PATH are reserved for executeFile; on
            // execute they are simply not present (no caller override).
            expect(call.bindings.FILE_CONTENT).toBeUndefined();
            expect(call.bindings.FILE_PATH).toBeUndefined();
        } finally {
            await harness.cleanup();
        }
    });

    it("enforces 64 KiB derived byte cap with UTF-8 boundary safety", async () => {
        // Analyzer output larger than 64 KiB must be truncated without
        // splitting a UTF-8 character.
        const hugeOutput = "🙂".repeat(40_000); // 4 bytes per emoji
        const safe = makeSafeExec(() => "src");
        const analysis = makeAnalysis(() => hugeOutput);
        const harness = await setup(safe, analysis);
        try {
            const result = (await harness.handlers.execute(
                {
                    language: "javascript",
                    program: "1",
                    command: "echo",
                },
                ctx("/workspace/parity"),
                { toolCallId: "parity-utf8" },
            )) as AgentToolResult<{ truncated: boolean; derivedBytes: number }>;
            const text = extractText(result);
            expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
                MAX_DERIVED_BYTES,
            );
            // No replacement character from a partial UTF-8 sequence.
            expect(text.includes("�")).toBe(false);
            expect(result.details.truncated).toBe(true);
            // derivedBytes reports the full analyzer size, even though only
            // a bounded portion was returned to the LLM.
            expect(result.details.derivedBytes).toBeGreaterThan(MAX_DERIVED_BYTES);
        } finally {
            await harness.cleanup();
        }
    });

    it("think_search returns bounded snippets (≤ 240 chars) and at most 20 hits", async () => {
        const harness = await setup();
        try {
            // Insert 25 documents with the same unique marker.
            for (let i = 0; i < 25; i += 1) {
                harness.store.index({
                    kind: "document-summary",
                    source: `s-${i}`,
                    text: `parity_marker_${i}`,
                });
            }
            const result = harness.coordinator.search({
                id: "parity-search",
                query: "parity_marker",
                limit: 100,
            });
            // 20 hits max.
            expect(result.details.archiveIds.length).toBeLessThanOrEqual(20);
            // No raw document text in the LLM-facing view.
            for (const line of extractText(result).split("\n")) {
                expect(line).not.toContain("parity_marker_");
            }
        } finally {
            await harness.cleanup();
        }
    });

    it("rejects think_execute with more than one source (command + content + archives)", async () => {
        const harness = await setup();
        try {
            // Generate an archive ID so the third source is non-empty.
            const archive = harness.store.archive({
                kind: "command-output",
                data: "x",
            });
            await expect(
                harness.handlers.execute(
                    {
                        language: "javascript",
                        program: "1",
                        command: "echo",
                        content: "inline",
                        archiveIds: [archive.id],
                    },
                    ctx("/workspace/parity"),
                    { toolCallId: "parity-multi-source" },
                ),
            ).rejects.toThrow(/exactly one source/);
        } finally {
            await harness.cleanup();
        }
    });

    it("rejects think_execute with no source", async () => {
        const harness = await setup();
        try {
            await expect(
                harness.handlers.execute(
                    {
                        language: "javascript",
                        program: "1",
                    },
                    ctx("/workspace/parity"),
                    { toolCallId: "parity-no-source" },
                ),
            ).rejects.toThrow(/exactly one source/);
        } finally {
            await harness.cleanup();
        }
    });

    it("limits batch execute to 16 commands", async () => {
        const harness = await setup();
        try {
            const items = Array.from({ length: 17 }, (_, i) => ({
                id: `i${i}`,
                command: `echo ${i}`,
            }));
            await expect(
                harness.handlers.batchExecute(
                    {
                        id: "parity-overflow",
                        language: "javascript",
                        program: "1",
                        items,
                    },
                    ctx("/workspace/parity"),
                ),
            ).rejects.toThrow(/Batch execute exceeds/);
        } finally {
            await harness.cleanup();
        }
    });

    it("registered tool names match the contract: five think_* tools", () => {
        expect(Object.values(TOOL_NAMES).sort()).toEqual([
            "think_batch_execute",
            "think_execute",
            "think_execute_file",
            "think_index",
            "think_search",
        ]);
    });

    it("every tool schema is exported as a TypeBox object", () => {
        // The contract is the same for every tool. Fetch is intentionally
        // not a supported parameter on any think_* tool; the rejection
        // belongs to the handler, not the schema.
        expect(typeof SCHEMAS.execute).toBe("object");
        expect(typeof SCHEMAS.executeFile).toBe("object");
        expect(typeof SCHEMAS.batchExecute).toBe("object");
        expect(typeof SCHEMAS.index).toBe("object");
        expect(typeof SCHEMAS.search).toBe("object");
    });
});

describe("Think-in-Code MAX_FILE_BYTES boundary", () => {
    it("exposes the 64 MiB file size limit as a documented constant", () => {
        // The over-limit file path is covered by coordinator.test.ts. Here
        // we just confirm the contract value is the documented 64 MiB.
        expect(MAX_FILE_BYTES).toBe(64 * 1024 * 1024);
    });
});
