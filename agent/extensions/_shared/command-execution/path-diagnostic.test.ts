import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { createBashOperations, type CreateBashOperationsOptions } from "./exec.ts";
import { createAdmittedSandboxExecutionContext, type SandboxExecutionContext } from "../sandbox-runtime/execution-context.ts";

const missing = "/__pi_unexposed_project__/frontend";
const errorLine = `bash: line 1: cd: ${missing}: No such file or directory\n`;

function admitted() {
    return createAdmittedSandboxExecutionContext({ sha256: "c".repeat(64), report: {
        schema: 1,
        runtime: { target: "x86_64-unknown-linux-gnu", version: "test", manifestSha256: "a".repeat(64), component: "shell" },
        helperSha256: "b".repeat(64), kernelMounts: [],
        mounts: [{ source: "/workspace", destination: "/workspace", access: "rw", origin: "policy" }],
        filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"], denyRead: [], denyWrite: [], denyReadGlobs: [], denyWriteGlobs: [] },
        network: { mode: "deny-all", allow: [], allowHost: [], deny: [] },
        resources: { unixSockets: [], tcpPublications: [] }, path: ["/__zerobox/runtime/bin"],
        environment: { inherit: [], set: ["HOME", "PATH"], deny: [] },
        home: { path: "/home/sandbox", namespace: "lease-private" },
        tmp: { path: "/tmp", namespace: "lease-private" }, docker: { mode: "disabled" },
    } }, "bash-general", {
        root: "/fixture/lease", homeDir: "/fixture/lease/home", tmpDir: "/fixture/lease/tmp",
        zeroboxHome: "/fixture/lease/zbx", proxyRunsDir: "/fixture/lease/proxies", profilesDir: "/fixture/lease/profiles",
    }, { homeDir: homedir() });
}

async function execute(settings: {
    context?: SandboxExecutionContext | null;
    backend?: "zerobox" | "host";
    mode?: "sandbox" | "host";
    command?: string;
    readyFailure?: boolean;
    settledFailure?: boolean;
    local?: boolean;
} = {}) {
    let output = "";
    const context = settings.context === undefined ? admitted() : settings.context ?? undefined;
    const operations = createBashOperations({
        shellPath: "/bin/bash",
        ...(!settings.local ? { prepareSpawn: async ({ command, cwd }) => ({
            file: "/bin/bash", args: ["-c", command], cwd, env: process.env, extraStdio: [],
            execution: { status: "unknown", profile: "bash-general", backend: settings.backend ?? "zerobox", mode: settings.mode, tmpNamespace: "lease-private", phase: "setup", outcome: "pending" },
            getSandboxContext: () => context,
            supervise: () => ({
                ready: settings.readyFailure ? Promise.reject(new Error("child did not start")) : Promise.resolve(),
                settled: settings.settledFailure ? Promise.reject(new Error("invalid status proof")) : Promise.resolve(),
            }),
        }) } satisfies CreateBashOperationsOptions : {}),
    });
    let failure: unknown;
    let result: Awaited<ReturnType<typeof operations.exec>> | undefined;
    try {
        result = await operations.exec(settings.command ?? `cd ${missing}`, process.cwd(), { onData: (chunk) => { output += chunk.toString(); } });
    } catch (error) { failure = error; }
    return { output, result, failure };
}

test("appends a read-scope diagnostic after an admitted shell fails, preserving the process output and exit", async () => {
    const result = await execute();
    expect(result.failure).toBeUndefined();
    expect(result.result).toEqual({ exitCode: 1 });
    expect(result.output).toStartWith(`/bin/bash: line 1: cd: ${missing}: No such file or directory\n`);
    expect(result.output).toContain(`Sandbox: ${missing} is outside the admitted read scope.`);
    expect(result.output).toContain("Its existence on the host cannot be determined from this error.");
});

test.each(["local", "host", "host-mode", "missing-admission", "invalid-admission", "planned", "ready-failed", "status-failed", "think"])("does not annotate %s executions", async (state) => {
    const context = admitted();
    if (state === "invalid-admission") context.admissionSha256 = "invalid";
    if (state === "think") context.profile = "think-strict";
    const result = await execute({ context: state === "missing-admission" ? null : state === "planned" ? { ...context, version: 2 } : context, backend: state === "host" ? "host" : "zerobox", mode: state === "host-mode" ? "host" : "sandbox", local: state === "local", readyFailure: state === "ready-failed", settledFailure: state === "status-failed" });
    expect(result.output).not.toContain("Sandbox:");
    if (state === "ready-failed" || state === "status-failed") expect(result.failure).toBeInstanceOf(Error);
});

test("recognizes an absolute Node module error on stderr", async () => {
    const line = `Error: Cannot find module '${missing}/package.json'`;
    const result = await execute({ command: `printf '%s\\n' "${line}" >&2; exit 7` });
    expect(result.result).toEqual({ exitCode: 7 });
    expect(result.output).toStartWith(line + "\n");
    expect(result.output).toContain(`Sandbox: ${missing}/package.json is outside the admitted read scope.`);
});

test("does not interpret a truncated partial line as an error and preserves large output", async () => {
    const output = "unrelated: " + errorLine + "x".repeat(65_536 - Buffer.byteLength(errorLine));
    const result = await execute({ command: `printf '%s' '${output}'; exit 1` });
    expect(result.result).toEqual({ exitCode: 1 });
    expect(result.output).toBe(output);
});

test("does not confuse a host-home display alias with an unexposed path", async () => {
    const context = admitted();
    context.mounts.push({ source: "~/projects/allowed", destination: "~/projects/allowed", access: "ro", origin: "policy" });
    const line = `bash: line 1: cd: ${homedir()}/projects/allowed/missing: No such file or directory\n`;
    const result = await execute({ context, command: `printf '%s' '${line}'; exit 1` });
    expect(result.output).toBe(line);
});

test.each(["allowed", "alias", "ambiguous", "relative", "success"])("preserves unqualified %s output", async (state) => {
    const context = admitted();
    if (state === "allowed") context.mounts.push({ source: missing, destination: missing, access: "ro", origin: "policy" });
    if (state === "alias") context.pathAliases = [{ destination: "/__pi_unexposed_project__", target: "/workspace", directory: true }];
    const line = state === "relative" ? "bash: line 1: cd: relative: No such file or directory\n" : state === "ambiguous" ? `Could not open ${missing}\n` : errorLine;
    const result = await execute({ context, command: `printf '%s' '${line}'; exit ${state === "success" ? 0 : 1}` });
    expect(result.output).toBe(line);
    expect(result.result).toEqual({ exitCode: state === "success" ? 0 : 1 });
});
