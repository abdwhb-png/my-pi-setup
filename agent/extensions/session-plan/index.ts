import { StringEnum } from "@earendil-works/pi-ai";
import {
    type ExtensionAPI,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    extractFirstHeading,
    readPlan as storeReadPlan,
    savePlan as storeSavePlan,
    clearPlan as storeClearPlan,
} from "./plan-store";

const SessionPlanParams = Type.Object({
    action: StringEnum(["save", "read", "clear"] as const),
    topic: Type.Optional(
        Type.String({
            description:
                "Plan topic/title. Used as folder slug. Required for read and clear. Extracted from first heading if omitted on save.",
        }),
    ),
    content: Type.Optional(
        Type.String({ description: "Complete Markdown plan for save" }),
    ),
});

function resolveTopic(
    action: string,
    explicitTopic: string | undefined,
    content: string | undefined,
    sessionId: string,
): string {
    if (explicitTopic) return explicitTopic;
    if (action === "save" && content) {
        const heading = extractFirstHeading(content);
        if (heading) return heading;
    }
    if (action === "save") {
        return `plan-${sessionId.slice(0, 8)}`;
    }
    throw new Error(`session_plan ${action} requires a topic parameter.`);
}

export default function sessionPlanExtension(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "session_plan",
        label: "Session Plan",
        description:
            "Save, read, or clear versioned Markdown plans. Plans are stored by topic in {cwd}/.pi/session-plans/.",
        promptSnippet: "Persist versioned planning documents by topic",
        promptGuidelines: [
            "Use save with the complete plan whenever the plan changes. Each save creates a new version.",
            "Pass topic to read or clear a specific plan.",
        ],
        parameters: SessionPlanParams,
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const sessionId = ctx.sessionManager.getSessionId();
            const topic = resolveTopic(
                params.action,
                params.topic,
                params.content,
                sessionId,
            );

            if (params.action === "read") {
                const result = storeReadPlan(ctx.cwd, topic);
                if (!result) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No session plan found for topic "${topic}".`,
                            },
                        ],
                        details: {
                            action: "read",
                            topic,
                            exists: false,
                            bytes: 0,
                        },
                    };
                }
                return {
                    content: [{ type: "text", text: result.content }],
                    details: {
                        action: "read",
                        topic,
                        exists: true,
                        version: result.version,
                        bytes: Buffer.byteLength(result.content, "utf8"),
                    },
                };
            }

            if (params.action === "clear") {
                const existed = storeClearPlan(ctx.cwd, topic);
                return {
                    content: [
                        {
                            type: "text",
                            text: existed
                                ? `Cleared session plan "${topic}".`
                                : `No session plan found for topic "${topic}".`,
                        },
                    ],
                    details: {
                        action: "clear",
                        topic,
                        existed,
                    },
                };
            }

            // save
            if (!params.content?.trim()) {
                throw new Error(
                    "session_plan save requires non-empty Markdown content.",
                );
            }

            const saveResult = await withFileMutationQueue(
                `${ctx.cwd}/.pi/session-plans`,
                () =>
                    Promise.resolve(
                        storeSavePlan(
                            ctx.cwd,
                            topic,
                            params.content!,
                            sessionId,
                        ),
                    ),
            );

            return {
                content: [
                    {
                        type: "text",
                        text: `Saved session plan "${topic}" v${saveResult.version} to ${saveResult.path}`,
                    },
                ],
                details: {
                    action: "save",
                    topic,
                    exists: true,
                    version: saveResult.version,
                    bytes: saveResult.bytes,
                },
            };
        },
    });
}
