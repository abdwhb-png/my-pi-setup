/** Paired measurements through the real Pi sandbox boundary; never installs a runtime. */
/* oxlint-disable no-await-in-loop -- Paired samples must run sequentially to avoid measuring contention. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { cpus, loadavg, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { killProcessTree } from "../../_shared/command-execution/exec.ts";
import { asJsonObject } from "../../_shared/json-object.ts";
import { loadSandboxConfig } from "../index.ts";
import type { SandboxSpawnSpec } from "./contracts.ts";
import { createPrivateTempLease } from "./private-temp.ts";
import type { RuntimeProvenance } from "./runtime-bundle.ts";
import { createSandboxService } from "./service.ts";
import {
    createZeroboxBackend,
    inspectManagedPrivateRuntime,
} from "./zerobox-backend.ts";

const hash = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
function command(file: string, args: string[], cwd: string): string {
    const result = spawnSync(file, args, { cwd, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${file} exited ${result.status}: ${result.stderr}`);
    return result.stdout.trim();
}

async function main() {
    const { values } = parseArgs({
        options: {
            project: { type: "string" },
            "source-root": { type: "string" },
            output: { type: "string" },
            "reference-bundle": { type: "string" },
            "candidate-bundle": { type: "string" },
            "reference-binary": { type: "string" },
            "candidate-binary": { type: "string" },
            node: { type: "string", default: "/usr/bin/node" },
            python: { type: "string", default: "/usr/bin/python3" },
            pairs: { type: "string", default: "10" },
            iterations: { type: "string", default: "1000" },
            suite: { type: "string", default: "all" },
        },
    });
    if (
        !values.project ||
        !values["source-root"] ||
        !values.output ||
        !values["reference-bundle"] ||
        !values["candidate-bundle"]
    )
        throw new Error(
            "Required: --project --source-root --output --reference-bundle --candidate-bundle",
        );
    const project = resolve(values.project);
    const sourceRoot = resolve(values["source-root"]);
    const pairs = Number(values.pairs);
    const iterations = Number(values.iterations);
    if (
        ![1, 10, 20].includes(pairs) ||
        !Number.isSafeInteger(iterations) ||
        iterations < 1 ||
        !["all", "filesystem"].includes(values.suite)
    )
        throw new Error(
            "Use --pairs 1|10|20, positive --iterations, and --suite all|filesystem",
        );
    const output = resolve(values.output);
    await mkdir(output, { mode: 0o700 });
    const log = async (record: object) => {
        const line = JSON.stringify({
            timestamp: new Date().toISOString(),
            ...record,
        });
        await appendFile(join(output, "measurements.ndjson"), line + "\n");
        console.log(line);
    };
    const workload = await readFile(
        join(sourceRoot, "scripts/performance/workload.mjs"),
        "utf8",
    );
    const matrixBytes = await readFile(
        join(sourceRoot, "scripts/performance/matrix.json"),
        "utf8",
    );
    // oxlint-disable-next-line typescript/no-restricted-types -- Validate external JSON before using its structure.
    const parsedMatrix: unknown = JSON.parse(matrixBytes);
    if (!Array.isArray(parsedMatrix))
        throw new Error("Expected a benchmark task array");
    const tasks = parsedMatrix.map(asJsonObject);
    const loaded = loadSandboxConfig(project);
    const config = structuredClone(loaded.config);
    config.environment.variables.COREPACK_ENABLE_NETWORK = "0";
    const before = command("git", ["diff", "--binary"], project);
    const fixture = await mkdtemp(join(project, ".zerobox-perf-"));
    const leaseParent = await mkdtemp(join(tmpdir(), "zbp-"));
    const hostEnvironment = { ...process.env, ...config.environment.variables };
    const runtimes = [];
    try {
        for (const [mode, bundle] of [
            ["reference", values["reference-bundle"]],
            ["candidate", values["candidate-bundle"]],
        ] as const) {
            const root = resolve(bundle);
            const override =
                values[
                    mode === "reference"
                        ? "reference-binary"
                        : "candidate-binary"
                ];
            const binaryPath = override
                ? resolve(override)
                : join(root, "bin/zerobox");
            const provenance = asJsonObject(
                JSON.parse(
                    await readFile(join(root, "provenance.json"), "utf8"),
                ),
            );
            if (
                typeof provenance.version !== "string" ||
                typeof provenance.binarySha256 !== "string"
            )
                throw new Error("Missing candidate provenance");
            const expectedProvenance: RuntimeProvenance = {
                version: provenance.version,
                binarySha256: override
                    ? hash(await readFile(binaryPath))
                    : provenance.binarySha256,
            };
            const runtime = await inspectManagedPrivateRuntime({
                binaryPath,
                runtimeBundlePath: root,
                expectedProvenance,
            });
            const service = createSandboxService({
                backend: createZeroboxBackend({
                    binaryPath: runtime.binaryPath,
                    runtimeBundlePath: root,
                    expectedProvenance,
                    probeRoot: join(leaseParent, mode),
                }),
                config,
                createLease: () =>
                    createPrivateTempLease({ rootDir: leaseParent }),
                recoverStaleLeases: async () => {},
            });
            runtimes.push({
                mode,
                runtime,
                service,
                binarySha256: expectedProvenance.binarySha256,
                qualification: override ? "local-unqualified" : "bundle",
            });
        }
        await log({
            event: "manifest",
            schemaVersion: 1,
            pairs,
            iterations,
            suite: values.suite,
            sourceCommit: command("git", ["rev-parse", "HEAD"], sourceRoot),
            projectCommit: command("git", ["rev-parse", "HEAD"], project),
            projectDiffHash: hash(before),
            configHash: hash(JSON.stringify(loaded.config)),
            measuredConfigHash: hash(JSON.stringify(config)),
            workloadHash: hash(workload),
            matrixHash: hash(matrixBytes),
            launcherHash: hash(await readFile(import.meta.filename, "utf8")),
            kernel: release(),
            cpu: cpus()[0]?.model,
            load: loadavg(),
            node: command(values.node, ["--version"], project),
            python: command(values.python, ["--version"], project),
            runtimes: runtimes.map(
                ({ mode, runtime, binarySha256, qualification }) => ({
                    mode,
                    binarySha256,
                    qualification,
                    binaryPath: runtime.binaryPath,
                    version: runtime.version,
                    manifestSha256: runtime.manifestSha256,
                    helperSha256: runtime.helperSha256,
                }),
            ),
        });
        command(
            values.node,
            [
                "--input-type=module",
                "-e",
                workload,
                fixture,
                "prepare",
                values.python,
            ],
            project,
        );
        for (const runtime of runtimes) {
            const start = performance.now();
            await runtime.service.startBashSession(project);
            await log({
                event: "service-setup",
                mode: runtime.mode,
                elapsedMs: performance.now() - start,
            });
        }
        for (let pair = 0; pair < pairs; pair++) {
            const modes =
                pair % 2
                    ? ["candidate", "reference", "host"]
                    : ["host", "reference", "candidate"];
            for (const mode of modes) {
                const service = runtimes.find(
                    (runtime) => runtime.mode === mode,
                )?.service;
                const launch = async (args: string[]) => {
                    const start = performance.now();
                    let spec: SandboxSpawnSpec | undefined;
                    let child: ReturnType<typeof spawn> | undefined;
                    try {
                        spec = await service?.prepareBash({
                            file: values.node,
                            args,
                            cwd: project,
                        });
                        spec?.beforeSpawn?.();
                        const prepared = performance.now();
                        child = spawn(
                            spec?.file ?? values.node,
                            spec?.args ?? args,
                            {
                                cwd: spec?.cwd ?? project,
                                env: spec?.env ?? hostEnvironment,
                                detached: true,
                                signal: AbortSignal.timeout(240000),
                                stdio: [
                                    "pipe",
                                    "pipe",
                                    "pipe",
                                    ...(spec?.extraStdio ?? []),
                                ],
                            },
                        );
                        const ended = new Promise<number | null>(
                            (resolveExit, reject) => {
                                child!.once("error", reject);
                                child!.once("close", resolveExit);
                            },
                        );
                        void ended.catch(() => {});
                        const supervision = spec?.supervise(child);
                        let readyAt = prepared;
                        const ready = supervision?.ready.then(() => {
                            readyAt = performance.now();
                        });
                        void ready?.catch(() => {});
                        void supervision?.settled.catch(() => {});
                        let stderr = "";
                        child.stderr?.on("data", (bytes) => {
                            stderr += String(bytes);
                        });
                        if (!child.stdout || !child.stdin)
                            throw new Error("Missing benchmark pipes");
                        const lines = createInterface({ input: child.stdout })[
                            Symbol.asyncIterator
                        ]();
                        const next = async () => {
                            const line = await Promise.race([
                                lines.next(),
                                ended.then((code) => {
                                    throw new Error(
                                        `Workload closed (${code}): ${stderr}`,
                                    );
                                }),
                            ]);
                            if (line.done)
                                throw new Error("Missing workload response");
                            return asJsonObject(JSON.parse(line.value));
                        };
                        const banner = await next();
                        if (!banner.ready || banner.executable !== values.node)
                            throw new Error("Unexpected workload runtime");
                        await ready;
                        return {
                            banner,
                            next,
                            request: async (request: object) => {
                                child!.stdin!.write(
                                    JSON.stringify(request) + "\n",
                                );
                                return next();
                            },
                            finish: async (interactive: boolean) => {
                                if (interactive)
                                    child!.stdin!.end('{"op":"exit"}\n');
                                const code = await ended;
                                await supervision?.settled;
                                if (code !== 0)
                                    throw new Error(
                                        `Workload exited ${code}: ${stderr}`,
                                    );
                                return {
                                    prepareMs: prepared - start,
                                    nativeToReadyMs: readyAt - prepared,
                                    wallMs: performance.now() - start,
                                };
                            },
                            cleanup: async () => {
                                if (child?.exitCode === null && child.pid)
                                    killProcessTree(child.pid, "SIGKILL");
                                await ended;
                                await spec?.cleanup?.();
                            },
                        };
                    } catch (error) {
                        if (child?.pid) killProcessTree(child.pid, "SIGKILL");
                        await spec?.cleanup?.();
                        throw error;
                    }
                };
                const startup = await launch([
                    "-e",
                    "console.log(JSON.stringify({ready:true,executable:process.execPath}))",
                ]);
                try {
                    await log({
                        event: "startup",
                        mode,
                        pair,
                        ...(await startup.finish(false)),
                    });
                } finally {
                    await startup.cleanup();
                }
                const client = await launch([
                    "--input-type=module",
                    "-e",
                    workload,
                    fixture,
                    "measure",
                    values.python,
                ]);
                try {
                    if (
                        mode !== "host" &&
                        client.banner.filesystemType !== 0x65735546
                    )
                        throw new Error(
                            "Fixture is not on the guarded FUSE view",
                        );
                    await writeFile(
                        join(fixture, "late-secret.pem"),
                        "Synthetic denial canary\n",
                    );
                    const canary = await client.request({ op: "canary", n: 1 });
                    const details = asJsonObject(canary.details);
                    if (
                        mode === "host"
                            ? details.readable !== true
                            : details.code !== "EACCES"
                    )
                        throw new Error("Dynamic denial canary failed");
                    await log({ event: "guard", mode, pair, ...canary });
                    const ordered = pair % 2 ? tasks.toReversed() : tasks;
                    for (const task of ordered) {
                        if (
                            values.suite === "filesystem" &&
                            task.family !== "filesystem"
                        )
                            continue;
                        for (const phase of ["warmup", "sample"]) {
                            const n =
                                phase === "warmup"
                                    ? task.family === "filesystem"
                                        ? 10
                                        : 1
                                    : task.family === "filesystem"
                                      ? iterations
                                      : 1;
                            const result = await client.request({
                                ...task,
                                phase,
                                n,
                            });
                            if (
                                result.error ||
                                result.checksum !==
                                    Number(task.checksumPerIteration) * n
                            )
                                throw new Error(
                                    "Workload failed: " +
                                        JSON.stringify(result),
                                );
                            await log({
                                event: "measurement",
                                mode,
                                pair,
                                ...result,
                            });
                        }
                    }
                    await client.finish(true);
                } finally {
                    await client.cleanup();
                    await rm(join(fixture, "late-secret.pem"), { force: true });
                }
            }
        }
    } catch (error) {
        await log({
            event: "failure",
            message: error instanceof Error ? error.message : String(error),
        });
        throw error;
    } finally {
        for (const { service } of runtimes) await service.shutdown();
        await rm(fixture, { recursive: true });
        await rm(leaseParent, { recursive: true });
    }
    if (command("git", ["diff", "--binary"], project) !== before)
        throw new Error("Project diff changed during measurement");
}

if (import.meta.main) await main();
