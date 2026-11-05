import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
    readFileSync,
    chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createTestSession,
    calls,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import {
    createAssistantMessageEventStream,
    type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";

let current: TestSession | undefined;
let directory: string | undefined;
let previousAgentDir: string | undefined;
afterEach(async () => {
    if (current) {
        const runner = current.session.extensionRunner!;
        await runner
            .getCommand("slow-mode")!
            .handler("off", runner.createCommandContext());
        await current.close();
    }
    current = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
});
async function fixture(automatic = false, tools?: Record<string, boolean>) {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    directory = mkdtempSync(join(tmpdir(), "slow-mode-contract-"));
    process.env.PI_CODING_AGENT_DIR = directory;
    if (tools) {
        mkdirSync(join(directory, "config"));
        writeFileSync(
            join(directory, "config/slow-mode.json"),
            JSON.stringify(tools),
        );
    }
    current = await createTestSession({
        cwd: directory,
        extensions: [fileURLToPath(new URL("./index.ts", import.meta.url))],
        propagateErrors: false,
    });
    const runner = current.session.extensionRunner!;
    const reviews: Array<{ component: Component; text: string }> = [];
    runner.setUIContext(
        {
            ...runner.getUIContext(),
            custom: async (factory) =>
                new Promise((resolve, reject) => {
                    Promise.resolve(
                        factory(
                            { requestRender() {} } as never,
                            {
                                fg: (_role: string, text: string) => text,
                                bg: (_role: string, text: string) => text,
                                bold: (text: string) => text,
                            } as never,
                            {} as never,
                            resolve,
                        ),
                    )
                        .then((component) => {
                            reviews.push({
                                component,
                                text: component.render(180).join("\n"),
                            });
                            if (automatic) component.handleInput?.("y");
                        })
                        .catch(reject);
                }),
        },
        "tui",
    );
    const mode = (value: string) =>
        runner
            .getCommand("slow-mode")!
            .handler(value, runner.createCommandContext());
    await mode("on");
    return { t: current, root: directory, reviews, mode };
}
async function until(predicate: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error("Slow-mode contract timed out");
}
function batch(
    t: TestSession,
    writes = [
        { path: "a.txt", content: "a" },
        { path: "b.txt", content: "b" },
    ],
) {
    let round = 0;
    t.session.agent.streamFunction = () => {
        const content: AssistantMessage["content"] =
            round++ === 0
                ? writes.map((arguments_, index) => ({
                      type: "toolCall",
                      id: `write-${index}`,
                      name: "write",
                      arguments: arguments_,
                  }))
                : [{ type: "text", text: "Finished." }];
        const message: AssistantMessage = {
            role: "assistant",
            content,
            api: "openai-responses",
            provider: "test",
            model: "fixture",
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
            stopReason: round === 1 ? "toolUse" : "stop",
            timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() =>
            stream.push({
                type: "done",
                reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
                message,
            }),
        );
        return stream;
    };
    return t.session.prompt("Write two fixture files.");
}

test("one write requires exactly one content approval", async () => {
    const f = await fixture(true);
    await f.t.run(
        when("Write fixture", [
            calls("write", { path: "one.txt", content: "fixture" }),
            says("Finished."),
        ]),
    );
    expect(f.reviews).toHaveLength(1);
    expect(f.reviews[0]!.text).toContain("NEW FILE");
    expect(readFileSync(join(f.root, "one.txt"), "utf8")).toBe("fixture");
});

test("parallel writes have accessible successive reviews", async () => {
    const f = await fixture();
    const running = batch(f.t);
    try {
        await until(() => f.reviews.length > 0);
        await Bun.sleep(20);
        expect(f.reviews).toHaveLength(1);
        f.reviews[0]!.component.handleInput?.("n");
        await until(() => f.reviews.length === 2);
        f.reviews[1]!.component.handleInput?.("y");
        await running;
        expect(existsSync(join(f.root, "a.txt"))).toBe(false);
        expect(readFileSync(join(f.root, "b.txt"), "utf8")).toBe("b");
    } finally {
        for (const review of f.reviews) review.component.handleInput?.("n");
        await f.mode("off");
        await running;
    }
});

test.each(["off", "abort"])(
    "%s rejects active and queued writes without waiting for another key",
    async (action) => {
        const f = await fixture();
        const running = batch(f.t);
        let settled = false;
        void running.finally(() => {
            settled = true;
        });
        try {
            await until(() => f.reviews.length > 0);
            const cancellation =
                action === "off" ? f.mode("off") : f.t.session.abort();
            await until(() => settled);
            await cancellation;
            expect(existsSync(join(f.root, "a.txt"))).toBe(false);
            expect(existsSync(join(f.root, "b.txt"))).toBe(false);
            f.reviews[0]!.component.handleInput?.("y");
            expect(existsSync(join(f.root, "a.txt"))).toBe(false);
        } finally {
            for (const review of f.reviews) review.component.handleInput?.("n");
            await running;
        }
    },
);

test("edit refuses a changed file instead of overwriting it after external review", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "edit.txt"), "before\n");
    const running = f.t.run(
        when("Edit fixture", [
            calls("edit", {
                path: "edit.txt",
                edits: [{ oldText: "before", newText: "after" }],
            }),
            says("Finished."),
        ]),
    );
    try {
        await until(() => f.reviews.length > 0);
        writeFileSync(join(f.root, "edit.txt"), "concurrent\n");
        f.reviews[0]!.component.handleInput?.("y");
        await running;
        expect(readFileSync(join(f.root, "edit.txt"), "utf8")).toBe(
            "concurrent\n",
        );
        expect(f.t.events.toolResults[0]!.isError).toBe(true);
    } finally {
        for (const review of f.reviews) review.component.handleInput?.("n");
        await running;
    }
});

