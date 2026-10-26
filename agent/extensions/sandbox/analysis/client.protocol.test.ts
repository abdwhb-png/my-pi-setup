import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { analysisErrorClassFromError } from "../../_shared/sandbox-runtime/errors.ts";
import { executionFromDetails } from "../../_shared/execution-provenance/index.ts";

let response: object;
mock.module("node:child_process", () => ({
    spawn: () => {
        const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        });
        child.stdin.on("finish", () => queueMicrotask(() => {
            child.stdout.end(JSON.stringify(response));
            child.stderr.end();
            child.emit("close", 0);
        }));
        return child;
    },
}));
const { createAnalysisSandboxService } = await import("./client.ts");
afterAll(() => mock.restore());

test.each(["SyntaxError", "ReferenceError", "TypeError", undefined, "SECRET_CLASS"])(
    "the host process client preserves only validated metadata: %s", async (errorClass) => {
        response = {
            ok: false, error: "technical diagnostic", errorClass,
            execution: { status: "sandboxed", profile: "analysis-strict", backend: "zerobox", tmpNamespace: "lease-private", phase: "analysis", outcome: "failed", exitCode: 1 },
        };
        const service = createAnalysisSandboxService();
        let failure: unknown;
        try {
            await service.run({ id: "protocol-error", language: "javascript", program: "export default 1 ≤ 2;" });
        } catch (error) { failure = error; }
        finally { await service.shutdown(); }
        expect(failure).toBeInstanceOf(Error);
        expect(analysisErrorClassFromError(failure)).toBe(errorClass === "SECRET_CLASS" ? undefined : errorClass);
        expect(executionFromDetails(failure)).toMatchObject({ outcome: "failed", exitCode: 1 });
    },
);
