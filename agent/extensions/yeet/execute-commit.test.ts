import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { execCommand } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js";
import { useIsolatedAgentDir } from "../_shared/testing/config-fixture.ts";
import yeetExtension, { executeCommit } from "./index.ts";

useIsolatedAgentDir();

const roots: string[] = [];
let previousGlobalConfig: string | undefined;
let previousSystemConfig: string | undefined;

beforeEach(() => {
    previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    previousSystemConfig = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
});

afterEach(() => {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    if (previousSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = previousSystemConfig;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const realExec: ExtensionAPI["exec"] = (command, args, options) =>
    execCommand(command, args, options?.cwd ?? process.cwd(), options);

async function fixtureRepo() {
    const cwd = mkdtempSync(join(tmpdir(), "yeet-commit-test-"));
    roots.push(cwd);
    const git = async (args: string[]) => {
        const result = await realExec("git", args, { cwd, timeout: 5000 });
        expect(result.code, result.stderr).toBe(0);
        return result.stdout.trim();
    };
    await git(["init", "-q", "--initial-branch=main"]);
    await git(["config", "user.name", "Diagnostic"]);
    await git(["config", "user.email", "diagnostic@example.invalid"]);
    await git(["config", "commit.gpgsign", "false"]);
    const hooks = join(cwd, "empty-hooks");
    mkdirSync(hooks);
    await git(["config", "core.hooksPath", hooks]);
    writeFileSync(join(cwd, "tracked.txt"), "baseline\n");
    await git(["add", "tracked.txt"]);
    await git(["commit", "-qm", "baseline"]);
    const before = await git(["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "tracked.txt"), "changed\n");
    return { cwd, git, before, hooks };
}

describe("executeCommit with Pi's command executor", () => {
    it("reports an existing Git lock as failure and stops before committing", async () => {
        const { cwd, git, before } = await fixtureRepo();
        writeFileSync(join(cwd, ".git", "index.lock"), "");
        const operations: string[] = [];
        const exec: ExtensionAPI["exec"] = async (command, args, options) => {
            operations.push(args[0]!);
            return realExec(command, args, options);
        };

        const result = await executeCommit(exec, ["tracked.txt"], "test: changed", cwd);

        expect(result.success).toBe(false);
        if (!result.success) expect(result.stderr).toContain("index.lock");
        expect(result).toMatchObject({ operation: "git add", code: 128, killed: false });
        if (!result.success) expect(result.error).toContain(cwd);
        expect(operations).not.toContain("commit");
        expect(await git(["rev-parse", "HEAD"])).toBe(before);
        expect(await git(["diff", "--name-only"])).toBe("tracked.txt");
    });

    it("reports a rejected commit without reading the previous HEAD as success", async () => {
        const { cwd, git, before, hooks } = await fixtureRepo();
        writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nprintf 'fixture hook rejected commit\\n' >&2\nexit 1\n", { mode: 0o755 });

        const result = await executeCommit(realExec, ["tracked.txt"], "test: rejected", cwd);

        expect(result).toMatchObject({ success: false, operation: "git commit", code: 1, killed: false });
        if (!result.success) expect(result.stderr).toContain("fixture hook rejected commit");
        expect(await git(["rev-parse", "HEAD"])).toBe(before);
        expect(await git(["diff", "--cached", "--name-only"])).toBe("tracked.txt");
    });

    it("keeps stdout diagnostics when there is nothing to commit", async () => {
        const { cwd, git, before } = await fixtureRepo();
        writeFileSync(join(cwd, "tracked.txt"), "baseline\n");

        const result = await executeCommit(realExec, ["tracked.txt"], "test: empty", cwd);

        expect(result).toMatchObject({ success: false, operation: "git commit", code: 1 });
        if (!result.success) expect(result.stdout).toContain("nothing to commit");
        expect(await git(["rev-parse", "HEAD"])).toBe(before);
    });

    it("returns the SHA of the newly created commit on success", async () => {
        const { cwd, git, before } = await fixtureRepo();

        const result = await executeCommit(realExec, ["tracked.txt"], "test: changed", cwd);

        expect(result).toEqual({ success: true, sha: await git(["rev-parse", "--short", "HEAD"]), branch: "main" });
        expect(await git(["rev-parse", "HEAD"])).not.toBe(before);
        expect(await git(["show", "-s", "--format=%s", "HEAD"])).toBe("test: changed");
        expect(await git(["status", "--porcelain", "--untracked-files=no"])).toBe("");
    });

    it("reports the commit as created when a later metadata lookup fails", async () => {
        const { cwd, git, before } = await fixtureRepo();
        const exec: ExtensionAPI["exec"] = (command, args, options) =>
            args[0] === "rev-parse" && args[1] === "--short"
                ? Promise.resolve({ stdout: "", stderr: "fixture metadata unavailable", code: 128, killed: false })
                : realExec(command, args, options);

        const result = await executeCommit(exec, ["tracked.txt"], "test: metadata", cwd);

        expect(result).toMatchObject({ success: false, commitState: "created", code: 128 });
        expect(await git(["rev-parse", "HEAD"])).not.toBe(before);
        expect(await git(["show", "-s", "--format=%s", "HEAD"])).toBe("test: metadata");
    });

    it("reports an interrupted commit as uncertain even if Git returned code zero", async () => {
        const { cwd, git, before } = await fixtureRepo();
        const exec: ExtensionAPI["exec"] = async (command, args, options) => {
            const result = await realExec(command, args, options);
            return args[0] === "commit" ? { ...result, killed: true } : result;
        };

        const result = await executeCommit(exec, ["tracked.txt"], "test: interrupted", cwd);

        expect(result).toMatchObject({ success: false, commitState: "unknown", killed: true });
        expect(await git(["rev-parse", "HEAD"])).not.toBe(before);
    });

    it("does not report a commit as verified when the SHA lookup returns empty output", async () => {
        const { cwd, git } = await fixtureRepo();
        const exec: ExtensionAPI["exec"] = (command, args, options) =>
            args[0] === "rev-parse" && args[1] === "--short"
                ? Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false })
                : realExec(command, args, options);

        const result = await executeCommit(exec, ["tracked.txt"], "test: empty SHA", cwd);

        expect(result).toMatchObject({ success: false, commitState: "created" });
        expect(await git(["show", "-s", "--format=%s", "HEAD"])).toBe("test: empty SHA");
    });

    it("retains the verified SHA if branch lookup fails after the commit", async () => {
        const { cwd, git } = await fixtureRepo();
        const exec: ExtensionAPI["exec"] = (command, args, options) =>
            args[0] === "rev-parse" && args[1] === "--abbrev-ref"
                ? Promise.resolve({ stdout: "", stderr: "fixture branch unavailable", code: 128, killed: false })
                : realExec(command, args, options);

        const result = await executeCommit(exec, ["tracked.txt"], "test: branch", cwd);

        expect(result).toMatchObject({ success: false, commitState: "created", sha: await git(["rev-parse", "--short", "HEAD"]) });
    });

    it("stops an interrupted staging operation without treating the commit as uncertain", async () => {
        const { cwd, git, before } = await fixtureRepo();
        const operations: string[] = [];
        const exec: ExtensionAPI["exec"] = async (command, args, options) => {
            operations.push(args[0]!);
            const result = await realExec(command, args, options);
            return args[0] === "add" ? { ...result, killed: true } : result;
        };

        const result = await executeCommit(exec, ["tracked.txt"], "test: interrupted stage", cwd);

        expect(result).toMatchObject({ success: false, commitState: "not-created", killed: true });
        expect(operations).not.toContain("commit");
        expect(await git(["rev-parse", "HEAD"])).toBe(before);
    });

    it("bounds both stdout and stderr diagnostics without discarding them", async () => {
        const { cwd } = await fixtureRepo();
        const stdout = "fixture stdout " + "x".repeat(10_000);
        const stderr = "fixture stderr " + "y".repeat(10_000);
        const exec: ExtensionAPI["exec"] = (command, args, options) =>
            args[0] === "add"
                ? Promise.resolve({ stdout, stderr, code: 128, killed: false })
                : realExec(command, args, options);

        const result = await executeCommit(exec, ["tracked.txt"], "test: bounded", cwd);

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.stdout).toContain("fixture stdout");
            expect(result.stderr).toContain("fixture stderr");
            expect(result.stdout!.length).toBeLessThanOrEqual(2000);
            expect(result.stderr!.length).toBeLessThanOrEqual(2000);
        }
    });
});

async function commitThroughPi(cwd: string, exec?: ExtensionAPI["exec"]) {
    const params = { cwd, plan_summary: "Fixture change", files: ["tracked.txt"], commit_message: "test: pipeline" };
    const session = await createTestSession({
        cwd,
        extensionFactories: [(pi: ExtensionAPI) => {
            if (exec) pi.exec = exec;
            yeetExtension(pi);
        }],
    });
    try {
        const ui = session.session.extensionRunner.createContext().ui;
        session.session.extensionRunner.setUIContext({
            ...ui,
            // The harness does not provide mockUI.custom; replace only the approval UI.
            custom: async <T>() => ({ ...params, accepted: true, cancelled: false }) as T,
        }, "tui");
        await session.run(when("Commit fixture", [calls("propose_commit_plan", params), says("done")]));
        const results = session.events.toolResultsFor("propose_commit_plan");
        expect(results).toHaveLength(1);
        return results[0]!;
    } finally {
        session.dispose();
    }
}

describe("propose_commit_plan through Pi's execution pipeline", () => {
    it("reports the newly created SHA after a successful commit", async () => {
        const { cwd, git, before } = await fixtureRepo();

        const result = await commitThroughPi(cwd);

        expect(result.mocked).toBe(false);
        expect(result.text).toContain("Commit successful");
        expect(result.details).toMatchObject({ sha: await git(["rev-parse", "--short", "HEAD"]), branch: "main" });
        expect(await git(["rev-parse", "HEAD"])).not.toBe(before);
        expect(await git(["show", "-s", "--format=%s", "HEAD"])).toBe("test: pipeline");
    }, 30_000);

    it("reports a staging failure with diagnostics instead of commit success", async () => {
        const { cwd, git, before } = await fixtureRepo();
        writeFileSync(join(cwd, ".git", "index.lock"), "");

        const result = await commitThroughPi(cwd);

        expect(result.mocked).toBe(false);
        expect(result.text).not.toContain("Commit successful");
        expect(result.text).toContain("index.lock");
        expect(result.text).toContain(cwd);
        expect(result.details).toMatchObject({ accepted: true, commitState: "not-created", commitOperation: "git add", commitExitCode: 128 });
        expect(await git(["rev-parse", "HEAD"])).toBe(before);
    }, 30_000);

    it("reports a completed commit with a verification warning instead of commit failure", async () => {
        const { cwd, git } = await fixtureRepo();
        const exec: ExtensionAPI["exec"] = (command, args, options) =>
            args[0] === "rev-parse" && args[1] === "--short"
                ? Promise.resolve({ stdout: "", stderr: "fixture metadata unavailable", code: 128, killed: false })
                : realExec(command, args, options);

        const result = await commitThroughPi(cwd, exec);

        expect(result.mocked).toBe(false);
        expect(result.text).not.toContain("Commit FAILED");
        expect(result.text).not.toContain("Commit successful");
        expect(result.text).toContain("verification failed");
        expect(result.text).toContain("Do not automatically retry");
        expect(result.details).toMatchObject({ commitState: "created", commitExitCode: 128 });
        expect(await git(["show", "-s", "--format=%s", "HEAD"])).toBe("test: pipeline");
    }, 30_000);

    it("reports an interrupted commit as unknown and warns against automatic retry", async () => {
        const { cwd, git } = await fixtureRepo();
        const exec: ExtensionAPI["exec"] = async (command, args, options) => {
            const result = await realExec(command, args, options);
            return args[0] === "commit" ? { ...result, killed: true } : result;
        };

        const result = await commitThroughPi(cwd, exec);

        expect(result.text).not.toContain("Commit FAILED");
        expect(result.text).not.toContain("Commit successful");
        expect(result.text).toContain("UNKNOWN");
        expect(result.text).toContain("Do not automatically retry");
        expect(result.details).toMatchObject({ commitState: "unknown", commitKilled: true });
        expect(await git(["show", "-s", "--format=%s", "HEAD"])).toBe("test: pipeline");
    }, 30_000);
});