test("concurrent writes to one file review and apply each distinct proposal in order", async () => {
    const f = await fixture();
    const running = batch(f.t, [
        { path: "same.txt", content: "first proposal" },
        { path: "same.txt", content: "second proposal" },
    ]);
    try {
        await until(() => f.reviews.length === 1);
        expect(f.reviews[0]!.text).toContain("first proposal");
        f.reviews[0]!.component.handleInput?.("y");
        await until(() => f.reviews.length === 2);
        expect(readFileSync(join(f.root, "same.txt"), "utf8")).toBe(
            "first proposal",
        );
        expect(f.reviews[1]!.text).toContain("second proposal");
        f.reviews[1]!.component.handleInput?.("y");
        await running;
        expect(readFileSync(join(f.root, "same.txt"), "utf8")).toBe(
            "second proposal",
        );
    } finally {
        await f.mode("off");
        await running;
    }
});

test("aborting a generic review blocks the underlying command", async () => {
    const f = await fixture();
    const running = f.t.run(
        when("Review a shell command", [
            calls("bash", { command: "touch should-not-exist.txt" }),
            says("Finished."),
        ]),
    );
    try {
        await until(() => f.reviews.length === 1);
        await f.t.session.abort();
        await running;
        expect(f.t.events.toolResults[0]!.isError).toBe(true);
        expect(existsSync(join(f.root, "should-not-exist.txt"))).toBe(false);
    } finally {
        await f.mode("off");
        await running;
    }
});

test("external multi-edit review rejects concurrent file changes and removes its staged files", async () => {
    const previousVisual = process.env.VISUAL;
    const f = await fixture();
    let running: Promise<void> | undefined;
    try {
        const editor = join(f.root, "fixture-editor");
        const stageLog = join(f.root, "stage-path.txt");
        writeFileSync(
            editor,
            '#!/usr/bin/env bun\nawait Bun.write(process.argv[2], "reviewed content\\n");\nawait Bun.write(' +
                JSON.stringify(stageLog) +
                ", process.argv[2]);\n",
        );
        chmodSync(editor, 0o700);
        process.env.VISUAL = editor;
        writeFileSync(join(f.root, "edit.txt"), "first\nsecond\n");
        running = f.t.run(
            when("Edit two parts", [
                calls("edit", {
                    path: "edit.txt",
                    edits: [
                        { oldText: "first", newText: "changed first" },
                        { oldText: "second", newText: "changed second" },
                    ],
                }),
                says("Finished."),
            ]),
        );
        await until(() => f.reviews.length === 1);
        // Legacy Ctrl+E terminal encoding selects the external editor.
        f.reviews[0]!.component.handleInput?.("\x05");
        await until(() => f.reviews.length === 2);
        const staged = readFileSync(stageLog, "utf8");
        expect(existsSync(staged)).toBe(true);
        writeFileSync(join(f.root, "edit.txt"), "concurrent content\n");
        f.reviews[1]!.component.handleInput?.("y");
        await running;
        expect(readFileSync(join(f.root, "edit.txt"), "utf8")).toBe(
            "concurrent content\n",
        );
        expect(f.t.events.toolResults[0]!.isError).toBe(true);
        expect(existsSync(staged)).toBe(false);
    } finally {
        if (previousVisual === undefined) delete process.env.VISUAL;
        else process.env.VISUAL = previousVisual;
        await f.mode("off");
        await running;
    }
});

