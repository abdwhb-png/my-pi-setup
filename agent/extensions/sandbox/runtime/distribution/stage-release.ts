import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
    access,
    copyFile,
    cp,
    lstat,
    mkdir,
    readdir,
    readFile,
    readlink,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { asJsonObject, readJsonObject } from "../../../_shared/json-object.ts";
import {
    acquireRuntimeStorageLock,
    containsRuntimePath,
    pruneRuntimeDirectories,
    readRuntimeUsage,
    type RuntimeCleanupReport,
} from "../../../_shared/runtime-storage.ts";
import { hashRuntimeFile, resolvePrivateRuntime } from "../runtime-bundle.ts";

export interface StageRuntimeReleaseOptions {
    candidateRoot: string;
    runtimeBase: string;
    managedBinary: string;
    provenanceSource: string;
    previousProvenanceSource?: string;
    expectedBinarySha256: string;
}

const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
const exists = async (path: string) =>
    access(path).then(
        () => true,
        () => false,
    );

async function trustedDirectory(path: string): Promise<void> {
    const target = resolve(path);
    const parts = target.split("/").filter(Boolean);
    let current = "/";
    for (const part of parts) {
        current = join(current, part);
        try {
            const stat = await lstat(current);
            const rootStickyDirectory =
                stat.uid === 0 && (stat.mode & 0o1000) !== 0;
            if (
                stat.isSymbolicLink() ||
                !stat.isDirectory() ||
                ((stat.mode & 0o022) !== 0 && !rootStickyDirectory) ||
                (process.getuid &&
                    stat.uid !== process.getuid() &&
                    stat.uid !== 0)
            )
                throw new Error(`Untrusted release directory: ${current}`);
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                error.code !== "ENOENT"
            )
                throw error;
            await mkdir(target, { recursive: true, mode: 0o700 });
            break;
        }
    }
    const stat = await lstat(target);
    const rootStickyDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        ((stat.mode & 0o022) !== 0 && !rootStickyDirectory) ||
        (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0)
    )
        throw new Error(`Untrusted release directory: ${target}`);
}

async function provenance(
    path: string,
    expectedBinarySha256: string,
    runtime: { version: string; manifestSha256: string; helperSha256: string },
): Promise<Uint8Array> {
    const bytes = await readFile(path);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(
            (value as { version?: unknown }).version as string,
        ) ||
        (value as { binarySha256?: unknown }).binarySha256 !==
            expectedBinarySha256
    ) {
        throw new Error(
            "Runtime provenance does not match the candidate binary",
        );
    }
    return Buffer.from(
        JSON.stringify(
            {
                ...(value as Record<string, unknown>),
                binarySha256: expectedBinarySha256,
                runtimeVersion: runtime.version,
                runtimeManifestSha256: runtime.manifestSha256,
                helperSha256: runtime.helperSha256,
            },
            null,
            2,
        ) + "\n",
    );
}

async function assertListedComponents(root: string): Promise<void> {
    const manifest: unknown = JSON.parse(
        await readFile(join(root, "manifest.json"), "utf8"),
    );
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
        throw new Error("Invalid runtime manifest");
    const components = (manifest as { components?: unknown }).components;
    if (
        !components ||
        typeof components !== "object" ||
        Array.isArray(components) ||
        JSON.stringify(Object.keys(components).sort()) !==
            JSON.stringify(["analysis", "shell"])
    ) {
        throw new Error(
            "Runtime manifest must declare only shell and analysis components",
        );
    }
    const actual = (
        await readdir(join(root, "components"), { withFileTypes: true })
    )
        .map((entry) => entry.name)
        .sort();
    if (JSON.stringify(actual) !== JSON.stringify(["analysis", "shell"]))
        throw new Error("Unlisted runtime component");
}

