import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

import { DEFAULT_THINK_IN_CODE_CONFIG } from "./config.ts";
import { ThinkStore } from "./storage/store.ts";
import { ThinkCoordinator } from "./coordinator.ts";
import { buildToolHandlers, SCHEMAS } from "./tools.ts";

const ownerSymbol = Symbol("tools-test");

function ctx(cwd: string): ExtensionContext {
    return { cwd, hasUI: false, ui: {} } as unknown as ExtensionContext;
}

function fakeSafeExecution(text: string): SafeExecutionService {
    return {
        execute: mock(async () => ({
            content: [{ type: "text" as const, text }],
            details: undefined,
        })),
    };
}

function fakeAnalysis(output: string): AnalysisSandboxService {
    return {
        run: mock(async () => ({
            output,
            stderr: "",
            runtime: "quickjs" as const,
            durationMs: 1,
            truncated: false,
        })),
        shutdown: async () => undefined,
    };
}

describe("think_* tool handlers", () => {
    let home: string | undefined;
    let coordinator: ThinkCoordinator | undefined;

    beforeEach(() => {
        claimSafeExecutionBroker(ownerSymbol);
        claimAnalysisSandboxBroker(ownerSymbol);
    });

    afterEach(async () => {
        coordinator?.close();
        releaseSafeExecutionBroker(ownerSymbol);
        releaseAnalysisSandboxBroker(ownerSymbol);
        if (home) await rm(home, { recursive: true, force: true });
        home = undefined;
        coordinator = undefined;
    });

    async function setup(
        safeExec: SafeExecutionService = fakeSafeExecution("ok"),
        analysis: AnalysisSandboxService = fakeAnalysis("DERIVED"),
    ): Promise<{ coordinator: ThinkCoordinator; handlers: ReturnType<typeof buildToolHandlers> }> {
        home = await mkdtemp(join(tmpdir(), "think-in-code-tools-"));
        const storeRoot = join(home, "store");
        await mkdir(storeRoot, { recursive: true });
        publishSafeExecutionService(ownerSymbol, safeExec);
        publishAnalysisSandboxService(ownerSymbol, analysis);
        const store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot,
            canonicalPath: "/workspace/proj",
        });
        coordinator = new ThinkCoordinator({ store, config: DEFAULT_THINK_IN_CODE_CONFIG });
        const handlers = buildToolHandlers(coordinator);
        return { coordinator, handlers };
    }

    it("publishes provider-portable string enums in all public schemas", () => {
        expect(Object.keys(SCHEMAS)).toEqual([
            "execute",
            "executeFile",
            "batchExecute",
            "index",
            "search",
        ]);

        const expectedLanguageSchema = {
            type: "string",
            enum: ["javascript", "typescript", "python"],
        };
        for (const schemaKey of [
            "execute",
            "executeFile",
            "batchExecute",
        ] as const) {
            const schema = SCHEMAS[schemaKey] as {
                properties?: Record<string, unknown>;
            };
            expect(schema.properties?.language).toMatchObject(
                expectedLanguageSchema,
            );
            expect(schema.properties?.language).not.toHaveProperty("anyOf");
        }

        const indexSchema = SCHEMAS.index as {
            properties?: Record<string, unknown>;
        };
        expect(indexSchema.properties?.kind).toMatchObject({
            type: "string",
            enum: [
                "command-summary",
                "analysis-summary",
                "document-summary",
            ],
        });
        expect(indexSchema.properties?.kind).not.toHaveProperty("anyOf");
    });

    it("does not expose a model-supplied tool call id in public schemas", async () => {
        for (const schema of Object.values(SCHEMAS)) {
            const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
            expect(properties).not.toHaveProperty("id");
        }
    });

    it("documents the analyzer program syntax so callers use ES module export", () => {
        for (const schemaKey of ["execute", "executeFile", "batchExecute"] as const) {
            const schema = SCHEMAS[schemaKey] as {
                properties?: Record<string, { description?: string }>;
            };
            const program = schema.properties?.program;
            expect(program?.description).toBeDefined();
            // The description must warn that top-level return is invalid and
            // that ES module export default is required for JavaScript and
            // TypeScript, and that Python binds `result` directly.
            expect(program?.description).toMatch(/export default/i);
            expect(program?.description).toMatch(/python/i);
            expect(program?.description).toMatch(/result/i);
        }
        // language descriptions must enumerate javascript / typescript / python
        for (const schemaKey of ["execute", "executeFile", "batchExecute"] as const) {
            const schema = SCHEMAS[schemaKey] as {
                properties?: Record<string, { description?: string }>;
            };
            const language = schema.properties?.language;
            expect(language?.description).toBeDefined();
        }
    });

    it("rejects execute when more than one source is provided", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.execute(
                {
                    id: "x",
                    language: "javascript",
                    program: "1",
                    command: "echo",
                    content: "inline",
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/exactly one source/);
    });

    it("rejects execute when no source is provided", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.execute(
                {
                    id: "x",
                    language: "javascript",
                    program: "1",
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/exactly one source/);
    });

    it("rejects unknown languages", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.execute(
                {
                    id: "x",
                    language: "ruby",
                    program: "1",
                    content: "hi",
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/Unsupported language/);
    });

    it("rejects batch execute with too many items", async () => {
        const { handlers } = await setup();
        const items = Array.from({ length: 17 }, (_, i) => ({
            id: `i${i}`,
            command: "echo",
        }));
        await expect(
            handlers.batchExecute(
                {
                    id: "x",
                    language: "javascript",
                    program: "1",
                    items,
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/Batch execute exceeds/);
    });

    it("rejects invalid archive IDs in think_index", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.index({
                id: "x",
                kind: "command-summary",
                source: "echo",
                archiveIds: ["bad id with spaces"],
            }),
        ).rejects.toThrow(/invalid archive id/);
    });

    it("rejects fetch/network parameters on any think_* tool", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.execute(
                {
                    id: "x",
                    language: "javascript",
                    program: "1",
                    content: "hi",
                    fetch: { url: "https://example.com" },
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/Fetch\/network/);
    });

    it("limits think_search to 20 results", async () => {
        const { handlers, coordinator } = await setup();
        for (let i = 0; i < 25; i += 1) {
            coordinator.store.index({
                kind: "document-summary",
                source: `s-${i}`,
                text: `fence_marker_${i}`,
            });
        }
        const result = (await handlers.search({
            id: "x",
            query: "fence_marker",
            limit: 100,
        })) as { details: { archiveIds: readonly string[] } };
        expect(result.details.archiveIds.length).toBeLessThanOrEqual(20);
    });

    it("returns bounded derived text from think_execute and never raw output", async () => {
        const safeExec = fakeSafeExecution("leak-text-payload");
        const { handlers } = await setup(safeExec);
        const result = (await handlers.execute(
            {
                id: "x",
                language: "javascript",
                program: "INPUT",
                command: "echo",
            },
            ctx("/workspace/proj"),
        )) as { content: { text: string }[]; details: { derivedBytes: number } };
        expect(result.content[0]?.text).toBe("DERIVED");
        expect(result.details.derivedBytes).toBe(7);
    });

    it("runs think_batch_execute through the shared safe execution", async () => {
        const safeExec = fakeSafeExecution("batch-output");
        const { handlers } = await setup(safeExec);
        const result = (await handlers.batchExecute(
            {
                id: "x",
                language: "javascript",
                program: "INPUTS",
                items: [
                    { id: "a", command: "echo a" },
                    { id: "b", command: "echo b" },
                ],
            },
            ctx("/workspace/proj"),
        )) as {
            details: { items: Array<{ id: string; status: string }> };
        };
        expect(result.details.items.length).toBe(2);
        expect(result.details.items.every((i) => i.status === "succeeded")).toBe(
            true,
        );
    });

    it("think_index without text or archiveIds is rejected", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.index({
                id: "x",
                kind: "command-summary",
                source: "echo",
            }),
        ).rejects.toThrow(/think_index requires either text or archiveIds/);
    });

    it("forwards Pi's real toolCallId and sanitizes the progress callback before safe execution", async () => {
        const safeExec = fakeSafeExecution("ok");
        const { handlers } = await setup(safeExec);
        const progressFn = () => undefined;
        await handlers.execute(
            {
                language: "javascript",
                program: "INPUT",
                command: "echo hi",
            },
            ctx("/workspace/proj"),
            {
                toolCallId: "pi-real-call-id",
                onUpdate: progressFn,
            },
        );
        // The fake safe execution records every call; we must observe the
        // runtime-supplied toolCallId and a sanitizing wrapper callback, never
        // the raw parent function (which would let raw stdout reach the
        // `partialResult.content[].text` field of tool_execution_update).
        const recorded = (
            safeExec.execute as ReturnType<typeof mock>
        ).mock.calls.at(-1)?.[0] as {
            toolCallId: string;
            onUpdate?: (partial: unknown) => void;
        };
        expect(recorded.toolCallId).toBe("pi-real-call-id");
        expect(typeof recorded.onUpdate).toBe("function");
        expect(recorded.onUpdate).not.toBe(progressFn);
    });

    it("think_execute with archives source re-reads bounded bytes and never returns raw output", async () => {
        const safeExec = fakeSafeExecution("primary-output");
        const { handlers, coordinator } = await setup(safeExec);
        // First call archives the command output as a side-effect.
        const first = (await handlers.execute(
            {
                language: "javascript",
                program: "INPUT",
                command: "echo primary",
            },
            ctx("/workspace/proj"),
            { toolCallId: "first-call" },
        )) as { details: { archiveIds: readonly string[] } };
        const sourceArchiveId = first.details.archiveIds[0]!;

        // Second call reuses the archive via the archives source. The model
        // never sees the raw bytes — only the bounded analyzer view.
        const result = (await handlers.execute(
            {
                language: "javascript",
                program: "INPUT",
                archiveIds: [sourceArchiveId],
            },
            ctx("/workspace/proj"),
            { toolCallId: "second-call" },
        )) as { content: { text: string }[] };
        expect(result.content[0]?.text).toBe("DERIVED");
        const storeAfter = coordinator.store;
        expect(storeAfter.archiveBytes()).toBeGreaterThan(0);
    });
});
