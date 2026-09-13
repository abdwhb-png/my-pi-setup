import { createHash, randomUUID } from "node:crypto";
import {
    access,
    copyFile,
    cp,
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolvePrivateRuntime } from "../runtime-bundle.ts";

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
        if (await exists(entry)) {
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
        }
        pending = `${entry}.${randomUUID()}.next`;
        await symlink(join(releaseRoot, "bin/zerobox"), pending);
        await rename(pending, entry);
        pending = undefined;
        return releaseRoot;
    } catch (error) {
        if (pending) await rm(pending, { force: true });
        await rm(temporary, { recursive: true, force: true });
        throw error;
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
