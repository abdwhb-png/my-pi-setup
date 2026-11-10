import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import {
    buildSessionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { injectProviderToolsCatalog } from "../_shared/tool-policy/provider-catalog.ts";
import codexCompactionExtension from "./index.ts";
import {
    buildCodexHeaders,
    buildToolPayload,
    effectiveInputForBranch,
    modelKey,
    NATIVE_COMPACTION_KIND,
    NATIVE_COMPACTION_VERSION,
} from "./native-compaction.ts";

const model: Model<"openai-codex-responses"> = {
    api: "openai-codex-responses",
    id: "fixture",
    name: "Fixture",
    provider: "openai-codex",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
};

test("extension entrypoint registers Codex compaction without changing other providers", () => {
    const handlers = new Map<
        string,
        (
            event: { headers: Record<string, string | null> },
            ctx: { model: unknown },
        ) => void
    >();
    const pi = {
        registerEntryRenderer: () => {},
        on: (
            name: string,
            handler: (
                event: { headers: Record<string, string | null> },
                ctx: { model: unknown },
            ) => void,
        ) => {
            handlers.set(name, handler);
        },
    } as unknown as Parameters<typeof codexCompactionExtension>[0];
    codexCompactionExtension(pi);

    const beforeHeaders = handlers.get("before_provider_headers");
    expect(beforeHeaders).toBeDefined();
    const unrelated = { headers: {} as Record<string, string | null> };
    beforeHeaders!(unrelated, {
        model: { provider: "other", api: "openai-codex-responses" },
    });
    expect(unrelated.headers).toEqual({});
    const codex = { headers: {} as Record<string, string | null> };
    beforeHeaders!(codex, { model });
    expect(codex.headers["x-codex-beta-features"]).toContain(
        "remote_compaction_v2",
    );
});

function branchWithEdit(
    replacement: { content: string } | null,
): SessionEntry[] {
    const timestamp = "2026-09-23T00:00:00.000Z";
    return [
        {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp,
            message: { role: "user", content: "Keep", timestamp: 1 },
        },
        {
            type: "custom",
            id: "checkpoint",
            parentId: "u1",
            timestamp,
            customType: NATIVE_COMPACTION_KIND,
            data: {
                kind: NATIVE_COMPACTION_KIND,
                version: NATIVE_COMPACTION_VERSION,
                modelKey: modelKey(model),
                replacementHistory: [
                    { type: "compaction", encrypted_content: "fixture" },
                ],
            },
        },
        {
            type: "message",
            id: "u2",
            parentId: "checkpoint",
            timestamp,
            message: { role: "user", content: "Original", timestamp: 2 },
        },
        {
            type: "context_edit",
            id: "edit",
            parentId: "u2",
            timestamp,
            targetId: "u2",
            replacement,
        },
    ];
}

test("native checkpoint excludes a tail message omitted by context_edit", () => {
    const branch = branchWithEdit(null);
    expect(
        buildSessionContext(branch)
            .messages.filter((message) => message.role === "user")
            .map((message) => message.content),
    ).toEqual(["Keep"]);
    const input = effectiveInputForBranch({ branch, model });
    expect(input).toEqual([
        { type: "compaction", encrypted_content: "fixture" },
    ]);
});

test("Codex headers omit provider fields suppressed with null", () => {
    const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
    const headers = buildCodexHeaders({
        apiKey: token,
        headers: { "x-suppressed": null, "x-kept": "yes" },
        sessionId: "session",
    });
    expect(headers.has("x-suppressed")).toBe(false);
    expect(headers.get("x-kept")).toBe("yes");
});

test("native checkpoint uses the edited tail content", () => {
    const branch = branchWithEdit({ content: "Revised" });
    expect(
        buildSessionContext(branch)
            .messages.filter((message) => message.role === "user")
            .map((message) => message.content),
    ).toEqual(["Keep", "Revised"]);
    const input = effectiveInputForBranch({ branch, model });
    expect(input).toEqual([
        { type: "compaction", encrypted_content: "fixture" },
        { role: "user", content: [{ type: "input_text", text: "Revised" }] },
    ]);
});

function branchWithToolCall(name: unknown): SessionEntry[] {
    // Model a persisted session JSON boundary, including malformed historical data.
    return JSON.parse(
        JSON.stringify([
            {
                type: "message",
                id: "a1",
                parentId: null,
                timestamp: "2026-09-23T00:00:00.000Z",
                message: {
                    role: "assistant",
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    content: [
                        {
                            type: "toolCall",
                            id: "call_1|fc_1",
                            name,
                            arguments: { path: "fixture.txt" },
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
                    timestamp: 1,
                },
            },
        ]),
    );
}

test.each([undefined, null, {}, 42, "", " "])(
    "rejects a malformed persisted tool name: %j",
    (name) => {
        expect(() =>
            effectiveInputForBranch({
                branch: branchWithToolCall(name),
                model,
            }),
        ).toThrow("Tool call call_1|fc_1 has an invalid name.");
    },
);

test("preserves a valid tool call and its orphan result during compaction", () => {
    expect(
        effectiveInputForBranch({ branch: branchWithToolCall("read"), model }),
    ).toEqual([
        {
            type: "function_call",
            call_id: "call_1",
            id: "fc_1",
            name: "read",
            arguments: '{"path":"fixture.txt"}',
        },
        {
            type: "function_call_output",
            call_id: "call_1",
            output: "No result provided",
        },
    ]);
});

// A real compaction snapshots system declarations separately from its opaque history.
function checkpointWithTools(): SessionEntry[] {
    return [
        {
            type: "compaction",
            id: "checkpoint",
            parentId: null,
            timestamp: "2026-09-23T00:00:00.000Z",
            summary: "local marker",
            firstKeptEntryId: "checkpoint",
            tokensBefore: 100,
            details: {
                kind: NATIVE_COMPACTION_KIND,
                version: 1,
                modelKey: modelKey(model),
                replacementHistory: [
                    { type: "compaction", encrypted_content: "fixture" },
                ],
            },
            systemMessage: {
                role: "system",
                content: "Checkpoint instructions",
                timestamp: 1,
                toolsAdded: [
                    {
                        name: "read",
                        description: "Read",
                        parameters: Type.Object({}),
                    },
                    {
                        name: "codemode",
                        description: "Run JavaScript",
                        parameters: Type.Object({ code: Type.String() }),
                        constrainedSampling: {
                            type: "grammar",
                            variants: { openai_lark: "start: /.+/" },
                        },
                    },
                ],
            },
        },
    ];
}

const incrementalModel = {
    ...model,
    compat: {
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsMidConvoSystemMessages: true,
        supportsOpenAIGrammarTools: true,
    },
};

test("checkpoint replay preserves Pi tool declarations and grammar tools", () => {
    const branch = checkpointWithTools();
    const input = effectiveInputForBranch({ branch, model: incrementalModel });
    expect(input).toContainEqual({
        type: "compaction",
        encrypted_content: "fixture",
    });
    const catalog = injectProviderToolsCatalog(model.api, {
        input,
        tool_choice: "auto",
        instructions: "current",
    });
    expect(catalog.supported && catalog.tools.map((t) => t.name)).toEqual([
        "read",
        "codemode",
    ]);
    expect(JSON.stringify(input)).toContain('"type":"custom"');
});

test("checkpoint replay retains system updates and tool removals", () => {
    const branch = checkpointWithTools();
    branch.push({
        type: "message",
        id: "switch",
        parentId: "checkpoint",
        timestamp: "2026-09-23T00:00:01.000Z",
        message: {
            role: "system",
            content: "Role changed",
            timestamp: 2,
            toolsRemoved: [{ name: "read" }],
            toolsAdded: [
                {
                    name: "edit",
                    description: "Edit",
                    parameters: Type.Object({}),
                },
            ],
        },
    });
    const input = effectiveInputForBranch({ branch, model: incrementalModel });
    expect(JSON.stringify(input)).toContain("Role changed");
    expect(JSON.stringify(input)).toContain("no longer available");
    expect(JSON.stringify(input)).toContain('"name":"edit"');
});

test("legacy custom checkpoints retain the system tool state before the checkpoint", () => {
    const branch = branchWithEdit(null);
    branch.unshift({
        type: "message",
        id: "system",
        parentId: null,
        timestamp: branch[0].timestamp,
        message: {
            role: "system",
            content: "Legacy instructions",
            timestamp: 0,
            toolsAdded: [
                {
                    name: "read",
                    description: "Read",
                    parameters: Type.Object({}),
                },
            ],
        },
    });
    branch[1].parentId = "system";
    const input = effectiveInputForBranch({ branch, model: incrementalModel });
    expect(JSON.stringify(input)).toContain('"name":"read"');
});

test("compaction declares tools through the same transport as ordinary Codex requests", () => {
    const branch = checkpointWithTools();
    expect(buildToolPayload(branch, incrementalModel)).toBeUndefined();
    const legacyTransport = {
        ...model,
        compat: { supportsOpenAIGrammarTools: true },
    };
    const tools = buildToolPayload(branch, legacyTransport);
    expect(tools).toMatchObject([
        { type: "function", name: "read" },
        { type: "custom", name: "codemode" },
    ]);
});

test("replays grammar tool calls through the native custom-tool transport", () => {
    const branch = checkpointWithTools();
    const callEntry = branchWithToolCall("codemode")[0];
    if (callEntry.type !== "message" || callEntry.message.role !== "assistant")
        throw new Error("Invalid fixture");
    callEntry.parentId = "checkpoint";
    const call = callEntry.message.content[0];
    if (call.type !== "toolCall") throw new Error("Invalid call fixture");
    call.arguments = { code: "text(1)" };
    branch.push(callEntry);
    const input = effectiveInputForBranch({ branch, model: incrementalModel });
    expect(
        input.find((item) => item.type === "custom_tool_call"),
    ).toMatchObject({ call_id: "call_1", name: "codemode", input: "text(1)" });
});

test("historical group placeholders never become Codex function tools", () => {
    const branch = checkpointWithTools();
    const checkpoint = branch[0];
    if (checkpoint.type !== "compaction" || !checkpoint.systemMessage)
        throw new Error("Invalid checkpoint fixture");
    checkpoint.systemMessage.toolsAdded?.push({
        name: "@inspect",
        description: "Alias placeholder",
        parameters: Type.Object({}),
    });
    const original = JSON.stringify(branch);
    const input = effectiveInputForBranch({ branch, model: incrementalModel });
    expect(JSON.stringify(input)).not.toContain('"name":"@inspect"');
    expect(JSON.stringify(input)).toContain('"name":"read"');
    expect(JSON.stringify(buildToolPayload(branch, model))).not.toContain(
        '"name":"@inspect"',
    );
    expect(JSON.stringify(branch)).toBe(original);
});

test("invalid concrete tool names fail explicitly rather than being hidden", () => {
    const branch = checkpointWithTools();
    const checkpoint = branch[0];
    if (checkpoint.type !== "compaction" || !checkpoint.systemMessage)
        throw new Error("Invalid checkpoint fixture");
    checkpoint.systemMessage.toolsAdded?.push({
        name: "bad.name",
        description: "Invalid concrete tool",
        parameters: Type.Object({}),
    });
    expect(() =>
        effectiveInputForBranch({ branch, model: incrementalModel }),
    ).toThrow('Invalid Codex tool declaration name: "bad.name"');
});
