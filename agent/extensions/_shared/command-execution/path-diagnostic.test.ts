import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
    createAdmittedSandboxExecutionContext,
    type SandboxExecutionContext,
} from "../sandbox-runtime/execution-context.ts";
import { sandboxShellDiagnostic } from "./diagnostics.ts";
import {
    createBashOperations,
    type BashSpawn,
    type CreateBashOperationsOptions,
} from "./exec.ts";

const missing = "/__pi_unexposed_project__/frontend";
const errorLine = `bash: line 1: cd: ${missing}: No such file or directory\n`;
const libraryError =
    "Error: librt.so.1: cannot open shared object file: No such file or directory\n";

/** Fixture command writing to stderr, where the loader diagnostics are read. */
function printStderr(output: string, exitCode = 1) {
    return `process.stderr.write(${JSON.stringify(output)}); process.exit(${exitCode})`;
}

/** Fixture command writing to stdout, for the preservation cases. */
function printStdout(output: string, exitCode = 1) {
    return `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode})`;
}

/**
 * What bash prints for a `cd` into an unexposed directory, as the fixture's own
 * output. The message shape is the input the read-scope check parses; it is not
 * produced by a real shell here.
 */
const missingOutput = `/bin/bash: line 1: cd: ${missing}: No such file or directory\n`;

/**
 * Run the fixture command with the test runner's own binary instead of the
 * shell named in the spawn spec.
 *
 * The child is a real process, so this stays an end-to-end check of `exec.ts`:
 * stream relay, exit code, supervision, and diagnostic append all run for real.
 * Only the interpreter is substituted, because these assertions are about the
 * diagnostic transforms — not about `bash` — and `/bin/bash` is not part of the
 * curated read-only root a sandboxed shell exposes. Without the substitution the
 * outcome depends on which shell mode the test process happens to run in.
 *
 * `args.at(-1)` is the command in both spec shapes: `["-c", command]` from the
 * default spec and from `prepareSpawn` below.
 */
const runnerSpawn: BashSpawn = (_file, args, options) =>
    spawn(process.execPath, ["-e", args.at(-1) ?? ""], options);

function admitted() {
    return createAdmittedSandboxExecutionContext(
        {
            sha256: "c".repeat(64),
            report: {
                schema: 1,
                runtime: {
                    target: "x86_64-unknown-linux-gnu",
                    version: "test",
                    manifestSha256: "a".repeat(64),
                    component: "shell",
                },
                helperSha256: "b".repeat(64),
                kernelMounts: [],
                mounts: [
                    {
                        source: "/workspace",
                        destination: "/workspace",
                        access: "rw",
                        origin: "policy",
                    },
                ],
                filesystem: {
                    allowRead: ["/workspace"],
                    allowWrite: ["/workspace"],
                    denyRead: [],
                    denyWrite: [],
                    denyReadGlobs: [],
                    denyWriteGlobs: [],
                },
                network: { mode: "deny-all", allow: [], allowHost: [], deny: [] },
                resources: { unixSockets: [], tcpPublications: [] },
                path: ["/__zerobox/runtime/bin"],
                environment: { inherit: [], set: ["HOME", "PATH"], deny: [] },
                home: { path: "/home/sandbox", namespace: "lease-private" },
                tmp: { path: "/tmp", namespace: "lease-private" },
                docker: { mode: "disabled" },
            },
        },
        "bash-general",
        {
            root: "/fixture/lease",
            homeDir: "/fixture/lease/home",
            tmpDir: "/fixture/lease/tmp",
            zeroboxHome: "/fixture/lease/zbx",
            proxyRunsDir: "/fixture/lease/proxies",
            profilesDir: "/fixture/lease/profiles",
        },
        { homeDir: homedir() },
    );
}

/**
 * The production transform under test. `sandboxShellDiagnostic` runs the
 * read-scope check and then the loader check, so one call covers both families.
 * It is pure — no host filesystem probing — so these cases need no child.
 */
function annotate(output: string, context?: SandboxExecutionContext) {
    return sandboxShellDiagnostic(output, context);
}