test.each([
    { tool: "read", decision: undefined },
    {
        tool: "bash",
        decision: "edit",
    },
])(
    "an unsupported review decision cannot approve $tool",
    async ({ tool, decision }) => {
        const f = await fixture(false, { read: true });
        writeFileSync(join(f.root, "read.txt"), "fixture");
        const runner = f.t.session.extensionRunner!;
        runner.setUIContext(
            { ...runner.getUIContext(), custom: async () => decision as never },
            "tui",
        );
        const input: Record<string, string> = tool === "read"
            ? { path: "read.txt" }
            : { command: "touch should-not-exist.txt" };
        await f.t.run(
            when("Review fixture tool", [
                calls(tool, input),
                says("Finished."),
            ]),
        );
        expect(f.t.events.toolResults[0]!.isError).toBe(true);
        expect(existsSync(join(f.root, "should-not-exist.txt"))).toBe(false);
    },
);

test("a failed review is reported and does not strand the next write", async () => {
    const f = await fixture(true);
    const runner = f.t.session.extensionRunner!;
    const ui = runner.getUIContext();
    let first = true;
    runner.setUIContext(
        {
            ...ui,
            custom: (factory, options) => {
                if (first) {
                    first = false;
                    throw new Error("Fixture UI failure");
                }
                return ui.custom(factory, options);
            },
        },
        "tui",
    );
    await f.t.run(
        when("Write fixtures", [
            calls("write", { path: "failed.txt", content: "first" }),
            calls("write", { path: "next.txt", content: "second" }),
            says("Finished."),
        ]),
    );
    expect(f.t.events.toolResults[0]!.isError).toBe(true);
    expect(existsSync(join(f.root, "failed.txt"))).toBe(false);
    expect(readFileSync(join(f.root, "next.txt"), "utf8")).toBe("second");
});


test("external multi-edit preserves exactly one UTF-8 BOM", async () => {
    const previousVisual = process.env.VISUAL;
    const f = await fixture();
    let running: Promise<void> | undefined;
    try {
        const editor = join(f.root, "fixture-editor");
        writeFileSync(editor, "#!/usr/bin/env bun\nimport {appendFileSync} from 'node:fs';appendFileSync(process.argv[2], 'approved extra\\n');\n");
        chmodSync(editor, 0o700);
        process.env.VISUAL = editor;
        writeFileSync(join(f.root, "edit.txt"), "\uFEFFfirst\nsecond\n");
        running = f.t.run(when("Edit fixture", [calls("edit", {
            path: "edit.txt", edits: [{ oldText: "first", newText: "changed first" }, { oldText: "second", newText: "changed second" }],
        }), says("Finished.")]));
        await until(() => f.reviews.length === 1);
        // Legacy Ctrl+E opens the external editor.
        f.reviews[0]!.component.handleInput?.("\x05");
        await until(() => f.reviews.length === 2);
        f.reviews[1]!.component.handleInput?.("y");
        await running;
        expect(f.t.events.toolResults[0]!.isError).toBe(false);
        expect(readFileSync(join(f.root, "edit.txt"), "utf8")).toBe("\uFEFFchanged first\nchanged second\napproved extra\n");
    } finally {
        if (previousVisual === undefined) delete process.env.VISUAL;
        else process.env.VISUAL = previousVisual;
        await f.mode("off");
        await running;
    }
});

test("a failed generic review blocks execution and preserves a redacted diagnostic", async () => {
    const f = await fixture(false, { read: true });
    const runner = f.t.session.extensionRunner!;
    runner.setUIContext({ ...runner.getUIContext(), custom: async () => { throw new Error("review-ui-probe-failure Bearer fixture-secret"); } }, "tui");
    await f.t.run(when("Read fixture", [calls("read", { path: "unread.txt" }), says("Finished.")]));
    const result = f.t.events.toolResults[0]!;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("review-ui-probe-failure");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
});
