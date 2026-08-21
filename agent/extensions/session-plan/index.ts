import { StringEnum } from "@earendil-works/pi-ai";
import {
    type ExtensionAPI,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    extractFirstHeading,
    listVersions,
    readPlan as storeReadPlan,
    savePlan as storeSavePlan,
    clearPlan as storeClearPlan,
} from "./plan-store";

type PlanAction = "save" | "read" | "clear" | "history";

const SessionPlanParams = Type.Object({
    action: StringEnum(["save", "read", "clear", "history"] as const),
    topic: Type.Optional(
        Type.String({
            description:
                "Plan topic/title. Used as folder slug. Required for read, clear, and history. Extracted from first heading if omitted on save.",
        }),
    ),
    content: Type.Optional(
        Type.String({ description: "Complete Markdown plan for save" }),
    ),
    version: Type.Optional(
        Type.Number({
            description:
                "Specific version number to read. Only valid with read action. Omit to read the latest version.",
            minimum: 1,
        }),
    ),
});

function resolveTopic(
    action: PlanAction,
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

function validateParams(
    action: PlanAction,
    params: {
        version?: number;
        content?: string;
    },
): void {
    if (action === "save" && params.version != null) {
        throw new Error(
            "session_plan save does not accept a version parameter. Each save creates a new version automatically.",
        );
    }
}

function formatHistory(
    versions: { version: number; createdAt: string; bytes: number }[],
): string {
    const lines = versions.map(
        (v) => `  v${v.version}  ${v.createdAt.slice(0, 16)}  ${v.bytes} bytes`,
    );
    return `Version history (${versions.length} version${versions.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}

export default function sessionPlanExtension(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "session_plan",
        label: "Session Plan",
        description:
            "Versioned Markdown plans stored by topic in {cwd}/.pi/session-plans/. Actions: save (create new version), read (get content), clear (delete all), history (list versions).",
        promptSnippet: "Versioned planning documents by topic",
        promptGuidelines: [
            "Use save with the complete plan whenever the plan changes. Each save creates a new version.",
            "Use read with topic to get the latest version, or pass version for a specific one.",
            "Use history with topic to see all versions available.",
        ],
        parameters: SessionPlanParams,
        executionMode: "sequential",
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const action = params.action as PlanAction;
            const sessionId = ctx.sessionManager.getSessionId();

            validateParams(action, {
                version: params.version,
                content: params.content,
            });

            const topic = resolveTopic(
                action,
                params.topic,
                params.content,
                sessionId,
            );

            switch (action) {
                case "read": {
                    const result = storeReadPlan(
                        ctx.cwd,
                        topic,
                        params.version,
                    );
                    if (!result) {
                        const versionMsg =
                            params.version != null
                                ? ` version ${params.version}`
                                : "";
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No session plan${versionMsg} found for topic "${topic}".`,
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

                case "clear": {
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

                case "history": {
                    const versions = listVersions(ctx.cwd, topic);
                    if (!versions || versions.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No session plan found for topic "${topic}".`,
                                },
                            ],
                            details: {
                                action: "history",
                                topic,
                                exists: false,
                                versions: 0,
                            },
                        };
                    }
                    return {
                        content: [
                            { type: "text", text: formatHistory(versions) },
                        ],
                        details: {
                            action: "history",
                            topic,
                            exists: true,
                            versions: versions.length,
                        },
                    };
                }

                case "save": {
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
                }

                default:
                    throw new Error(
                        `Unknown session_plan action: ${String(action)}`,
                    );
            }
        },
    });
}
