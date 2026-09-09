import { beforeEach, expect, test } from "bun:test";

import { hostExecution } from "../_shared/execution-provenance/index.ts";
import type { AnalysisSandboxPort } from "../_shared/sandbox-runtime/index.ts";
import {
    clearSandboxExecutionContexts,
    resolveSandboxExecutionContext,
    withSandboxExecutionContext,
    type SandboxExecutionContextV1,
} from "../_shared/sandbox-runtime/execution-context.ts";
import { withThinkExecution } from "./execution-provenance.ts";

const analysisContext: SandboxExecutionContextV1 = {
    version: 1,
    profile: "analysis-strict",
    filesystem: { allowRead: ["/runtime"], denyRead: ["/tmp"], denyReadGlobs: [], allowWrite: ["<sandbox-home>"], denyWrite: ["/tmp"], denyWriteGlobs: [] },
    network: {
        mode: "deny-all",
        allow: [],
        allowHost: [],
        deny: [],
        domainClientProxyRequired: false,
        loopback: {
            hostNamespace: "isolated",
            hostBridgePorts: [],
            hostBridgeTransport: "disabled",
            unlistedHostPorts: "blocked",
            localListeners: "disabled",
        },
    },
    tmp: { path: "/tmp", namespace: "lease-private" },
    ipc: { hostUserDbus: "unavailable", hostUnixSockets: "unavailable" },
    docker: { mode: "off", profile: "None", targets: [], hostAccessException: false },
    environment: { inherit: [], set: ["HOME"], deny: [] },
};

beforeEach(() => clearSandboxExecutionContexts());

test("records the exact analysis context for the outer tool call", async () => {
    const port: AnalysisSandboxPort = {
        run: async () => ({
            output: "derived",
            stderr: "",
            runtime: "quickjs",
            durationMs: 1,
            truncated: false,
            sandboxContext: analysisContext,
        }),
        shutdown: async () => undefined,
    };

    await withThinkExecution(
        () => ({ sourceExecution: hostExecution() }),
        async (trace) => {
            await trace.run(port, {
                id: "outer-call",
                language: "javascript",
                program: "export default 1",
            });
            return {
                content: [{ type: "text" as const, text: "{}" }],
                details: {},
            };
        },
    );

    expect(resolveSandboxExecutionContext("outer-call")).toEqual(
        analysisContext,
    );
});

test("records the dispatch context when analysis throws", async () => {
    const port: AnalysisSandboxPort = {
        run: async () => {
            throw withSandboxExecutionContext(
                new Error("analysis failed"),
                analysisContext,
            );
        },
        shutdown: async () => undefined,
    };

    await expect(
        withThinkExecution(
            () => ({ sourceExecution: hostExecution() }),
            async (trace) => {
                await trace.run(port, {
                    id: "failed-outer-call",
                    language: "javascript",
                    program: "export default 1",
                });
                return {
                    content: [{ type: "text" as const, text: "{}" }],
                    details: {},
                };
            },
        ),
    ).rejects.toThrow("analysis failed");
    expect(resolveSandboxExecutionContext("failed-outer-call")).toEqual(
        analysisContext,
    );
});
