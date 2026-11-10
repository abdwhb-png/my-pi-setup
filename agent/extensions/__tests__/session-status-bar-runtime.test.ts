import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    FANCY_FOOTER_DISCOVER_WIDGETS_EVENT,
    type FancyFooterWidgetContribution,
} from "pi-fancy-footer/api";
import { useIsolatedAgentDir } from "../_shared/testing/config-fixture.ts";

const agentDir = useIsolatedAgentDir();
let session: TestSession | undefined;
let bus: ExtensionAPI["events"];

beforeEach(async () => {
    const project = join(agentDir(), "workspace", "project-anchor");
    const cwd = join(project, "packages", "leaf-folder");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(project, "parallel"));
    writeFileSync(join(project, "package.json"), "{}");
    mkdirSync(join(agentDir(), "config"));
    writeFileSync(
        join(agentDir(), "config", "session-status-bar.json"),
        JSON.stringify({
            showBranch: false,
            refreshMs: 60_000,
        }),
    );
    session = await createTestSession({
        cwd,
        extensions: [join(import.meta.dir, "..", "session-status-bar.ts")],
        extensionFactories: [
            (pi: ExtensionAPI) => {
                bus = pi.events;
            },
        ],
    });
});

afterEach(async () => {
    await session?.close();
    session = undefined;
});

function current() {
    if (!session) throw new Error("Missing test session");
    return session;
}

function widget(segment: string) {
    const found: FancyFooterWidgetContribution[] = [];
    bus.emit(FANCY_FOOTER_DISCOVER_WIDGETS_EVENT, {
        registerWidget: (item: FancyFooterWidgetContribution) => {
            if (item.id === `session-status-bar.${segment}`) found.push(item);
        },
    });
    expect(found).toHaveLength(1);
    return found[0]!;
}

function render(segment: string, width = 100) {
    const definition = widget(segment);
    const theme = current().session.extensionRunner!.getUIContext().theme;
    const context = { theme, width } as Parameters<typeof definition.render>[0];
    return String(definition.render(context, width) ?? "");
}

const persisted = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("session label follows the first persisted user text, explicit rename, and clear without a timer tick", async () => {
    const t = current();
    expect(render("session")).toContain("(no messages)");
    await t.run(when("First recognizable user message", [says("Done")]));
    await persisted();
    expect(render("session")).toContain("First recognizable user message");
    t.session.setSessionName("Explicit session title");
    await persisted();
    expect(render("session")).toContain("Explicit session title");
    t.session.setSessionName("");
    await persisted();
    expect(render("session")).toContain("First recognizable user message");
});

test("CWD abbreviates parents uniquely, keeps project anchors and the last directory, and uses allocated width", () => {
    const rendered = render("cwd", 39);
    expect(rendered).toStartWith("📁 ");
    expect(rendered).toContain("project-anchor/pac/leaf-folder");
    expect(visibleWidth(rendered)).toBeLessThanOrEqual(39);
    expect(widget("cwd").grow).toBe(true);
    expect(widget("session").grow).toBe(true);
});

test("resume restores the first nonempty user text across text blocks using public session entries", async () => {
    const t = current();
    t.session.sessionManager.appendMessage({
        role: "user",
        content: [],
        timestamp: 1,
    });
    t.session.sessionManager.appendMessage({
        role: "user",
        content: [
            { type: "text", text: "First block" },
            { type: "text", text: "second block" },
        ],
        timestamp: 2,
    });
    await t.session.extensionRunner!.emit({
        type: "session_start",
        reason: "resume",
    });
    expect(render("session")).toContain("First block second block");
});
