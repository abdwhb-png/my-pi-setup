import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_ID = "legacy-fixture-run";

function unsupportedOperation(): never {
    throw new Error("Migration status test invoked an unrelated operation.");
}

test("portable legacy fixture survives dynamic extension import and temporary-store status", async () => {
    const temporaryAgentDir = mkdtempSync(join(tmpdir(), "sdd-migration-"));
    try {
        const queueDirectory = join(temporaryAgentDir, ".sdd", "queue");
        mkdirSync(queueDirectory, { recursive: true });
        const temporaryQueuePath = join(queueDirectory, `${RUN_ID}.json`);
        const portablePlanPath = "~/work/plans/portable.md";
        const queueBefore = `${JSON.stringify(
            { runId: RUN_ID, planPath: portablePlanPath },
            null,
            2,
        )}\n`;
        writeFileSync(temporaryQueuePath, queueBefore);

        const { registerSddExtension } = await import("./index.ts");
        const { SddStore } = await import("./store.ts");
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
        registerSddExtension(
            pi as never,
            {
                agentDir: temporaryAgentDir,
                store: new SddStore(temporaryAgentDir),
                delegation: { run: unsupportedOperation, dispose() {} },
                workflow: {
                    run: unsupportedOperation,
                    cancel: unsupportedOperation,
                    completeDirect: unsupportedOperation,
                    reconcile: unsupportedOperation,
                },
            } as never,
        );

        const status = tools.get("sdd_status");
        expect(status).toBeDefined();
        const result = await status!.execute(
            "migration-status",
            { runId: RUN_ID },
            undefined,
            undefined,
            { cwd: temporaryAgentDir, mode: "print" },
        );
        expect(result.content[0].text).toContain(
            `${RUN_ID}: legacy_queued (${portablePlanPath})`,
        );
        expect(result.details.snapshot).toMatchObject({
            runId: RUN_ID,
            status: "legacy_queued",
            planPath: portablePlanPath,
        });
        const temporaryQueueAfter = readFileSync(temporaryQueuePath, "utf8");
        expect(temporaryQueueAfter).toBe(queueBefore);
    } finally {
        rmSync(temporaryAgentDir, { recursive: true, force: true });
    }
});