/** Validate before publication, then replace the managed entry with one atomic rename. */
export async function stageRuntimeRelease(
    options: StageRuntimeReleaseOptions,
): Promise<string> {
    const piRoot = dirname(dirname(resolve(options.managedBinary)));
    const lock = acquireRuntimeStorageLock(piRoot);
    let release: string;
    try {
        release = await stageRuntimeReleaseLocked(options);
    } finally {
        lock.release();
    }
    if (!existsSync(`${piRoot}.setup-journal.json`)) {
        try {
            const reports = await cleanupZeroboxRuntimeStore(piRoot);
            for (const report of reports)
                for (const warning of report.warnings) console.warn(warning);
        } catch (error) {
            console.warn(
                `Zerobox was promoted, but runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    return release;
}

async function stageRuntimeReleaseLocked(
    options: StageRuntimeReleaseOptions,
): Promise<string> {
    const candidateRoot = resolve(options.candidateRoot);
    const candidateBinary = join(candidateRoot, "bin/zerobox");
    await assertListedComponents(candidateRoot);
    const candidate = await resolvePrivateRuntime({
        binaryPath: candidateBinary,
        bundlePath: candidateRoot,
        expectedBinarySha256: options.expectedBinarySha256,
    });
    const provenanceBytes = await provenance(
        options.provenanceSource,
        options.expectedBinarySha256,
        candidate,
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.version))
        throw new Error("Invalid runtime release version");
    await trustedDirectory(options.runtimeBase);
    await trustedDirectory(dirname(options.managedBinary));
    const releaseRoot = join(
        resolve(options.runtimeBase),
        "zerobox",
        candidate.version,
    );
    if (await exists(releaseRoot))
        throw new Error(`Runtime release already exists: ${releaseRoot}`);

    const releases = dirname(releaseRoot);
    await trustedDirectory(releases);
    const temporary = join(
        releases,
        `.${candidate.version}.${randomUUID()}.staging`,
    );
    if (await exists(temporary))
        throw new Error(`Runtime staging path already exists: ${temporary}`);
    let pending: string | undefined;
    const previousEntry = join(releases, ".previous");
    const previousStat = await lstat(previousEntry).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        throw error;
    });
    if (previousStat && !previousStat.isSymbolicLink())
        throw new Error("Unexpected previous runtime resource");
    const oldPrevious = previousStat
        ? await readlink(previousEntry)
        : undefined;
    let previousChanged = false;
    let committed = false;
    try {
        await cp(candidateRoot, temporary, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
            errorOnExist: true,
        });
        // The candidate may already be sealed read-only. Replace only its
        // copied metadata inside this unpublished, owner-controlled directory.
        await rm(join(temporary, "provenance.json"), { force: true });
        await writeFile(join(temporary, "provenance.json"), provenanceBytes, {
            flag: "wx",
            mode: 0o600,
        });
        await resolvePrivateRuntime({
            binaryPath: join(temporary, "bin/zerobox"),
            bundlePath: temporary,
            expectedBinarySha256: options.expectedBinarySha256,
        });
        await rename(temporary, releaseRoot);

        const entry = resolve(options.managedBinary);
        let previous: string | undefined;
        if (await exists(entry)) {
            const previousBinary = realpathSync(entry);
            const previousRoot = dirname(dirname(previousBinary));
            if (
                (await lstat(entry)).isSymbolicLink() &&
                containsRuntimePath(releases, previousRoot) &&
                dirname(previousRoot) === releases &&
                existsSync(join(previousRoot, "manifest.json"))
            ) {
                previous = previousRoot;
            } else {
                const recoveryBase = join(releases, "recovery");
                await trustedDirectory(recoveryBase);
                const recovery = join(
                    recoveryBase,
                    `${Date.now()}-${randomUUID()}`,
                );
                await mkdir(recovery, { mode: 0o700 });
                await copyFile(entry, join(recovery, "zerobox"));
                await writeFile(
                    join(recovery, "metadata.json"),
                    JSON.stringify({
                        binarySha256: digest(await readFile(entry)),
                    }) + "\n",
                    { mode: 0o600 },
                );
                if (options.previousProvenanceSource)
                    await copyFile(
                        options.previousProvenanceSource,
                        join(recovery, "provenance.json"),
                    );
                previous = recovery;
            }
        }
        if (previous) {
            const nextPrevious = `${previousEntry}.${randomUUID()}.next`;
            await symlink(relative(releases, previous), nextPrevious);
            await rename(nextPrevious, previousEntry);
            previousChanged = true;
        }
        pending = `${entry}.${randomUUID()}.next`;
        await symlink(join(releaseRoot, "bin/zerobox"), pending);
        await rename(pending, entry);
        committed = true;
        pending = undefined;
        return releaseRoot;
    } catch (error) {
        if (pending) await rm(pending, { force: true });
        if (!committed && previousChanged) {
            if (oldPrevious === undefined)
                await rm(previousEntry, { force: true });
            else {
                const restored = `${previousEntry}.${randomUUID()}.restore`;
                await symlink(oldPrevious, restored);
                await rename(restored, previousEntry);
            }
        }
        await rm(temporary, { recursive: true, force: true });
        throw error;
    }
}

export async function cleanupZeroboxRuntimeStore(
    piRoot: string,
    dryRun = false,
): Promise<RuntimeCleanupReport[]> {
    const lock = acquireRuntimeStorageLock(piRoot);
    try {
        if (existsSync(`${lock.root}.setup-journal.json`))
            throw new Error(
                "Runtime cleanup is blocked by a setup transaction",
            );
        const store = join(lock.root, "runtimes/zerobox"),
            entry = join(lock.root, "bin/zerobox");
        if (!existsSync(store)) return [];
        if (!existsSync(entry))
            throw new Error(
                "Zerobox cleanup requires a managed current runtime",
            );
        const current = dirname(dirname(realpathSync(entry)));
        if (dirname(current) !== store)
            throw new Error(
                "Current Zerobox runtime is outside the managed store",
            );
        const keep = new Map<string, string>([
            [current, "current Zerobox runtime"],
        ]);
        let previous: string | undefined;
        const previousEntry = join(store, ".previous");
        const previousStat = await lstat(previousEntry).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
            throw error;
        });
        if (previousStat) {
            if (!previousStat.isSymbolicLink())
                throw new Error("Invalid previous Zerobox runtime reference");
            previous = realpathSync(previousEntry);
            if (
                dirname(previous) !== store &&
                dirname(previous) !== join(store, "recovery")
            )
                throw new Error("Previous Zerobox runtime escapes its store");
        } else {
            // Existing installations recorded their rollback target in the delivery receipt.
            const deliveries = join(lock.root, "runtime/deliveries");
            if (existsSync(deliveries))
                for (const name of await readdir(deliveries)) {
                    const file = join(deliveries, name, "activation.json");
                    if (!existsSync(file)) continue;
                    const state = readJsonObject(file);
                    if (state.activeRuntime !== join(current, "bin/zerobox"))
                        continue;
                    const target = dirname(
                        dirname(String(state.previousRuntime)),
                    );
                    if (dirname(target) !== store || !existsSync(target))
                        throw new Error(
                            "Invalid legacy Zerobox rollback reference",
                        );
                    const binary = join(target, "bin/zerobox");
                    if (
                        (await hashRuntimeFile(
                            binary,
                            (
                                await lstat(binary)
                            ).size,
                        )) !== state.previousBinarySha256 ||
                        digest(
                            await readFile(join(target, "manifest.json")),
                        ) !== state.previousManifestSha256
                    )
                        throw new Error(
                            "Legacy Zerobox rollback reference changed",
                        );
                    if (previous && previous !== target)
                        throw new Error(
                            "Ambiguous legacy Zerobox rollback reference",
                        );
                    previous = target;
                }
        }
        if (previous) keep.set(previous, "previous Zerobox runtime");
        const usage = readRuntimeUsage(lock, dryRun);
        const blocked = usage.legacyPi
            ? "legacy Pi session has no precise runtime reference"
            : previous === current
              ? "incomplete Zerobox promotion: previous equals current"
              : !previous &&
                  (await readdir(store)).filter(
                      (name) => !name.startsWith(".") && name !== "recovery",
                  ).length > 1
                ? "previous Zerobox runtime is not recorded"
                : undefined;
        const verified = new Set<string>();
        const validateRelease = async (path: string) => {
            if (verified.has(path)) return;
            const value = asJsonObject(
                JSON.parse(
                    await readFile(join(path, "provenance.json"), "utf8"),
                ),
            );
            if (typeof value.binarySha256 !== "string")
                throw new Error("Missing runtime digest");
            const runtime = await resolvePrivateRuntime({
                binaryPath: join(path, "bin/zerobox"),
                bundlePath: path,
                expectedBinarySha256: value.binarySha256,
            });
            if (
                runtime.version !== basename(path) ||
                value.runtimeManifestSha256 !== runtime.manifestSha256 ||
                value.helperSha256 !== runtime.helperSha256
            )
                throw new Error(
                    "Runtime provenance differs from the installed bundle",
                );
            verified.add(path);
        };
        const validateRecovery = async (path: string) => {
            const names = await readdir(path);
            if (
                names.some(
                    (name) =>
                        ![
                            "zerobox",
                            "metadata.json",
                            "provenance.json",
                        ].includes(name),
                )
            )
                throw new Error("Unknown recovery resource");
            const metadata = asJsonObject(
                JSON.parse(await readFile(join(path, "metadata.json"), "utf8")),
            );
            const binary = join(path, "zerobox");
            if (
                (await hashRuntimeFile(binary, (await lstat(binary)).size)) !==
                metadata.binarySha256
            )
                throw new Error("Invalid recovery digest");
        };
        await validateRelease(current);
        if (previous)
            await (dirname(previous) === store
                ? validateRelease(previous)
                : validateRecovery(previous));
        const releases = await pruneRuntimeDirectories({
            lock,
            store,
            keep,
            usage,
            dryRun,
            blocked,
            skip: ["recovery", ".previous"],
            validate: validateRelease,
        });
        const recovery = await pruneRuntimeDirectories({
            lock,
            store: join(store, "recovery"),
            keep,
            usage,
            dryRun,
            blocked:
                blocked ??
                (!previous ? "legacy rollback identity is unknown" : undefined),
            validate: validateRecovery,
        });
        return [releases, recovery];
    } finally {
        lock.release();
    }
}

if (import.meta.main) {
    const values = new Map<string, string>();
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        const value = process.argv[index + 1];
        if (!key?.startsWith("--") || !value || values.has(key))
            throw new Error(
                "Usage: bun stage-release.ts --candidate-root PATH --runtime-base PATH --managed-binary PATH --provenance-source PATH --expected-binary-sha256 SHA256",
            );
        values.set(key, value);
    }
    const required = (name: string) => {
        const value = values.get(name);
        if (!value) throw new Error(`Missing ${name}`);
        return value;
    };
    const release = await stageRuntimeRelease({
        candidateRoot: required("--candidate-root"),
        runtimeBase: required("--runtime-base"),
        managedBinary: required("--managed-binary"),
        provenanceSource: required("--provenance-source"),
        previousProvenanceSource: values.get("--previous-provenance-source"),
        expectedBinarySha256: required("--expected-binary-sha256"),
    });
    process.stdout.write(`${release}\n`);
}
