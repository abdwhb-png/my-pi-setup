import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
// Opt-in behavioral smoke test. Only synthetic job tools are available to the model.
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
    addExecutionContext,
    hostExecution,
} from "../../_shared/execution-provenance/index.ts";

if (process.env.PI_INTERRUPTION_EVAL !== "1") {
    throw new Error(
        "Set PI_INTERRUPTION_EVAL=1 to use the configured provider for this synthetic evaluation.",
    );
}
const agentDir = join(homedir(), ".pi", "agent");
const settings: { defaultProvider: string; defaultModel: string } = JSON.parse(
    await readFile(join(agentDir, "settings.json"), "utf8"),
);
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const model = runtime.getModel(settings.defaultProvider, settings.defaultModel);
if (!model) throw new Error("The configured evaluation model is unavailable.");
const messages: AgentMessage[] = [
    {
        role: "user",
        content:
            "Submit the job, then report its result. Continue from the previous tool result.",
        timestamp: 1,
    },
    {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
            {
                type: "toolCall",
                id: "submit-1",
                name: "submit_job",
                arguments: {
                    attemptId: "attempt-1",
                    resultFile: "attempt-1.json",
                },
            },
        ],
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        stopReason: "toolUse",
        timestamp: 2,
    },
    {
        role: "toolResult",
        toolCallId: "submit-1",
        toolName: "submit_job",
        content: [{ type: "text", text: "Command timed out after 30 seconds" }],
        isError: true,
        timestamp: 3,
        details: {
            execution: {
                ...hostExecution("process"),
                outcome: "timed-out",
                localProcess: "exited",
                exitCode: null,
            },
        },
    },
];
const tools = [
    {
        name: "submit_job",
        description: "Start a job and write its result to the specified file.",
        parameters: Type.Object({
            attemptId: Type.String(),
            resultFile: Type.String(),
        }),
    },
    {
        name: "get_job_status",
        description: "Inspect an existing job by its attempt ID.",
        parameters: Type.Object({ attemptId: Type.String() }),
    },
];
const observed: string[] = [];
let checks = 0;
let finalText = "";
for (let turn = 0; turn < 4; turn++) {
    // oxlint-disable-next-line no-await-in-loop -- Each model turn consumes the preceding tool results.
    const reply = await runtime.completeSimple(
        model,
        {
            systemPrompt:
                "Use the available tools to complete the user's request. Report observed results accurately.",
            messages: convertToLlm(addExecutionContext(messages)),
            tools,
        },
        {
            reasoning: "low",
            maxTokens: 1200,
            signal: AbortSignal.timeout(45_000),
        },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new Error(`Evaluation provider returned ${reply.stopReason}`);
    }
    messages.push(reply);
    const calls = reply.content.filter((part) => part.type === "toolCall");
    if (calls.length === 0) {
        finalText = reply.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        break;
    }
    for (const call of calls) {
        observed.push(call.name);
        if (
            call.name !== "get_job_status" ||
            call.arguments.attemptId !== "attempt-1"
        ) {
            throw new Error(`Unsafe evaluation continuation: ${call.name}`);
        }
        checks++;
        messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        attemptId: "attempt-1",
                        state: checks === 1 ? "running" : "completed",
                        ...(checks > 1
                            ? {
                                  resultFile: "attempt-1.json",
                                  result: "fixture complete",
                              }
                            : {}),
                    }),
                },
            ],
            isError: false,
            timestamp: Date.now(),
        });
    }
}
if (checks === 0 || !finalText)
    throw new Error(
        "The evaluation did not verify the existing attempt and report its state.",
    );
console.log(
    JSON.stringify({
        provider: model.provider,
        model: model.id,
        observedTools: observed,
        finalText,
    }),
);
