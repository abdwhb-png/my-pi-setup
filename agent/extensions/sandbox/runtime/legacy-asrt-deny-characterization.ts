import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const packageRoot = process.env.ASRT_PACKAGE_ROOT;
if (!packageRoot || !isAbsolute(packageRoot)) {
    throw new Error(
        "ASRT_PACKAGE_ROOT must be an absolute ASRT 0.0.74 package root",
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const packageJsonBytes = await readFile(join(packageRoot, "package.json"));
const packageJson: unknown = JSON.parse(packageJsonBytes.toString());
if (
    !isRecord(packageJson) ||
    packageJson.name !== "@anthropic-ai/sandbox-runtime" ||
    packageJson.version !== "0.0.74"
) {
    throw new Error(
        "ASRT_PACKAGE_ROOT is not @anthropic-ai/sandbox-runtime 0.0.74",
    );
}

const entrypoint = join(packageRoot, "dist", "index.js");
const entrypointBytes = await readFile(entrypoint);
const asrtModule: unknown = await import(entrypoint);
if (!isRecord(asrtModule) || !isRecord(asrtModule.SandboxManager)) {
    throw new Error("ASRT package does not export SandboxManager");
}
const initialize: unknown = asrtModule.SandboxManager.initialize;
const wrapWithSandbox: unknown = asrtModule.SandboxManager.wrapWithSandbox;
const reset: unknown = asrtModule.SandboxManager.reset;
if (
    typeof initialize !== "function" ||
    typeof wrapWithSandbox !== "function" ||
    typeof reset !== "function"
) {
    throw new Error("ASRT SandboxManager has an incompatible API");
}
const root = await mkdtemp(join(tmpdir(), "asrt-glob-characterization-"));
const originalCwd = process.cwd();
process.chdir(root);

function run(
    command: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, { cwd: root, shell: true });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.once("error", reject);
        child.once("exit", (exitCode) =>
            resolve({
                exitCode,
                stdout: Buffer.concat(stdout).toString(),
                stderr: Buffer.concat(stderr).toString(),
            }),
        );
    });
}

try {
    const cases = [
        { pattern: ".env", target: ".env" },
        { pattern: ".env.*", target: ".env.local" },
        { pattern: "*.pem", target: "late.pem" },
        { pattern: "*.key", target: "late.key" },
        { pattern: "*/node_modules/*", target: "pkg/node_modules/late.txt" },
    ];
    await initialize({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
            denyRead: [],
            allowWrite: [root],
            denyWrite: cases.map(({ pattern }) => pattern),
        },
    });

    const results = [];
    for (const [caseIndex, entry] of cases.entries()) {
        const targetPath = join(root, entry.target);
        const controlPath = join(root, `control-${caseIndex}`);
        await mkdir(join(root, "pkg/node_modules"), { recursive: true });
        await rm(targetPath, { force: true });
        await rm(controlPath, { force: true });
        const existedBeforeWrap = await Bun.file(targetPath).exists();
        const command = [
            `printf target-payload > ${JSON.stringify(targetPath)}`,
            "target_write=$?",
            `printf control-payload > ${JSON.stringify(controlPath)}`,
            "control_write=$?",
            `printf '%s %s' "$target_write" "$control_write"`,
        ].join("; ");
        const wrapped: unknown = await wrapWithSandbox(command);
        if (typeof wrapped !== "string") {
            throw new Error(
                "ASRT wrapWithSandbox did not return a command string",
            );
        }
        const existedAfterWrap = await Bun.file(targetPath).exists();
        const output = await run(wrapped);
        const [targetWriteExit, controlWriteExit] = output.stdout
            .trim()
            .split(/\s+/)
            .map(Number);
        results.push({
            pattern: entry.pattern,
            target: entry.target,
            existedBeforeWrap,
            existedAfterWrap,
            targetWriteExit,
            controlWriteExit,
            targetContent: await readFile(targetPath, "utf8").catch(() => null),
            controlContent: await readFile(controlPath, "utf8").catch(
                () => null,
            ),
            wrapperExit: output.exitCode,
            stderr: output.stderr.replaceAll(root, "$WORKDIR"),
        });
    }

    console.log(
        JSON.stringify(
            {
                platform: process.platform,
                arch: process.arch,
                asrtVersion: packageJson.version,
                packageJsonSha256: createHash("sha256")
                    .update(packageJsonBytes)
                    .digest("hex"),
                entrypointSha256: createHash("sha256")
                    .update(entrypointBytes)
                    .digest("hex"),
                results,
            },
            null,
            2,
        ),
    );
} finally {
    try {
        await reset();
    } catch {
        // Characterization cleanup is best-effort; the temporary tree is still removed below.
    }
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
}
