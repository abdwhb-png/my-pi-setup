import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, readlink } from "node:fs/promises";
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
async function secure(path: string, directory = false): Promise<void> {
    const stat = await lstat(path);
    if (
        stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile()) ||
        (stat.mode & 0o022) !== 0 ||
        (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0)
    )
        throw new Error(`Untrusted distribution path: ${path}`);
}

/** Resolve once so an atomic entry switch cannot pair two releases' metadata. */
export async function readPrivateRuntimeEntry(
    entry: string,
    legacyProvenance: URL,
): Promise<{ binaryPath: string; provenance: RuntimeProvenance }> {
    try {
        const binaryPath = await realpath(entry);
        const managed = (await lstat(entry)).isSymbolicLink();
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
            await secure(release, true);
            await secure(binaryPath);
            await secure(join(release, "provenance.json"));
            await secure(join(release, "manifest.json"));
        }
        const value: unknown = JSON.parse(
            await readFile(
                managed ? join(release, "provenance.json") : legacyProvenance,
                "utf8",
            ),
        );
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
                hash(await readFile(join(release, "manifest.json"))) !==
                    value.runtimeManifestSha256)
        )
            throw new Error(
                "Runtime manifest differs from its release provenance",
            );
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
): Promise<PrivateRuntimeComponent> {
    if (
        !record(value) ||
        !onlyKeys(value, ["root", "files"]) ||
        !Array.isArray(value.files)
    )
        throw new Error("Invalid component manifest");
    const componentRoot = child(root, value.root);
    await secure(componentRoot, true);
    if ((await realpath(componentRoot)) !== componentRoot)
        throw new Error(
            "Component root redirects outside its recorded location",
        );
    const files: PrivateRuntimeComponent["files"] = [];
    const declared = new Set<string>();
    for (const item of value.files) {
        if (!record(item) || !onlyKeys(item, ["path", "sha256", "symlink"]))
            throw new Error("Invalid component entry");
        const path = child(componentRoot, item.path);
        const name = relative(componentRoot, path);
        if (declared.has(name)) throw new Error("Duplicate component entry");
        declared.add(name);
        if ((await realpath(dirname(path))) !== dirname(path))
            throw new Error("Component entry has a redirected parent");
        if (digest(item.sha256) && item.symlink === undefined) {
            await secure(path);
            if (hash(await readFile(path)) !== item.sha256)
                throw new Error(`Runtime file digest mismatch: ${name}`);
            files.push({ path: name, sha256: item.sha256 });
        } else if (
            typeof item.symlink === "string" &&
            item.sha256 === undefined
        ) {
            const link = await readlink(path);
            if (
                link !== item.symlink ||
                isAbsolute(link) ||
                !contained(componentRoot, resolve(dirname(path), link)) ||
                !contained(componentRoot, await realpath(path))
            )
                throw new Error(
                    `Runtime symlink leaves its component: ${name}`,
                );
            files.push({ path: name, symlink: link });
        } else
            throw new Error(
                "Runtime entry requires exactly one digest or symlink",
            );
    }
    async function checkListed(directory: string): Promise<void> {
        for (const item of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, item.name);
            if (item.isDirectory()) {
                await secure(path, true);
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
    try {
        const binaryPath = await realpath(options.binaryPath);
        await secure(binaryPath);
        if (((await lstat(binaryPath)).mode & 0o111) === 0)
            throw new Error("Runtime executable lacks execute permission");
        if (hash(await readFile(binaryPath)) !== options.expectedBinarySha256)
            throw new Error("Runtime executable digest mismatch");
        const root = options.bundlePath
            ? resolve(options.bundlePath)
            : dirname(dirname(binaryPath));
        await secure(root, true);
        if ((await realpath(root)) !== root)
            throw new Error(
                "Bundle root redirects outside its recorded location",
            );
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
        await secure(manifestPath);
        const bytes = await readFile(manifestPath);
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
        await secure(helper);
        if (
            (await realpath(helper)) !== helper ||
            hash(await readFile(helper)) !== manifest.helper.sha256
        )
            throw new Error("Runtime helper digest mismatch");
        const [shell, analysis] = await Promise.all([
            tree(root, manifest.components.shell),
            tree(root, manifest.components.analysis),
        ]);
        for (const command of ["bin/bash", "bin/env"])
            if (!shell.files.some((file) => file.path === command))
                throw new Error(`Private shell command missing: ${command}`);
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
        throw new SandboxExecutionError("provenance-mismatch", {
            diagnostic:
                error instanceof Error
                    ? error.message
                    : "Runtime verification failed",
            cause: error,
        });
    }
}
