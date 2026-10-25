import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestSession, when, says, calls } from "@abdwhb-png/pi-test-harness";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { ProjectTrustStore, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isolateSkillHome } from "../../_shared/testing/skill-home.ts";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

const packageRoot = process.env.PI_BROWSER_TOOLS_PACKAGE_ROOT;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function isolatedAgentRoot(): Promise<string> {
    const previous = process.env.PI_CODING_AGENT_DIR;
    cleanup.push(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const root = mkdtempSync(join(tmpdir(), "browser-tools-runtime-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    await isolateSkillHome(root, cleanup);
    process.env.PI_CODING_AGENT_DIR = root;
    return root;
}

test.skipIf(!packageRoot).each([false, true])(
    "native browser tools and their normal skill follow the session grant in either extension order: %s",
    async (reverse) => {
        const root = await isolatedAgentRoot();
        const nativeConfig = join(root, ".pi/config/pi-agent-browser-native");
        mkdirSync(nativeConfig, { recursive: true });
        writeFileSync(join(nativeConfig, "config.json"), JSON.stringify({ version: 1, webSearch: { braveApiKey: "test-only-no-search-call" } }));
        new ProjectTrustStore(root).set(root, true);
        const unrelated = join(root, "skills/unrelated");
        mkdirSync(unrelated, { recursive: true });
        writeFileSync(join(unrelated, "SKILL.md"), "---\nname: unrelated\ndescription: Unrelated fixture skill\n---\nFixture instructions\n");
        const browser = publicExtensionEntrypoint("browser-tools");
        const native = resolve(packageRoot!, "dist/extensions/agent-browser/index.js");
        const extensions = [publicExtensionEntrypoint("tool-groups"), ...(reverse ? [browser, native] : [native, browser])];
        const session = await createTestSession({ cwd: root, extensions });
        cleanup.push(() => session.close());
        const family = session.session.getAllTools().filter(tool => tool.namespace?.name === "browser").map(tool => tool.name);
        expect(family.length).toBeGreaterThan(5);
        expect(family).toContain("agent_browser_web_search");
        expect(session.session.resourceLoader.getSkills().skills.find(skill => skill.name === "pi-browser-tool")?.filePath).toBe(resolve(packageRoot!, "resources/skills/pi-browser-tool/SKILL.md"));
        expect(session.session.getActiveToolNames().filter(name => family.includes(name))).toEqual([]);
        await session.run(when("Inspect repository files.", [says("done")]));
        expect(getCurrentSystemPrompt(session.session.messages)).not.toContain("<name>pi-browser-tool</name>");
        expect(getCurrentSystemPrompt(session.session.messages)).toContain("<name>unrelated</name>");
        await session.session.prompt("/browser-tools on");
        expect(session.session.getActiveToolNames()).toEqual(expect.arrayContaining(family));
        await session.run(when("Check the web page.", [says("done")]));
        expect(getCurrentSystemPrompt(session.session.messages)).toContain("<name>pi-browser-tool</name>");
        expect(getCurrentSystemPrompt(session.session.messages)).not.toContain("## Operating guidance");
        await session.session.reload();
        expect(session.session.getActiveToolNames()).toEqual(expect.arrayContaining(family));
        await session.session.prompt("/browser-tools off");
        await session.run(when("Inspect repository files again.", [says("done")]));
        expect(session.session.getActiveToolNames().filter(name => family.includes(name))).toEqual([]);
        expect(getCurrentSystemPrompt(session.session.messages)).not.toContain("<name>pi-browser-tool</name>");
        expect(getCurrentSystemPrompt(session.session.messages)).toContain("<name>unrelated</name>");
        await session.run(when("/skill:pi-browser-tool inspect", [says("done")]));
        expect(JSON.stringify(session.session.messages.findLast(message => message.role === "user"))).toContain("## Operating guidance");
    },
    30_000,
);

test.skipIf(!packageRoot)("project defaults activate the native family and preserve an explicit off across reload", async () => {
    const root = await isolatedAgentRoot();
    mkdirSync(join(root, ".pi/config"), { recursive: true });
    writeFileSync(join(root, ".pi/config/browser-tools.json"), '{"enabledByDefault":true}');
    new ProjectTrustStore(root).set(root, true);
    const session = await createTestSession({ cwd: root, extensions: [publicExtensionEntrypoint("tool-groups"), resolve(packageRoot!, "dist/extensions/agent-browser/index.js"), publicExtensionEntrypoint("browser-tools")] });
    cleanup.push(() => session.close());
    expect(session.session.getActiveToolNames()).toContain("agent_browser_qa");
    await session.session.prompt("/browser-tools off");
    await session.session.reload();
    expect(session.session.getActiveToolNames()).not.toContain("agent_browser");
    expect(session.session.getActiveToolNames()).not.toContain("agent_browser_code");
});


test.skipIf(!packageRoot)("the execution gate blocks a browser schema restored outside the coordinator", async () => {
    const root = await isolatedAgentRoot();
    const session = await createTestSession({
        cwd: root,
        extensions: [publicExtensionEntrypoint("tool-groups"), resolve(packageRoot!, "dist/extensions/agent-browser/index.js"), publicExtensionEntrypoint("browser-tools")],
        extensionFactories: [(pi: ExtensionAPI) => {
            pi.on("agent_start", () => pi.setActiveTools([...pi.getActiveTools(), "agent_browser"]));
        }],
        propagateErrors: false,
    });
    cleanup.push(() => session.close());
    await session.run(when("Inspect stale browser availability.", [calls("agent_browser", { args: ["--version"] }), says("done")]));
    expect(session.events.blockedCalls().some(call => call.toolName === "agent_browser")).toBe(true);
    expect(session.events.toolResultsFor("agent_browser").at(-1)).toMatchObject({ isError: true, text: expect.stringContaining("browser-tools") });
});
