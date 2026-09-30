import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import {
    SUBAGENT_RPC_READY_EVENT,
    SubagentRpcClient,
} from "../../../_shared/subagents/rpc-client.ts";

/** Offline CLI fixture. Only model responses are synthetic; delegation remains upstream. */
export default function registerLifecycleFixture(pi: ExtensionAPI): void {
    const faux = fauxProvider({
        provider: "fixture",
        models: [
            { id: "deterministic", contextWindow: 100000, maxTokens: 1024 },
        ],
    });
    faux.setResponses([fauxAssistantMessage("fixture-child-complete")]);
    pi.registerProvider(faux.provider);
    const rpc = new SubagentRpcClient(pi.events, {
        sourceExtension: "lifecycle-fixture",
        timeoutMs: 10000,
    });
    const stopCompletions = rpc.onAsyncComplete((completion) =>
        console.log(JSON.stringify({ type: "fixture_complete", completion })),
    );
    const stopReady = pi.events.on(SUBAGENT_RPC_READY_EVENT, (data) => {
        if (!data || typeof data !== "object" || !("session" in data))
            throw new Error("Missing fixture RPC session");
        const session = data.session;
        if (
            !session ||
            typeof session !== "object" ||
            !("sessionId" in session) ||
            typeof session.sessionId !== "string"
        )
            throw new Error("Missing fixture session id");
        const id =
            "sessionFile" in session && typeof session.sessionFile === "string"
                ? session.sessionFile
                : session.sessionId;
        const settings = JSON.parse(
            readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
        );
        console.log(
            JSON.stringify({
                type: "fixture_upstream_ready",
                ceiling: resolveSubagentCapabilityCeiling(id),
                generatedTools:
                    settings.subagents?.agentOverrides?.reader?.tools,
            }),
        );
    });
    const launch = {
        agent: "reader",
        task: "Reply fixture-child-complete",
        model: "fixture/deterministic",
        async: false,
        skill: false,
        context: "fresh",
        artifacts: false,
        intercomBridge: { mode: "off" },
    };
    pi.on("session_start", (event, ctx) => {
        console.log(
            JSON.stringify({
                type: "fixture_ready",
                reason: event.reason,
                runtime: process.versions.bun,
                pid: process.pid,
                sdkRoot: process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT,
                entrypoint: process.argv[1],
                sessionId:
                    ctx.sessionManager.getSessionFile() ??
                    ctx.sessionManager.getSessionId(),
                tools: pi.getAllTools().map((tool) => tool.name),
            }),
        );
    });
    pi.registerCommand("fixture-arm", {
        description: "Queue an offline tool delegation",
        handler: async () => {
            faux.setResponses([
                fauxAssistantMessage(fauxToolCall("subagents_enable", {})),
                fauxAssistantMessage(fauxToolCall("subagent", launch)),
                fauxAssistantMessage("fixture-parent-complete"),
            ]);
        },
    });
    pi.registerCommand("fixture-foreground", {
        description: "Queue an actual foreground child with tool probes",
        handler: async () => {
            faux.setResponses([
                fauxAssistantMessage(fauxToolCall("subagents_enable", {})),
                fauxAssistantMessage(
                    fauxToolCall("subagent", {
                        ...launch,
                        agent: "probe",
                        model: "fixture-child/check",
                    }),
                ),
                fauxAssistantMessage("fixture-parent-complete"),
            ]);
        },
    });
    pi.registerCommand("fixture-warm-mcp", {
        description: "Populate metadata through a real local MCP call",
        handler: async () => {
            faux.setResponses([
                fauxAssistantMessage(
                    fauxToolCall("mcp", {
                        server: "fixture",
                        tool: "echo",
                        args: { message: "warm" },
                    }),
                ),
                fauxAssistantMessage("fixture-parent-complete"),
            ]);
        },
    });
    for (const method of ["interrupt", "resume", "stop"] as const) {
        pi.registerCommand(`fixture-${method}`, {
            description: `Use public RPC ${method} for the fixture child`,
            handler: async (id) => {
                try {
                    const result = await rpc[method]({
                        id: id.trim(),
                        ...(method === "resume"
                            ? { message: "fixture-resume" }
                            : {}),
                    });
                    console.log(
                        JSON.stringify({ type: "fixture_rpc", result }),
                    );
                } catch (error) {
                    console.log(
                        JSON.stringify({
                            type: "fixture_rpc",
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        }),
                    );
                }
            },
        });
    }
    pi.registerCommand("fixture-rpc", {
        description: "Run a real local subagent RPC request",
        handler: async (args) => {
            try {
                const result = await rpc.spawn({
                    ...launch,
                    async: true,
                    ...(args === "mcp"
                        ? { agent: "mcp-probe", model: "fixture-child/mcp" }
                        : {}),
                });
                console.log(JSON.stringify({ type: "fixture_rpc", result }));
            } catch (error) {
                console.log(
                    JSON.stringify({
                        type: "fixture_rpc",
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    }),
                );
            }
        },
    });
    pi.registerCommand("fixture-contract", {
        description:
            "Inspect official launch contract and current denial ceiling",
        handler: async (_args, ctx) => {
            const ceiling = resolveSubagentCapabilityCeiling(
                ctx.sessionManager.getSessionFile() ??
                    ctx.sessionManager.getSessionId(),
            );
            const result = await resolveSubagentLaunchContract({
                ...launch,
                cwd: ctx.cwd,
                context: "fresh",
                intercomBridge: { mode: "off" },
                capabilityCeiling: ceiling,
            });
            console.log(
                JSON.stringify({ type: "fixture_contract", ceiling, result }),
            );
        },
    });
    pi.registerCommand("fixture-reload", {
        description: "Reload actual CLI extension runtime",
        handler: async (_args, ctx) => {
            await ctx.reload();
        },
    });
    pi.on("session_shutdown", () => {
        stopReady();
        stopCompletions();
        rpc.dispose();
    });
}
