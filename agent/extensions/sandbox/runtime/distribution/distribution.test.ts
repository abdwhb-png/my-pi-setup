import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("./", import.meta.url);
const builder = new URL("./build.py", root).pathname;
const { stageRuntimeRelease } = await import("./stage-release.ts");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
    const parent = await mkdtemp(join(tmpdir(), "pi-runtime-distribution-"));
    const candidate = join(parent, "candidate");
    for (const [path, value] of Object.entries({
        "bin/zerobox": "engine",
        "helper/zerobox-linux-sandbox": "helper",
        "components/shell/bin/bash": "bash",
        "components/shell/bin/env": "env",
        "components/analysis/bin/node": "node",
    })) {
        const target = join(candidate, path);
        await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true, mode: 0o755 });
        await writeFile(target, value, { mode: 0o700 });
    }
    await writeFile(join(candidate, "manifest.json"), JSON.stringify({
        schema: 1, version: "test", target: "x86_64-unknown-linux-gnu",
        helper: { path: "helper/zerobox-linux-sandbox", sha256: sha("helper") },
        components: {
            shell: { root: "components/shell", files: [{ path: "bin/bash", sha256: sha("bash") }, { path: "bin/env", sha256: sha("env") }] },
            analysis: { root: "components/analysis", files: [{ path: "bin/node", sha256: sha("node") }] },
        },
    }), { mode: 0o600 });
    const provenance = join(parent, "provenance.json");
    await writeFile(provenance, JSON.stringify({ version: "test", binarySha256: sha("engine") }), { mode: 0o600 });
    const entry = join(parent, "bin", "zerobox");
    await mkdir(join(parent, "bin"), { recursive: true, mode: 0o755 });
    await writeFile(entry, "previous", { mode: 0o700 });
    return { parent, candidate, entry, provenance };
}

test("preserves relative runtime symlinks when staging the verified tree",async()=>{
    const f=await fixture();
    try{
        await symlink("bash",join(f.candidate,"components/shell/bin/sh"));
        const manifest=await Bun.file(join(f.candidate,"manifest.json")).json();
        manifest.components.shell.files.push({path:"bin/sh",symlink:"bash"});
        await writeFile(join(f.candidate,"manifest.json"),JSON.stringify(manifest));
        const release=await stageRuntimeRelease({candidateRoot:f.candidate,runtimeBase:join(f.parent,"runtimes"),managedBinary:f.entry,provenanceSource:f.provenance,expectedBinarySha256:sha("engine")});
        expect(await readlink(join(release,"components/shell/bin/sh"))).toBe("bash");
    }finally{await rm(f.parent,{recursive:true,force:true});}
});

