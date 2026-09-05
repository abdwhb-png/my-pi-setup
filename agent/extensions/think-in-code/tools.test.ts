import {
    afterEach,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandExecutionService } from "../_shared/command-execution/core.ts";
import type { AnalysisSandboxPort } from "../_shared/sandbox-runtime/index.ts";

import type { ThinkCommandOperation } from "./command-policy.ts";
import { DEFAULT_THINK_IN_CODE_CONFIG } from "./config.ts";
import { ThinkStore } from "./storage/store.ts";
import { ThinkCoordinator } from "./coordinator.ts";
import { buildToolHandlers, SCHEMAS } from "./tools.ts";

function ctx(cwd: string): ExtensionContext {
    return { cwd, hasUI: false, ui: {} } as unknown as ExtensionContext;
}

function fakeSafeExecution(text: string): CommandExecutionService<ThinkCommandOperation> {
    return {
        execute: mock(async () => ({
            content: [{ type: "text" as const, text }],
            details: undefined,
        })),
    };
}

function fakeAnalysis(output: string): AnalysisSandboxPort {
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

    afterEach(async () => {
        coordinator?.close();
        if (home) await rm(home, { recursive: true, force: true });
        home = undefined;
        coordinator = undefined;
    });

    async function setup(
        safeExec: CommandExecutionService<ThinkCommandOperation> = fakeSafeExecution("ok"),
        analysis: AnalysisSandboxPort = fakeAnalysis("DERIVED"),
    ): Promise<{ coordinator: ThinkCoordinator; handlers: ReturnType<typeof buildToolHandlers> }> {
        home = await mkdtemp(join(tmpdir(), "think-in-code-tools-"));
        const storeRoot = join(home, "store");
        await mkdir(storeRoot, { recursive: true });
        const store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot,
            canonicalPath: "/workspace/proj",
        });
        coordinator = new ThinkCoordinator({
            store,
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            commandExecution: safeExec,
            getAnalysisPort: () => analysis,
        });
        const handlers = buildToolHandlers(coordinator);
        return { coordinator, handlers };
    }

    it("publishes three schemas with one portable execute action discriminator", () => {
        expect(Object.keys(SCHEMAS)).toEqual(["execute", "note", "search"]);

        const executeSchema = SCHEMAS.execute as {
            properties?: Record<string, unknown>;
        };
        expect(executeSchema.properties?.action).toMatchObject({
            type: "string",
            enum: ["command", "content", "archives", "file", "batch"],
        });
        expect(executeSchema.properties?.action).not.toHaveProperty("anyOf");
    });

    it("keeps the complete public schema below the five-tool context budget", () => {
        expect(JSON.stringify(SCHEMAS).length).toBeLessThan(2_600);
        expect(
            JSON.stringify({ note: SCHEMAS.note, search: SCHEMAS.search })
                .length,
        ).toBeLessThanOrEqual(512);
    });

    it("publishes provider-portable string enums in all public schemas", () => {
        expect(Object.keys(SCHEMAS)).toEqual(["execute", "note", "search"]);

        const expectedLanguageSchema = {
            type: "string",
            enum: ["javascript", "typescript", "python"],
        };
        const executeSchema = SCHEMAS.execute as {
            properties?: Record<string, unknown>;
        };
        expect(executeSchema.properties?.language).toMatchObject(
            expectedLanguageSchema,
        );
        expect(executeSchema.properties?.language).not.toHaveProperty("anyOf");

        const noteSchema = SCHEMAS.note as {
            properties?: Record<string, unknown>;
        };
        expect(noteSchema.properties).not.toHaveProperty("kind");
    });

    it("rejects additional properties in every public and nested object schema", () => {
        const expectRejected = (
            name: string,
            schema: (typeof SCHEMAS)[keyof typeof SCHEMAS],
            args: Record<string, unknown>,
        ): void => {
            expect(() =>
                validateToolArguments(
                    { name, description: "test", parameters: schema },
                    { type: "toolCall", id: "test", name, arguments: args },
                ),
            ).toThrow(/Validation failed/);
        };
        const execute = {
            action: "command",
            language: "javascript",
            program: "export default INPUT.length",
            command: "printf test",
        };

        expectRejected("think_execute", SCHEMAS.execute, {
            ...execute,
            network: true,
        });
        expectRejected("think_execute", SCHEMAS.execute, {
                ...execute,
                limits: { wallTimeMs: 100, fetch: true },
            });
        expectRejected("think_execute", SCHEMAS.execute, {
                action: "batch",
                language: "javascript",
                program: "export default INPUTS.length",
                items: [{ id: "one", command: "printf test", network: true }],
            });
        expectRejected("think_note", SCHEMAS.note, {
                source: "review",
                text: "conclusion",
                fetch: true,
            });
        expectRejected("think_search", SCHEMAS.search, {
                query: "conclusion",
                network: true,
            });
    });

    it("does not expose a model-supplied tool call id in public schemas", async () => {
        for (const schema of Object.values(SCHEMAS)) {
            const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
            expect(properties).not.toHaveProperty("id");
        }
    });

    it("documents the analyzer program syntax so callers use ES module export", () => {
        const schema = SCHEMAS.execute as {
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
        // language descriptions must enumerate javascript / typescript / python
        expect(schema.properties?.language?.description).toBeDefined();
    });

    it("rejects fields that do not belong to the selected action", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.execute(
                {
                    id: "x",
                    action: "command",
                    language: "javascript",
                    program: "1",
                    command: "echo",
                    content: "inline",
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/command does not accept content/);
    });

    it("rejects execute when the selected action has no source", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.execute(
                {
                    id: "x",
                    action: "command",
                    language: "javascript",
                    program: "1",
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/command must be a string/);
    });

    it("rejects unknown languages", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.execute(
                {
                    id: "x",
                    action: "content",
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
            handlers.execute(
                {
                    id: "x",
                    action: "batch",
                    language: "javascript",
                    program: "1",
                    items,
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/Batch execute exceeds/);
    });

    it("rejects invalid archive provenance in think_note", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.note({
                id: "x",
                source: "echo",
                text: "derived note",
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
                    action: "content",
                    language: "javascript",
                    program: "1",
                    content: "hi",
                    fetch: { url: "https://example.com" },
                },
                ctx("/workspace/proj"),
            ),
        ).rejects.toThrow(/Fetch\/network/);
    });

    it("rejects unexpected fields on think_search", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.search({
                id: "x",
                query: "anything",
                network: true,
            }),
        ).rejects.toThrow(/think_search does not accept network/);
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

    it("returns bounded analyzer text instead of command output", async () => {
        const safeExec = fakeSafeExecution("leak-text-payload");
        const { handlers, coordinator } = await setup(safeExec);
        const result = (await handlers.execute(
            {
                id: "x",
                action: "command",
                language: "javascript",
                program: "INPUT",
                command: "echo",
            },
            ctx("/workspace/proj"),
        )) as { content: { text: string }[]; details: { derivedBytes: number } };
        expect(result.content[0]?.text).toBe("DERIVED");
        expect(result.details.derivedBytes).toBe(7);
        expect(coordinator.store.search("DERIVED", 5)).toHaveLength(1);
    });

    it("runs think_execute action=batch through the shared safe execution", async () => {
        const safeExec = fakeSafeExecution("batch-output");
        const { handlers, coordinator } = await setup(
            safeExec,
            fakeAnalysis("batch-derived-marker"),
        );
        const result = (await handlers.execute(
            {
                id: "x",
                action: "batch",
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
        expect(coordinator.store.search("batch-derived-marker", 5)).toHaveLength(
            1,
        );
    });

    it("does not auto-index arbitrary file analysis output", async () => {
        const { handlers, coordinator } = await setup(
            fakeSafeExecution("unused"),
            fakeAnalysis("raw-file-payload"),
        );
        await writeFile(join(home!, "fixture.txt"), "raw-file-payload", "utf8");

        await handlers.execute(
            {
                action: "file",
                language: "javascript",
                program: "export default FILE_CONTENT",
                path: "fixture.txt",
            },
            ctx(home!),
            { toolCallId: "file-analysis-call" },
        );

        expect(coordinator.store.search("raw-file-payload", 5)).toEqual([]);
    });

    it("does not index an empty successful analysis", async () => {
        const { handlers, coordinator } = await setup(
            fakeSafeExecution("unused"),
            fakeAnalysis(" \n "),
        );

        await handlers.execute(
            {
                id: "empty-derived",
                action: "content",
                language: "javascript",
                program: "export default ''",
                content: "raw-source-marker",
            },
            ctx("/workspace/proj"),
        );

        expect(coordinator.store.search("raw-source-marker", 5)).toEqual([]);
    });

    it("does not index archive identifiers when batch analysis fails", async () => {
        const failingAnalysis: AnalysisSandboxPort = {
            run: mock(async () => {
                throw new Error("analysis failed");
            }),
            shutdown: async () => undefined,
        };
        const { handlers, coordinator } = await setup(
            fakeSafeExecution("batch-source"),
            failingAnalysis,
        );

        const result = (await handlers.execute(
            {
                action: "batch",
                language: "javascript",
                program: "export default INPUTS",
                items: [{ id: "one", command: "echo one" }],
            },
            ctx(home!),
            { toolCallId: "failed-batch-call" },
        )) as { details: { archiveIds: readonly string[] } };

        const archivedId = result.details.archiveIds[0]!;
        expect(coordinator.store.search(archivedId, 5)).toHaveLength(0);
    });

    it("think_note always requires explicit text", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.note({
                id: "x",
                source: "echo",
            }),
        ).rejects.toThrow(/text must be a string/);
    });

    it("rejects legacy index fields on think_note", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.note({
                id: "x",
                source: "legacy-note",
                text: "concise conclusion",
                kind: "analysis-summary",
            }),
        ).rejects.toThrow(/think_note does not accept kind/);
    });

    it("rejects notes larger than the effective indexed text limit", async () => {
        const { handlers } = await setup();
        await expect(
            handlers.note({
                id: "x",
                source: "bounded-note",
                text: "x".repeat(
                    DEFAULT_THINK_IN_CODE_CONFIG.indexedSnippetChars + 1,
                ),
            }),
        ).rejects.toThrow(/1024 characters/);
    });

    it("forwards Pi's real toolCallId and sanitizes the progress callback before safe execution", async () => {
        const safeExec = fakeSafeExecution("ok");
        const { handlers } = await setup(safeExec);
        const progressFn = () => undefined;
        await handlers.execute(
            {
                action: "command",
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
                action: "command",
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
                action: "archives",
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
        expect(storeAfter.search("DERIVED", 5).length).toBeGreaterThanOrEqual(2);
    });
});
