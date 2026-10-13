import { createHash } from "node:crypto";
import {
    lstat,
    open,
    readFile,
    readdir,
    realpath,
    readlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SandboxExecutionError } from "./contracts.ts";

export interface PrivateRuntimeComponent {
    root: string;
    files: { path: string; sha256?: string; symlink?: string }[];
}
export interface PrivateRuntimeBundle {
    root: string;
    binaryPath: string;
    version: string;
    target: "x86_64-unknown-linux-gnu";
    manifestSha256: string;
    helperSha256: string;
    components: {
        shell: PrivateRuntimeComponent;
        analysis: PrivateRuntimeComponent;
    };
}
export interface ResolvePrivateRuntimeOptions {
    signal?: AbortSignal;
    binaryPath: string;
    expectedBinarySha256: string;
    bundlePath?: string;
}
export interface RuntimeProvenance {
    version: string;
    binarySha256: string;
    runtimeManifestSha256?: string;
    helperSha256?: string;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}
function hash(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}
function digest(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function version(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    );
}
function contained(root: string, path: string): boolean {
    const suffix = relative(root, path);
    return (
        suffix === "" ||
        (!suffix.startsWith("../") && suffix !== ".." && !isAbsolute(suffix))
    );
}
function child(root: string, value: unknown): string {
    if (
        typeof value !== "string" ||
        !value ||
        value.includes("\0") ||
        isAbsolute(value) ||
        value.split("/").some((part) => !part || part === "." || part === "..")
    )
        throw new Error("Distribution entry must be a safe relative path");
    return join(root, value);
}
async function secure(path: string, directory = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const stat = await lstat(path);
    signal?.throwIfAborted();
    if (
        stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile()) ||
        (stat.mode & 0o022) !== 0 ||
        (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0)
    )
        throw new Error(`Untrusted distribution path: ${path}`);
    return stat;
}

const HASH_BLOCK_BYTES = 1024 * 1024;

async function hashFile(
    path: string,
    size: number,
    signal?: AbortSignal,
): Promise<string> {
    signal?.throwIfAborted();
    if (size <= HASH_BLOCK_BYTES) {
        const bytes = await readFile(path, { signal });
        signal?.throwIfAborted();
        return hash(bytes);
    }
    const file = await open(path, "r");
    try {
        const buffer = Buffer.allocUnsafe(HASH_BLOCK_BYTES);
        const hasher = createHash("sha256");
        while (true) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(
                buffer,
                0,
                buffer.length,
                null,
            );
            signal?.throwIfAborted();
            if (bytesRead === 0) return hasher.digest("hex");
            hasher.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        // Keep ownership of the descriptor until pending reads and close settle.
        await file.close();
    }
}