test("stages sealed provenance without modifying the candidate", async () => {
    const f = await fixture();
    try {
        const source = await readFile(f.provenance, "utf8");
        await writeFile(join(f.candidate, "provenance.json"), source);
        await chmod(join(f.candidate, "provenance.json"), 0o444);
        const release = await stageRuntimeRelease({ candidateRoot: f.candidate, runtimeBase: join(f.parent, "runtimes"), managedBinary: f.entry, provenanceSource: f.provenance, expectedBinarySha256: sha("engine") });
        expect(await Bun.file(join(release, "provenance.json")).json()).toMatchObject({ runtimeVersion: "test" });
        expect(await readFile(join(f.candidate, "provenance.json"), "utf8")).toBe(source);
        expect((await lstat(join(f.candidate, "provenance.json"))).mode & 0o777).toBe(0o444);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("rejects a tampered locked build input before assembly", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-runtime-inputs-"));
    try {
        await writeFile(join(parent, "asset"), "tampered");
        await writeFile(join(parent, "lock.json"), JSON.stringify({
            schema: 1, image: "ubuntu@sha256:a61567bd31828687156d735ea8eb01ba4e37636e225dd6a48ba94136a70d9d61",
            files: [{ path: "asset", sha256: sha("expected") }],
        }));
        const result = Bun.spawnSync(["python3", builder, "verify-inputs", "--lock", join(parent, "lock.json"), "--input-root", parent]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain("digest mismatch");
    } finally { await rm(parent, { recursive: true, force: true }); }
});

test("rejects durable metadata that escapes the distribution directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-runtime-metadata-"));
    try {
        const lock = join(parent, "lock.json");
        await writeFile(lock, JSON.stringify({
            schema: 1,
            image: "ubuntu@sha256:a61567bd31828687156d735ea8eb01ba4e37636e225dd6a48ba94136a70d9d61",
            metadata: { packages: { path: "../input-lock.json", sha256: "0".repeat(64) } },
            files: [],
        }));
        const result = Bun.spawnSync(["python3", builder, "verify-inputs", "--lock", lock, "--input-root", parent]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain("input escapes cache");
    } finally { await rm(parent, { recursive: true, force: true }); }
});

test("leaves the managed entry unpublished when candidate validation fails", async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.candidate, "components/shell/bin/bash"), "tampered");
        await expect(stageRuntimeRelease({ candidateRoot: f.candidate, runtimeBase: join(f.parent, "runtimes"), managedBinary: f.entry, provenanceSource: f.provenance, expectedBinarySha256: sha("engine") })).rejects.toThrow();
        expect((await lstat(f.entry)).isFile()).toBe(true);
        expect(await Bun.file(f.entry).text()).toBe("previous");
        await expect(Bun.file(join(f.parent, "runtimes", "zerobox", "test", "manifest.json")).exists()).resolves.toBe(false);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("rejects an unlisted component before publishing a release", async () => {
    const f = await fixture();
    try {
        const extra = join(f.candidate, "components", "other", "payload");
        await mkdir(join(f.candidate, "components", "other"), { recursive: true });
        await writeFile(extra, "unexpected");
        await expect(stageRuntimeRelease({ candidateRoot: f.candidate, runtimeBase: join(f.parent, "runtimes"), managedBinary: f.entry, provenanceSource: f.provenance, expectedBinarySha256: sha("engine") })).rejects.toThrow("Unlisted runtime component");
        expect((await lstat(f.entry)).isFile()).toBe(true);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("rejects a release version that could escape the versioned destination", async () => {
    const f = await fixture();
    try {
        const manifest = JSON.parse(await readFile(join(f.candidate, "manifest.json"), "utf8"));
        manifest.version = "../escape";
        await writeFile(join(f.candidate, "manifest.json"), JSON.stringify(manifest));
        await expect(stageRuntimeRelease({ candidateRoot: f.candidate, runtimeBase: join(f.parent, "runtimes"), managedBinary: f.entry, provenanceSource: f.provenance, expectedBinarySha256: sha("engine") })).rejects.toThrow();
        expect((await lstat(f.entry)).isFile()).toBe(true);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("rejects a symlinked release destination before creating a staging copy", async () => {
    const f = await fixture();
    try {
        const outside = join(f.parent, "outside");
        await mkdir(outside);
        await symlink(outside, join(f.parent, "runtimes"));
        await expect(stageRuntimeRelease({ candidateRoot: f.candidate, runtimeBase: join(f.parent, "runtimes"), managedBinary: f.entry, provenanceSource: f.provenance, expectedBinarySha256: sha("engine") })).rejects.toThrow("Untrusted release directory");
        expect(await Bun.file(join(outside, "zerobox", "test", "manifest.json")).exists()).toBe(false);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("preserves the rebuilt engine version while recording the runtime release version", async () => {
    const f = await fixture();
    try {
        const manifest = JSON.parse(await readFile(join(f.candidate, "manifest.json"), "utf8"));
        manifest.version = "2026.09.12.2";
        await writeFile(join(f.candidate, "manifest.json"), JSON.stringify(manifest));
        await writeFile(f.provenance, JSON.stringify({ version: "0.3.3-fork.17", binarySha256: sha("engine") }));

        const release = await stageRuntimeRelease({ candidateRoot: f.candidate, runtimeBase: join(f.parent, "runtimes"), managedBinary: f.entry, provenanceSource: f.provenance, expectedBinarySha256: sha("engine") });
        expect(await Bun.file(join(release, "provenance.json")).json()).toMatchObject({
            version: "0.3.3-fork.17",
            runtimeVersion: "2026.09.12.2",
            binarySha256: sha("engine"),
        });
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("publishes a verified versioned release atomically and preserves recovery", async () => {
    const f = await fixture();
    try {
        const release = await stageRuntimeRelease({ candidateRoot: f.candidate, runtimeBase: join(f.parent, "runtimes"), managedBinary: f.entry, provenanceSource: f.provenance, previousProvenanceSource: f.provenance, expectedBinarySha256: sha("engine") });
        expect(release).toBe(join(f.parent, "runtimes", "zerobox", "test"));
        expect(await readlink(f.entry)).toBe(join(release, "bin/zerobox"));
        expect(await Bun.file(join(release, "provenance.json")).json()).toMatchObject({ version: "test", binarySha256: sha("engine"), runtimeManifestSha256: sha(await Bun.file(join(release, "manifest.json")).text()), helperSha256: sha("helper") });
        const recovery = join(f.parent, "runtimes", "zerobox", "recovery");
        const [snapshot] = await readdir(recovery);
        expect(await Bun.file(join(recovery, snapshot!, "zerobox")).text()).toBe("previous");
        expect(await Bun.file(join(recovery, snapshot!, "provenance.json")).json()).toEqual({ version: "test", binarySha256: sha("engine") });
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});
