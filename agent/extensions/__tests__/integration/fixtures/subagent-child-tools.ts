import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    getCurrentTools,
    type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Model responses are scripted; native tools, extension loading and dispatch stay real. */
export default function registerChildTools(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "fixture_ping",
        label: "Fixture ping",
        description: "Return a child-only extension proof",
        parameters: Type.Object({}),
        async execute() {
            return {
                content: [{ type: "text", text: "extension-call-proof" }],
                details: {},
            };
        },
    });
    const faux = fauxProvider({
        provider: "fixture-child",
        models: [
            { id: "check", contextWindow: 100000, maxTokens: 2048 },
            { id: "mcp", contextWindow: 100000, maxTokens: 2048 },
        ],
    });
    const respond: FauxResponseFactory = async (
        context,
        options,
        state,
        model,
    ) => {
        const resumed = context.messages.some(
            (message) =>
                message.role === "user" &&
                JSON.stringify(message.content).includes("fixture-resume"),
        );
        const calls = [
            fauxToolCall("read", { path: "proof.txt" }),
            fauxToolCall("fixture_ping", {}),
            fauxToolCall("write", {
                path: "forbidden.txt",
                content: "must not write",
            }),
        ];
        if (model.id === "mcp")
            calls.push(
                fauxToolCall("fixture_echo", {
                    message: resumed ? "revived" : "initial",
                }),
            );
        const call = calls[state.callCount - 1];
        if (call) {
            faux.appendResponses([respond]);
            return fauxAssistantMessage(call);
        }
        const evidence = {
            proof: "child-tool-contract",
            phase: resumed ? "revived" : "initial",
            runtime: process.versions.bun,
            node: process.versions.node,
            executable: process.execPath,
            sdk: import.meta.resolve("@earendil-works/pi-coding-agent"),
            subagents: import.meta.resolve("pi-subagents"),
            pid: process.pid,
            childMarker: process.env.PI_SUBAGENT_CHILD,
            tools: getCurrentTools(context.messages).map((tool) => tool.name),
            results: context.messages.filter(
                (message) => message.role === "toolResult",
            ),
        };
        appendFileSync(
            join(process.cwd(), "child-evidence.jsonl"),
            JSON.stringify(evidence) + "\n",
        );
        if (model.id === "mcp" && !resumed) {
            const signal = options?.signal;
            if (!signal) throw new Error("Missing child cancellation signal");
            if (!signal.aborted)
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), {
                        once: true,
                    }),
                );
        }
        return fauxAssistantMessage(JSON.stringify(evidence));
    };
    faux.setResponses([respond]);
    pi.registerProvider(faux.provider);
}
