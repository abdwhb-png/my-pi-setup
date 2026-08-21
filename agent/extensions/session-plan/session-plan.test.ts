import { afterEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import sessionPlanExtension from "./index";

function makeContext(
    cwd: string,
    sessionDirectory: string,
    sessionId: string,
) {
    return {
        cwd,
        sessionManager: {
            getSessionDir: () => sessionDirectory,
            getSessionId: () => sessionId,
        },
    } as unknown as ExtensionContext;
}

function makeExtension() {
    let registeredTool: ToolDefinition | undefined;
    const pi = {
        registerTool(tool: ToolDefinition) {
            registeredTool = tool;
        },
        on() {},
    } as unknown as ExtensionAPI;
    sessionPlanExtension(pi);
    return registeredTool!;
}

function tmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    return dir;
}

describe("session_plan extension", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const d of dirs.splice(0)) {
            rmSync(d, { recursive: true, force: true });
        }
    });

    it("saves a versioned plan in CWD under .pi/session-plans", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "session-one");

        const result = await tool.execute(
            "c1",
            { action: "save", topic: "my plan", content: "# My plan\n\nDo things." },
            undefined, undefined, ctx,
        );

        const planDirs = readdirSync(join(cwd, ".pi", "session-plans"));
        expect(planDirs.length).toBe(1);
        expect(planDirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-my-plan$/);

        const planPath = join(cwd, ".pi", "session-plans", planDirs[0]);
        expect(existsSync(join(planPath, "manifest.json"))).toBe(true);
        expect(readFileSync(join(planPath, "v001.md"), "utf8")).toBe("# My plan\n\nDo things.\n");

        const manifest = JSON.parse(readFileSync(join(planPath, "manifest.json"), "utf8"));
        expect(manifest.latestVersion).toBe(1);
        expect(manifest.topic).toBe("my plan");
        expect(result.details).toMatchObject({ action: "save", exists: true, version: 1 });
    });

    it("creates v002.md on second save and updates manifest", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await tool.execute("s1", { action: "save", topic: "rev plan", content: "# Rev plan\n\nv1." }, undefined, undefined, ctx);
        const result = await tool.execute("s2", { action: "save", topic: "rev plan", content: "# Rev plan\n\nv2." }, undefined, undefined, ctx);

        const dirs2 = readdirSync(join(cwd, ".pi", "session-plans"));
        const planPath = join(cwd, ".pi", "session-plans", dirs2[0]);
        expect(existsSync(join(planPath, "v001.md"))).toBe(true);
        expect(existsSync(join(planPath, "v002.md"))).toBe(true);
        expect(readFileSync(join(planPath, "v002.md"), "utf8")).toBe("# Rev plan\n\nv2.\n");

        const manifest = JSON.parse(readFileSync(join(planPath, "manifest.json"), "utf8"));
        expect(manifest.latestVersion).toBe(2);
        expect(result.details).toMatchObject({ action: "save", exists: true, version: 2 });
    });

    it("read returns the latest version", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await tool.execute("s1", { action: "save", topic: "read plan", content: "# Read plan\n\nv1." }, undefined, undefined, ctx);
        await tool.execute("s2", { action: "save", topic: "read plan", content: "# Read plan\n\nv2." }, undefined, undefined, ctx);

        const result = await tool.execute("r1", { action: "read", topic: "read plan" }, undefined, undefined, ctx);
        expect(result.content).toEqual([{ type: "text", text: "# Read plan\n\nv2.\n" }]);
    });

    it("read with version returns specific version", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await tool.execute("s1", { action: "save", topic: "ver plan", content: "# Ver plan\n\nv1." }, undefined, undefined, ctx);
        await tool.execute("s2", { action: "save", topic: "ver plan", content: "# Ver plan\n\nv2." }, undefined, undefined, ctx);
        await tool.execute("s3", { action: "save", topic: "ver plan", content: "# Ver plan\n\nv3." }, undefined, undefined, ctx);

        const r1 = await tool.execute("rv1", { action: "read", topic: "ver plan", version: 1 }, undefined, undefined, ctx);
        expect(r1.content).toEqual([{ type: "text", text: "# Ver plan\n\nv1.\n" }]);

        const r3 = await tool.execute("rv3", { action: "read", topic: "ver plan", version: 3 }, undefined, undefined, ctx);
        expect(r3.content).toEqual([{ type: "text", text: "# Ver plan\n\nv3.\n" }]);
    });

    it("read with nonexistent version returns error message", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await tool.execute("s1", { action: "save", topic: "miss plan", content: "# Miss plan" }, undefined, undefined, ctx);

        const result = await tool.execute("rv99", { action: "read", topic: "miss plan", version: 99 }, undefined, undefined, ctx);
        expect(result.content).toEqual([
            { type: "text", text: 'No session plan version 99 found for topic "miss plan".' },
        ]);
    });

    it("clear removes all versions and manifest", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await tool.execute("s1", { action: "save", topic: "clear plan", content: "# Clear plan" }, undefined, undefined, ctx);
        await tool.execute("s2", { action: "save", topic: "clear plan", content: "# Clear plan v2" }, undefined, undefined, ctx);
        await tool.execute("c1", { action: "clear", topic: "clear plan" }, undefined, undefined, ctx);

        const planDirs = readdirSync(join(cwd, ".pi", "session-plans"));
        expect(planDirs.length).toBe(0);
    });

    it("history returns version list", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await tool.execute("s1", { action: "save", topic: "hist plan", content: "# Hist plan\n\nv1." }, undefined, undefined, ctx);
        await tool.execute("s2", { action: "save", topic: "hist plan", content: "# Hist plan\n\nv2." }, undefined, undefined, ctx);

        const result = await tool.execute("h1", { action: "history", topic: "hist plan" }, undefined, undefined, ctx);
        expect(result.content).toHaveLength(1);
        const text = (result.content as any[])[0].text as string;
        expect(text).toContain("v1");
        expect(text).toContain("v2");
        expect(text).toContain("2 version");
        expect(result.details).toMatchObject({ action: "history", exists: true, versions: 2 });
    });

    it("history without topic returns error", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await expect(
            tool.execute("h1", { action: "history" }, undefined, undefined, ctx),
        ).rejects.toThrow("topic");
    });

    it("save without topic extracts heading from content", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await tool.execute("s1", { action: "save", content: "# My Heading\n\nBody text." }, undefined, undefined, ctx);

        const planDirs = readdirSync(join(cwd, ".pi", "session-plans"));
        expect(planDirs.length).toBe(1);
        expect(planDirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-my-heading$/);
    });

    it("save without topic and without heading falls back to plan-{sessionId}", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "abc12345-def0");

        await tool.execute("s1", { action: "save", content: "No heading here." }, undefined, undefined, ctx);

        const planDirs = readdirSync(join(cwd, ".pi", "session-plans"));
        expect(planDirs.length).toBe(1);
        expect(planDirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-plan-abc12345$/);
    });

    it("read without topic returns error", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await expect(
            tool.execute("r1", { action: "read" }, undefined, undefined, ctx),
        ).rejects.toThrow("topic");
    });

    it("save with version param is rejected", async () => {
        const cwd = tmpDir("sp-cwd-");
        dirs.push(cwd);
        const sess = tmpDir("sp-sess-");
        dirs.push(sess);

        const tool = makeExtension();
        const ctx = makeContext(cwd, sess, "s1");

        await expect(
            tool.execute("bad", { action: "save", topic: "x", content: "# X", version: 1 }, undefined, undefined, ctx),
        ).rejects.toThrow("version");
    });

    it("is the only plan persistence tool configured for quick-planner", () => {
        const role = readFileSync(
            join(import.meta.dir, "..", "..", "roles", "quick-planner.md"),
            "utf8",
        );

        expect(role).toContain("session_plan");
        expect(role).not.toMatch(/tools:.*\bmemory\b(?!-)/);
        expect(role).not.toContain("#tool:vscode/memory");
        expect(role).not.toContain("/quick-plans/");
    });
});