/** Resolve once so an atomic entry switch cannot pair two releases' metadata. */
export async function readPrivateRuntimeEntry(
    entry: string,
    legacyProvenance: URL,
    signal?: AbortSignal,
): Promise<{ binaryPath: string; provenance: RuntimeProvenance }> {
    try {
        signal?.throwIfAborted();
        const binaryPath = await realpath(entry);
        signal?.throwIfAborted();
        const managed = (await lstat(entry)).isSymbolicLink();
        signal?.throwIfAborted();
        const release = dirname(dirname(binaryPath));
        if (managed) {
            if (
                !contained(
                    resolve(dirname(entry), "../runtimes/zerobox"),
                    release,
                )
            )
                throw new Error(
                    "Managed runtime points outside its release directory",
                );
            await secure(release, true, signal);
            await secure(binaryPath, false, signal);
            await secure(join(release, "provenance.json"), false, signal);
            await secure(join(release, "manifest.json"), false, signal);
        }
        const value: unknown = JSON.parse(
            await readFile(
                managed ? join(release, "provenance.json") : legacyProvenance,
                { encoding: "utf8", signal },
            ),
        );
        signal?.throwIfAborted();
        if (
            !record(value) ||
            !version(value.version) ||
            !digest(value.binarySha256)
        )
            throw new Error("Invalid runtime provenance");
        if (
            managed &&
            (!digest(value.runtimeManifestSha256) ||
                !digest(value.helperSha256) ||
                hash(
                    await readFile(join(release, "manifest.json"), { signal }),
                ) !== value.runtimeManifestSha256)
        )
            throw new Error(
                "Runtime manifest differs from its release provenance",
            );
        signal?.throwIfAborted();
        return {
            binaryPath,
            provenance: {
                version: value.version,
                binarySha256: value.binarySha256,
                ...(digest(value.runtimeManifestSha256)
                    ? { runtimeManifestSha256: value.runtimeManifestSha256 }
                    : {}),
                ...(digest(value.helperSha256)
                    ? { helperSha256: value.helperSha256 }
                    : {}),
            },
        };
    } catch (error) {
        signal?.throwIfAborted();
        throw new SandboxExecutionError("provenance-mismatch", {
            diagnostic:
                error instanceof Error
                    ? error.message
                    : "Runtime entry verification failed",
            cause: error,
        });
    }
}
async function tree(
    root: string,
    value: unknown,
    signal?: AbortSignal,
): Promise<PrivateRuntimeComponent> {
    signal?.throwIfAborted();
    if (
        !record(value) ||
        !onlyKeys(value, ["root", "files"]) ||
        !Array.isArray(value.files)
    )
        throw new Error("Invalid component manifest");
    const componentRoot = child(root, value.root);
    await secure(componentRoot, true, signal);
    if ((await realpath(componentRoot)) !== componentRoot)
        throw new Error(
            "Component root redirects outside its recorded location",
        );
    const files: PrivateRuntimeComponent["files"] = [];
    const declared = new Set<string>();
    for (const item of value.files) {
        signal?.throwIfAborted();
        if (!record(item) || !onlyKeys(item, ["path", "sha256", "symlink"]))
            throw new Error("Invalid component entry");
        const path = child(componentRoot, item.path);
        const name = relative(componentRoot, path);
        if (declared.has(name)) throw new Error("Duplicate component entry");
        declared.add(name);
        if (digest(item.sha256) && item.symlink === undefined) {
            files.push({ path: name, sha256: item.sha256 });
        } else if (
            typeof item.symlink === "string" &&
            item.sha256 === undefined
        ) {
            files.push({ path: name, symlink: item.symlink });
        } else
            throw new Error(
                "Runtime entry requires exactly one digest or symlink",
            );
    }
    let next = 0;
    const failures: { index: number; error: unknown }[] = [];
    async function verifyNext(): Promise<void> {
        while (failures.length === 0 && next < files.length) {
            const index = next++;
            const file = files[index];
            try {
                signal?.throwIfAborted();
                const path = join(componentRoot, file.path);
                if ((await realpath(dirname(path))) !== dirname(path))
                    throw new Error("Component entry has a redirected parent");
                signal?.throwIfAborted();
                if (file.sha256 !== undefined) {
                    const stat = await secure(path, false, signal);
                    if (
                        (await hashFile(path, stat.size, signal)) !==
                        file.sha256
                    )
                        throw new Error(
                            `Runtime file digest mismatch: ${file.path}`,
                        );
                } else {
                    const link = await readlink(path);
                    signal?.throwIfAborted();
                    if (
                        link !== file.symlink ||
                        isAbsolute(link) ||
                        !contained(
                            componentRoot,
                            resolve(dirname(path), link),
                        ) ||
                        !contained(componentRoot, await realpath(path))
                    )
                        throw new Error(
                            `Runtime symlink leaves its component: ${file.path}`,
                        );
                }
            } catch (error) {
                failures.push({ index, error });
            }
        }
    }
    // Each worker owns its pending I/O until it settles, including after another worker fails.
    await Promise.all(
        Array.from({ length: Math.min(8, files.length) }, verifyNext),
    );
    signal?.throwIfAborted();
    if (failures.length > 0) {
        failures.sort((a, b) => a.index - b.index);
        throw failures[0].error;
    }
    async function checkListed(directory: string): Promise<void> {
        signal?.throwIfAborted();
        const entries = await readdir(directory, { withFileTypes: true });
        signal?.throwIfAborted();
        for (const item of entries) {
            signal?.throwIfAborted();
            const path = join(directory, item.name);
            if (item.isDirectory()) {
                await secure(path, true, signal);
                await checkListed(path);
            } else if (!declared.has(relative(componentRoot, path)))
                throw new Error(
                    `Unlisted runtime file: ${relative(componentRoot, path)}`,
                );
        }
    }
    await checkListed(componentRoot);
    return { root: componentRoot, files };
}