async function execute(
    settings: {
        context?: SandboxExecutionContext | null;
        backend?: "zerobox" | "host";
        mode?: "sandbox" | "host";
        command?: string;
        readyFailure?: boolean;
        settledFailure?: boolean;
        local?: boolean;
    } = {},
) {    let output = "";
    const context =
        settings.context === undefined ? admitted() : (settings.context ?? undefined);
    const operations = createBashOperations({
        shellPath: "/bin/bash",
        spawn: runnerSpawn,
        ...(!settings.local
            ? {
                  prepareSpawn: async ({ command, cwd }) => ({
                      file: "/bin/bash",
                      args: ["-c", command],
                      cwd,
                      env: process.env,
                      extraStdio: [],
                      execution: {
                          status: "unknown",
                          profile: "bash-general",
                          backend: settings.backend ?? "zerobox",
                          mode: settings.mode,
                          tmpNamespace: "lease-private",
                          phase: "setup",
                          outcome: "pending",
                      },
                      getSandboxContext: () => context,
                      supervise: () => ({
                          ready: settings.readyFailure
                              ? Promise.reject(new Error("child did not start"))
                              : Promise.resolve(),
                          settled: settings.settledFailure
                              ? Promise.reject(new Error("invalid status proof"))
                              : Promise.resolve(),
                      }),
                  }),
              }
            : {}) satisfies CreateBashOperationsOptions,
    });
    let failure: unknown;
    let result: Awaited<ReturnType<typeof operations.exec>> | undefined;
    try {
        result = await operations.exec(
            settings.command ?? printStderr(missingOutput),
            process.cwd(),
            { onData: (chunk) => { output += chunk.toString(); } },
        );
    } catch (error) {
        failure = error;
    }
    return { output, result, failure };
}

// --- Read-scope diagnostics (pure transform) ---

test("appends a read-scope diagnostic for an unexposed path", () => {
    const output = `/bin/bash: line 1: cd: ${missing}: No such file or directory\n`;

    const diagnostic = annotate(output, admitted());
    expect(diagnostic).toContain(
        `Sandbox: ${missing} is outside the admitted read scope.`,
    );
    expect(diagnostic).toContain(
        "Its existence on the host cannot be determined from this error.",
    );
});

test("recognizes an absolute Node module error on stderr", () => {
    const line = `Error: Cannot find module '${missing}/package.json'`;

    expect(annotate(line, admitted())).toContain(
        `Sandbox: ${missing}/package.json is outside the admitted read scope.`,
    );
});

test("does not confuse a host-home display alias with an unexposed path", () => {
    const context = admitted();
    context.mounts.push({
        source: "~/projects/allowed",
        destination: "~/projects/allowed",
        access: "ro",
        origin: "policy",
    });
    const line = `bash: line 1: cd: ${homedir()}/projects/allowed/missing: No such file or directory\n`;

    expect(annotate(line, context)).toBeUndefined();
});

// --- Loader diagnostics (pure transform) ---

test("explains a native binding's missing library without treating loader fallbacks as a missing package", () => {
    const original = [
        "Error: Cannot find native binding. Please try reinstalling dependencies.",
        "  cause: Error: librt.so.1: cannot open shared object file: No such file or directory",
        "    code: 'ERR_DLOPEN_FAILED',",
        "    cause: Error: Cannot find module './tool.linux-x64-gnu.node'",
        "",
    ].join("\n");

    const diagnostic = annotate(original, admitted());
    expect(diagnostic).toContain(
        "Sandbox: the dynamic loader could not find librt.so.1.",
    );
    expect(diagnostic).toContain(
        "The library may be absent or outside this execution's read permissions.",
    );
    expect(diagnostic).toContain(
        "The accompanying module/binding errors do not establish that the package is missing.",
    );
    expect(diagnostic).not.toContain("is outside the admitted read scope");
});

test.each([
    "tool: error while loading shared libraries: libexample.so.2: cannot open shared object file: No such file or directory\n",
    "error: libexample.so.2: cannot open shared object file: No such file or directory\n",
])("explains a generic shared-library loader failure: %s", (original) => {
    const diagnostic = annotate(original, admitted());
    expect(diagnostic).toContain(
        "Sandbox: the dynamic loader could not find libexample.so.2.",
    );
    expect(diagnostic).not.toContain("module/binding errors");
});

test.each([
    "Error: Cannot find module './tool.node'\n",
    "Error: Cannot find native binding.\n",
    "unrelated: " + libraryError,
    "Error: libexample.so.2: cannot open shared object file: Permission denied\n",
    "Error: /ambiguous path/libexample.so.2: cannot open shared object file: No such file or directory\n",
])("preserves errors without an unambiguous missing-library diagnosis: %s", (original) => {
    expect(annotate(original, admitted())).toBeUndefined();
});

