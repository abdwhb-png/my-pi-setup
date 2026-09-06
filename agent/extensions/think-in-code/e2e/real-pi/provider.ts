import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import {
    createFauxCore,
    fauxAssistantMessage,
    fauxToolCall,
    type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const tracePath = process.env.THINK_SMOKE_TRACE;
const phase = process.env.THINK_SMOKE_PHASE ?? "functional";
type OpaqueValue = ErrorOptions["cause"];

function property(value: OpaqueValue, key: PropertyKey): OpaqueValue {
    return typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined;
}

function textOf(content: OpaqueValue): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (block) =>
                property(block, "type") === "text" &&
                typeof property(block, "text") === "string",
        )
        .map((block) => String(property(block, "text")))
        .join("\n");
}

function traceContext(context: Context, label: string): void {
    if (!tracePath) return;
    const receipts = context.messages
        .map((message) => textOf(property(message, "content")))
        .filter((text) => text.includes('"type":"think-execution-receipts"'));
    const toolResults = context.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => ({
            toolName: message.toolName,
            isError: message.isError,
            contentText: textOf(message.content),
            detailsPresent: Object.hasOwn(message, "details"),
        }));
    appendFileSync(
        tracePath,
        `${JSON.stringify({
            phase,
            label,
            tools: context.tools?.map((candidate) => candidate.name) ?? [],
            ctxTools:
                context.tools
                    ?.map((candidate) => candidate.name)
                    .filter((name) => name.startsWith("ctx_")) ?? [],
            toolResults,
            snapshotMessageCount: receipts.length,
            snapshotBytes: receipts.map((text) =>
                Buffer.byteLength(text, "utf8"),
            ),
            snapshotContents: receipts,
        })}\n`,
    );
}

function traced(
    label: string,
    build: FauxResponseFactory,
): FauxResponseFactory {
    return (context, options, state, model) => {
        traceContext(context, label);
        return build(context, options, state, model);
    };
}

function tool(name: string, arguments_: Record<string, unknown>, id: string) {
    return fauxAssistantMessage(fauxToolCall(name, arguments_, { id }), {
        stopReason: "toolUse",
    });
}

function archiveIds(context: Context): string[] {
    return context.messages.flatMap((message) => {
        if (message.role !== "toolResult") return [];
        const firstLine = textOf(message.content).split("\n", 1)[0];
        if (!firstLine) return [];
        let header: OpaqueValue;
        try {
            header = JSON.parse(firstLine);
        } catch {
            return [];
        }
        const ids = property(header, "archiveIds");
        return Array.isArray(ids)
            ? ids.filter((value): value is string => typeof value === "string")
            : [];
    });
}

export default function register(pi: ExtensionAPI): void {
    const faux = createFauxCore({
        api: "think-smoke",
        provider: "think-smoke",
        models: [
            {
                id: "smoke",
                name: "Think smoke",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 131_072,
                maxTokens: 4096,
            },
        ],
    });

    pi.registerProvider("think-smoke", {
        name: "Think smoke",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "smoke-key",
        api: faux.api,
        streamSimple: faux.streamSimple,
        models: faux.models.map((model) => ({
            id: model.id,
            name: model.name,
            api: model.api,
            baseUrl: model.baseUrl,
            reasoning: model.reasoning,
            input: model.input,
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
        })),
    });

    if (phase === "bash-architecture") {
        const sandboxProbe =
            'test ! -e "$HOME/.pi/agent/settings.json" && printf zerobox';
        faux.setResponses([
            traced("bash-start", () =>
                tool("bash", { command: sandboxProbe }, "smoke-bash"),
            ),
            traced("after-bash", () =>
                tool("safe_bash", { command: sandboxProbe }, "smoke-safe-bash"),
            ),
            traced("bash-complete", () =>
                fauxAssistantMessage("bash architecture smoke complete"),
            ),
        ]);
        return;
    }

    if (phase === "functional") {
        faux.setResponses([
            traced("functional-start", () =>
                tool(
                    "think_execute",
                    {
                        action: "content",
                        language: "javascript",
                        content: "alpha beta gamma",
                        program: "export default INPUT.split(/\\s+/).length",
                    },
                    "smoke-execute",
                ),
            ),
            traced("after-execute", () =>
                tool(
                    "think_execute",
                    {
                        action: "command",
                        language: "javascript",
                        command: "printf partial-source; exit 7",
                        program: "export default INPUT.length",
                    },
                    "smoke-partial",
                ),
            ),
            traced("after-partial", () =>
                tool(
                    "think_execute",
                    {
                        action: "file",
                        path: "fixture.txt",
                        language: "javascript",
                        program:
                            "export default FILE_CONTENT.trim().split(/\\s+/).length",
                    },
                    "smoke-file",
                ),
            ),
            traced("after-file", () =>
                tool(
                    "think_execute",
                    {
                        action: "batch",
                        language: "javascript",
                        program:
                            "export default INPUTS.map((item) => item.output?.length ?? 0).join('|')",
                        items: [{ id: "red", command: "printf red" }],
                    },
                    "smoke-batch",
                ),
            ),
            traced("after-batch", () =>
                tool(
                    "think_execute",
                    {
                        action: "content",
                        language: "javascript",
                        content: "artifact seed",
                        program:
                            'export default "needle-verification execution artifact"',
                    },
                    "smoke-index",
                ),
            ),
            traced("after-index", () =>
                tool(
                    "think_artifact_search",
                    { query: "needle-verification", limit: 5 },
                    "smoke-search",
                ),
            ),
            traced("after-search", (context) => {
                const id = archiveIds(context)[0];
                if (!id) {
                    return fauxAssistantMessage("missing archive id", {
                        stopReason: "error",
                        errorMessage: "missing archive id",
                    });
                }
                return tool(
                    "think_execute",
                    {
                        action: "archives",
                        language: "javascript",
                        archiveIds: [id],
                        program: "export default INPUT.length",
                    },
                    "smoke-reanalysis",
                );
            }),
            traced("after-reanalysis", () =>
                tool(
                    "think_execute",
                    {
                        action: "content",
                        language: "javascript",
                        content: "network must stay sealed",
                        program: "export default fetch('https://example.com')",
                    },
                    "smoke-sandbox-refusal",
                ),
            ),
            traced("functional-end", () =>
                fauxAssistantMessage("functional smoke complete"),
            ),
        ]);
        return;
    }

    if (phase === "compact") {
        faux.setResponses([
            traced("compact-seed", () =>
                fauxAssistantMessage("large seed recorded"),
            ),
            traced("compact-summary", () =>
                fauxAssistantMessage("deterministic compact summary"),
            ),
            traced("post-compact-first", () =>
                fauxAssistantMessage("post compact first complete"),
            ),
            traced("post-compact-second", () =>
                fauxAssistantMessage("post compact second complete"),
            ),
        ]);
        return;
    }

    faux.setResponses([
        traced(`post-${phase}`, () =>
            fauxAssistantMessage(`post ${phase} complete`),
        ),
    ]);
}