/** Pin the managed entry once. Never resolve it again during this runtime's lifetime. */
export async function resolvePrivateRuntime(
    options: ResolvePrivateRuntimeOptions,
): Promise<PrivateRuntimeBundle> {
    const { signal } = options;
    try {
        signal?.throwIfAborted();
        const binaryPath = await realpath(options.binaryPath);
        const binaryStat = await secure(binaryPath, false, signal);
        if (((await lstat(binaryPath)).mode & 0o111) === 0)
            throw new Error("Runtime executable lacks execute permission");
        if (
            (await hashFile(binaryPath, binaryStat.size, signal)) !==
            options.expectedBinarySha256
        )
            throw new Error("Runtime executable digest mismatch");
        const root = options.bundlePath
            ? resolve(options.bundlePath)
            : dirname(dirname(binaryPath));
        await secure(root, true, signal);
        if ((await realpath(root)) !== root)
            throw new Error(
                "Bundle root redirects outside its recorded location",
            );
        signal?.throwIfAborted();
        if (
            (await lstat(options.binaryPath)).isSymbolicLink() &&
            !options.bundlePath &&
            !contained(
                resolve(dirname(options.binaryPath), "../runtimes/zerobox"),
                root,
            )
        )
            throw new Error(
                "Managed executable points outside the release directory",
            );
        const manifestPath = join(root, "manifest.json");
        await secure(manifestPath, false, signal);
        const bytes = await readFile(manifestPath, { signal });
        signal?.throwIfAborted();
        const manifest: unknown = JSON.parse(bytes.toString("utf8"));
        if (
            !record(manifest) ||
            !onlyKeys(manifest, [
                "schema",
                "target",
                "version",
                "components",
                "helper",
            ]) ||
            manifest.schema !== 1 ||
            manifest.target !== "x86_64-unknown-linux-gnu" ||
            !version(manifest.version) ||
            !record(manifest.components) ||
            !onlyKeys(manifest.components, ["shell", "analysis"]) ||
            !record(manifest.helper) ||
            !onlyKeys(manifest.helper, ["path", "sha256"]) ||
            !digest(manifest.helper.sha256)
        )
            throw new Error("Unsupported runtime manifest");
        const helper = child(root, manifest.helper.path);
        const helperStat = await secure(helper, false, signal);
        if (
            (await realpath(helper)) !== helper ||
            (await hashFile(helper, helperStat.size, signal)) !==
                manifest.helper.sha256
        )
            throw new Error("Runtime helper digest mismatch");
        const shell = await tree(root, manifest.components.shell, signal);
        const analysis = await tree(root, manifest.components.analysis, signal);
        for (const command of ["bin/bash", "bin/env"])
            if (!shell.files.some((file) => file.path === command))
                throw new Error(`Private shell command missing: ${command}`);
        signal?.throwIfAborted();
        return {
            root,
            binaryPath,
            version: manifest.version,
            target: manifest.target,
            manifestSha256: hash(bytes),
            helperSha256: manifest.helper.sha256,
            components: { shell, analysis },
        };
    } catch (error) {
        signal?.throwIfAborted();
        throw new SandboxExecutionError("provenance-mismatch", {
            diagnostic:
                error instanceof Error
                    ? error.message
                    : "Runtime verification failed",
            cause: error,
        });
    }
}
