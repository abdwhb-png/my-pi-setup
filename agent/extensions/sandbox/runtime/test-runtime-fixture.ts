import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Filesystem fixture only. Tests substitute the external engine process. */
export async function createRuntimeBundleFixture(
    binaryPath: string,
    version: string,
) {
    const root = dirname(binaryPath);
    const sha = (bytes: Uint8Array | string) =>
        createHash("sha256").update(bytes).digest("hex");
    for (const path of [
        "helper",
        "components/shell/bin",
        "components/analysis",
    ])
        await mkdir(join(root, path), { recursive: true });
    for (const [name, bytes] of Object.entries({
        "helper/zerobox-linux-sandbox": "helper",
        "components/shell/bin/bash": "bash",
        "components/shell/bin/env": "env",
    }))
        await writeFile(join(root, name), bytes, { mode: 0o755 });
    await writeFile(
        join(root, "manifest.json"),
        JSON.stringify({
            schema: 1,
            target: "x86_64-unknown-linux-gnu",
            version,
            helper: {
                path: "helper/zerobox-linux-sandbox",
                sha256: sha("helper"),
            },
            components: {
                shell: {
                    root: "components/shell",
                    files: [
                        { path: "bin/bash", sha256: sha("bash") },
                        { path: "bin/env", sha256: sha("env") },
                    ],
                },
                analysis: { root: "components/analysis", files: [] },
            },
        }),
    );
    return {
        runtimeBundlePath: root,
        expectedProvenance: {
            version,
            binarySha256: sha(await readFile(binaryPath)),
        },
    };
}