test("bounds shared-library diagnostics and reports repeated libraries only once", () => {
    const original = [
        "libone.so.1",
        "libtwo.so.1",
        "libone.so.1",
        "libthree.so.1",
        "libfour.so.1",
    ]
        .map(
            (library) =>
                `Error: ${library}: cannot open shared object file: No such file or directory\n`,
        )
        .join("");

    expect(
        annotate(original, admitted())?.match(
            /Sandbox: the dynamic loader could not find [^\n]+/g,
        ),
    ).toEqual([
        "Sandbox: the dynamic loader could not find libone.so.1.",
        "Sandbox: the dynamic loader could not find libtwo.so.1.",
        "Sandbox: the dynamic loader could not find libthree.so.1.",
    ]);
});

test.each(["allowed", "alias", "ambiguous", "relative"])(
    "preserves unqualified %s output",
    (state) => {
        const context = admitted();
        if (state === "allowed")
            context.mounts.push({
                source: missing,
                destination: missing,
                access: "ro",
                origin: "policy",
            });
        if (state === "alias")
            context.pathAliases = [
                {
                    destination: "/__pi_unexposed_project__",
                    target: "/workspace",
                    directory: true,
                },
            ];
        const line =
            state === "relative"
                ? "bash: line 1: cd: relative: No such file or directory\n"
                : state === "ambiguous"
                  ? `Could not open ${missing}\n`
                  : errorLine;

        expect(annotate(line, context)).toBeUndefined();
    },
);

// --- Pipeline behavior (real child, substituted interpreter) ---

test("appends a read-scope diagnostic after an admitted shell fails, preserving the process output and exit", async () => {
    const result = await execute();
    expect(result.failure).toBeUndefined();
    expect(result.result).toEqual({ exitCode: 1 });
    expect(result.output).toStartWith(missingOutput);
    expect(result.output).toContain(
        `Sandbox: ${missing} is outside the admitted read scope.`,
    );
    expect(result.output).toContain(
        "Its existence on the host cannot be determined from this error.",
    );
});

test("does not annotate a failed-path message after a successful command", async () => {
    const result = await execute({
        command: printStderr(errorLine + libraryError, 0),
    });
    expect(result.result).toEqual({ exitCode: 0 });
    expect(result.output).toBe(errorLine + libraryError);
});

test("does not infer Docker state from a caller-generated availability message", async () => {
    const context = admitted();
    context.docker = {
        mode: "targeted",
        profile: "None",
        targets: [],
        hostAccessException: false,
    };
    const original = "Docker is not running.\nPHP 8.5.0\n";
    const result = await execute({
        context,
        command: printStdout(original, 0),
    });

    expect(result.failure).toBeUndefined();
    expect(result.result).toEqual({ exitCode: 0 });
    expect(result.output).toBe(original);
});

test.each(["local", "host", "host-mode", "missing-admission", "invalid-admission", "planned", "ready-failed", "status-failed", "think"])(
    "does not annotate %s executions",
    async (state) => {
        const context = admitted();
        if (state === "invalid-admission") context.admissionSha256 = "invalid";
        if (state === "think") context.profile = "think-strict";
        const result = await execute({
            context:
                state === "missing-admission"
                    ? null
                    : state === "planned"
                      ? { ...context, version: 2 }
                      : context,
            backend: state === "host" ? "host" : "zerobox",
            mode: state === "host-mode" ? "host" : "sandbox",
            local: state === "local",
            readyFailure: state === "ready-failed",
            settledFailure: state === "status-failed",
            command: printStderr(errorLine + libraryError),
        });
        expect(result.output).not.toContain("Sandbox:");
        if (state === "ready-failed" || state === "status-failed")
            expect(result.failure).toBeInstanceOf(Error);
    },
);

test.each([errorLine, libraryError])(
    "does not interpret a truncated partial line as an error and preserves large output: %s",
    async (line) => {
        const output =
            "unrelated: " + line + "x".repeat(65_536 - Buffer.byteLength(line));
        const result = await execute({ command: printStdout(output) });
        expect(result.result).toEqual({ exitCode: 1 });
        expect(result.output).toBe(output);
    },
);
