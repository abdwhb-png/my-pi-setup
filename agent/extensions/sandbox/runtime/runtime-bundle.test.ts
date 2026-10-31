import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { PathLike, ObjectEncodingOptions, OpenMode } from "node:fs";
import type { Abortable } from "node:events";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, writeFile, rm, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePrivateRuntime, readPrivateRuntimeEntry } from "./runtime-bundle.ts";
import type { PrivateRuntimeComponent } from "./runtime-bundle.ts";

// Use the filesystem's union signatures so spies preserve both text and binary reads.
const io: {
    readFile: (path: PathLike | fs.FileHandle, options?: (ObjectEncodingOptions & Abortable & { flag?: OpenMode }) | BufferEncoding | null) => Promise<string | Buffer>;
    realpath: (...args: Parameters<typeof fs.realpath>) => ReturnType<typeof fs.realpath>;
} = fs;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(analysisFileCount = 1) {
 const parent=await mkdtemp(join(tmpdir(), "bundle-"));
 const root=join(parent,"runtimes/zerobox/test");
 for (const dir of ["bin", "helper", "components/shell/bin", "components/analysis/bin"]) await mkdir(join(root,dir),{recursive:true,mode:0o700});
 const files={"bin/zerobox":"engine", "helper/zerobox-linux-sandbox":"helper", "components/shell/bin/bash":"bash", "components/shell/bin/env":"env", "components/analysis/bin/node":"node"};
 for (const [path,content] of Object.entries(files)) await writeFile(join(root,path),content,{mode:0o700});
 const shell: PrivateRuntimeComponent = {root:"components/shell",files:[{path:"bin/bash",sha256:sha("bash")},{path:"bin/env",sha256:sha("env")}]};
 const analysis: PrivateRuntimeComponent = {root:"components/analysis",files:[{path:"bin/node",sha256:sha("node")}]};
 for (let i = 1; i < analysisFileCount; i++) {
  const path = `bin/file-${i}`;
  await writeFile(join(root, analysis.root, path), path, {mode: 0o600});
  analysis.files.push({path, sha256: sha(path)});
 }
 const manifest={schema:1,target:"x86_64-unknown-linux-gnu",version:"test",helper:{path:"helper/zerobox-linux-sandbox",sha256:sha("helper")},components:{shell,analysis}};
 await writeFile(join(root,"manifest.json"),JSON.stringify(manifest),{mode:0o600});
 await mkdir(join(parent,"bin"));
 const entry=join(parent,"bin/zerobox"); await symlink(join(root,"bin/zerobox"),entry);
 return {parent,root,entry,manifest};
}
test("a managed entry pins the real bundle and validates its complete distribution",async()=>{
 const f=await fixture();try {
  const runtime=await resolvePrivateRuntime({binaryPath:f.entry,expectedBinarySha256:sha("engine")});
  expect(runtime.root).toBe(f.root);
  expect(runtime.binaryPath).toBe(join(f.root,"bin/zerobox"));
  expect(runtime.manifestSha256).toBe(sha(JSON.stringify(f.manifest)));
  expect(runtime.components.shell.root).toBe(join(f.root,"components/shell"));
 }finally{await rm(f.parent,{recursive:true,force:true});}
});
test("tampering, undeclared files, missing libraries and foreign releases block admission",async()=>{
 for(const change of [async(f:Awaited<ReturnType<typeof fixture>>)=>writeFile(join(f.root,"components/shell/bin/bash"),"changed"), async(f:Awaited<ReturnType<typeof fixture>>)=>writeFile(join(f.root,"components/shell/bin/extra"),"extra"), async(f:Awaited<ReturnType<typeof fixture>>)=>rm(join(f.root,"components/shell/bin/env")),async(f:Awaited<ReturnType<typeof fixture>>)=>writeFile(join(f.root,"manifest.json"),JSON.stringify({...f.manifest,target:"aarch64-unknown-linux-gnu"}))]) {
  const f=await fixture();try{await change(f);await expect(resolvePrivateRuntime({binaryPath:f.entry,expectedBinarySha256:sha("engine")})).rejects.toMatchObject({code:"provenance-mismatch"});}finally{await rm(f.parent,{recursive:true,force:true});}
 }
});
test("pins a managed entry with its adjacent provenance and rejects unsafe release identifiers",async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,"provenance.json"),JSON.stringify({version:"engine-test",binarySha256:sha("engine"),runtimeManifestSha256:sha(JSON.stringify(f.manifest)),helperSha256:sha("helper")}),{mode:0o600});
  const pinned=await readPrivateRuntimeEntry(f.entry,new URL("file:///missing-legacy-provenance"));
  expect(pinned.binaryPath).toBe(join(f.root,"bin/zerobox"));expect(pinned.provenance.version).toBe("engine-test");
  await rm(f.entry);await symlink("/tmp/unrelated-engine",f.entry);
  expect(await resolvePrivateRuntime({binaryPath:pinned.binaryPath,expectedBinarySha256:pinned.provenance.binarySha256})).toMatchObject({version:"test"});
  await writeFile(join(f.root,"manifest.json"),JSON.stringify({...f.manifest,version:"../../escape"}));
  await expect(resolvePrivateRuntime({binaryPath:pinned.binaryPath,expectedBinarySha256:sha("engine")})).rejects.toMatchObject({code:"provenance-mismatch"});
 }finally{await rm(f.parent,{recursive:true,force:true});}
});

test("distribution metadata rejects unknown components and redirected manifest files",async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,"manifest.json"),JSON.stringify({...f.manifest,components:{...f.manifest.components,extra:{root:"components/analysis",files:[]}}}));
  await expect(resolvePrivateRuntime({binaryPath:f.entry,expectedBinarySha256:sha("engine")})).rejects.toMatchObject({code:"provenance-mismatch"});
  const manifestPath=join(f.root,"manifest.json");await rm(manifestPath);
  const external=join(f.parent,"external-manifest");await writeFile(external,JSON.stringify(f.manifest));await symlink(external,manifestPath);
  await writeFile(join(f.root,"provenance.json"),JSON.stringify({version:"engine-test",binarySha256:sha("engine"),runtimeManifestSha256:sha(JSON.stringify(f.manifest)),helperSha256:sha("helper")}),{mode:0o600});
  await expect(readPrivateRuntimeEntry(f.entry,new URL("file:///unused"))).rejects.toMatchObject({code:"provenance-mismatch"});
 }finally{await rm(f.parent,{recursive:true,force:true});}
});

test("verifies files concurrently within a fixed bound and preserves manifest order", async () => {
    const f = await fixture(17);
    const release = Promise.withResolvers<void>();
    const occupied = Promise.withResolvers<void>();
    const tail = Promise.withResolvers<void>();
    const originalRead = fs.readFile;
    let pending: ReturnType<typeof resolvePrivateRuntime> | undefined;
    let interception: ReturnType<typeof spyOn<typeof io, "readFile">> | undefined;
    let active = 0;
    let peak = 0;
    try {
        interception = spyOn(io, "readFile").mockImplementation(async (path, options) => {
            if (!String(path).startsWith(join(f.root, "components/analysis") + "/"))
                return originalRead(path, options);
            active++;
            peak = Math.max(peak, active);
            if (active === 8) occupied.resolve();
            try {
                await release.promise;
                if (String(path).endsWith("/bin/node")) await tail.promise;
                const bytes = await originalRead(path, options);
                if (String(path).endsWith("/bin/file-16")) tail.resolve();
                return bytes;
            } finally { active--; }
        });
        pending = resolvePrivateRuntime({ binaryPath: f.entry, expectedBinarySha256: sha("engine") });
        // The timer only detects a deadlocked serial reader; it does not measure throughput.
        const ready = await Promise.race([occupied.promise.then(() => true), Bun.sleep(1000).then(() => false)]);
        expect(ready).toBe(true);
        release.resolve();
        const runtime = await pending;
        expect(peak).toBe(8);
        expect(active).toBe(0);
        expect(runtime.components.analysis.files).toEqual(f.manifest.components.analysis.files);
    } finally {
        release.resolve();
        tail.resolve();
        await pending?.catch(() => {});
        interception?.mockRestore();
        await rm(f.parent, { recursive: true, force: true });
    }
});

test("entry resolution preserves cancellation before any filesystem work", async () => {
    const controller = new AbortController();
    const reason = new Error("entry cancelled");
    controller.abort(reason);
    const canonical = spyOn(io, "realpath");
    try {
        await expect(readPrivateRuntimeEntry("/missing-entry", new URL("file:///unused"), controller.signal)).rejects.toBe(reason);
        expect(canonical).not.toHaveBeenCalled();
    } finally { canonical.mockRestore(); }
});

test("entry cancellation reaches a pending provenance read and prevents manifest reads", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("entry cancelled during read");
    const originalRead = fs.readFile;
    let read: ReturnType<typeof spyOn<typeof io, "readFile">> | undefined;
    let pending: Promise<unknown> | undefined;
    let receivedSignal: AbortSignal | undefined;
    try {
        await writeFile(join(f.root, "provenance.json"), JSON.stringify({ version: "test", binarySha256: sha("engine"), runtimeManifestSha256: sha(JSON.stringify(f.manifest)), helperSha256: sha("helper") }), { mode: 0o600 });
        read = spyOn(io, "readFile").mockImplementation(async (path, options) => {
            if (String(path) === join(f.root, "provenance.json")) {
                receivedSignal = typeof options === "object" ? options?.signal : undefined;
                entered.resolve();
                await release.promise;
            }
            return originalRead(path, options);
        });
        pending = readPrivateRuntimeEntry(f.entry, new URL("file:///unused"), controller.signal).catch(error => error);
        await entered.promise;
        controller.abort(reason);
        release.resolve();
        expect(await pending).toBe(reason);
        expect(receivedSignal).toBe(controller.signal);
        expect(read.mock.calls.filter(([path]) => String(path) === join(f.root, "manifest.json"))).toHaveLength(0);
    } finally {
        release.resolve();
        await pending;
        read?.mockRestore();
        await rm(f.parent, { recursive: true, force: true });
    }
});

test("cancellation between filesystem operations prevents the next file read", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("verification cancelled");
    const originalRealpath = fs.realpath;
    const read = spyOn(io, "readFile");
    const parent = join(f.root, "components/analysis/bin");
    const canonical = spyOn(io, "realpath").mockImplementation(async (path, options) => {
        const result = await originalRealpath(path, options);
        if (String(path) === parent) controller.abort(reason);
        return result;
    });
    try {
        await expect(resolvePrivateRuntime({ binaryPath: f.entry, expectedBinarySha256: sha("engine"), signal: controller.signal })).rejects.toBe(reason);
        expect(read.mock.calls.filter(([path]) => String(path).startsWith(parent + "/"))).toHaveLength(0);
    } finally {
        canonical.mockRestore();
        read.mockRestore();
        await rm(f.parent, { recursive: true, force: true });
    }
});

test("cancellation reaches active reads and drains them before rejecting", async () => {
    const f = await fixture(12);
    const controller = new AbortController();
    const reason = new Error("verification cancelled");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalRead = fs.readFile;
    const paths: string[] = [];
    let active = 0;
    let settled = false;
    let pending: Promise<unknown> | undefined;
    const read = spyOn(io, "readFile").mockImplementation(async (path, options) => {
        if (!String(path).startsWith(join(f.root, "components/analysis") + "/")) return originalRead(path, options);
        paths.push(String(path));
        active++;
        if (active === 8) entered.resolve();
        try {
            // Keep the I/O unsettled even after abort to exercise draining.
            await release.promise;
            return await originalRead(path, options);
        } finally { active--; }
    });
    try {
        pending = resolvePrivateRuntime({ binaryPath: f.entry, expectedBinarySha256: sha("engine"), signal: controller.signal }).then(
            value => { settled = true; return value; },
            error => { settled = true; return error; },
        );
        await entered.promise;
        controller.abort(reason);
        await new Promise(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(active).toBe(8);
        expect(read.mock.calls.filter(([path]) => paths.includes(String(path))).every(([, options]) => typeof options === "object" && options?.signal === controller.signal)).toBe(true);
        release.resolve();
        expect(await pending).toBe(reason);
        expect(active).toBe(0);
        expect(paths).toHaveLength(8);
    } finally {
        release.resolve();
        await pending;
        read.mockRestore();
        await rm(f.parent, { recursive: true, force: true });
    }
});

test("an already cancelled resolution performs no filesystem work", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    const canonical = spyOn(io, "realpath");
    try {
        await expect(resolvePrivateRuntime({ binaryPath: "/unused", expectedBinarySha256: sha("engine"), signal: controller.signal })).rejects.toBe(reason);
        expect(canonical).not.toHaveBeenCalled();
    } finally { canonical.mockRestore(); }
});

test("an integrity failure stops new work, drains active reads and reports the earliest manifest failure", async () => {
    const f = await fixture(12);
    const entered = Promise.withResolvers<void>();
    const releaseLater = Promise.withResolvers<void>();
    const laterReturned = Promise.withResolvers<void>();
    const releaseOthers = Promise.withResolvers<void>();
    const originalRead = fs.readFile;
    const paths: string[] = [];
    const earlier = join(f.root, "components/analysis/bin/node");
    const later = join(f.root, "components/analysis/bin/file-1");
    let active = 0;
    let settled = false;
    let pending: Promise<unknown> | undefined;
    let read: ReturnType<typeof spyOn<typeof io, "readFile">> | undefined;
    try {
        await writeFile(earlier, "tampered");
        await writeFile(later, "tampered");
        read = spyOn(io, "readFile").mockImplementation(async (path, options) => {
            if (!String(path).startsWith(join(f.root, "components/analysis") + "/")) return originalRead(path, options);
            paths.push(String(path));
            active++;
            if (active === 8) entered.resolve();
            try {
                const bytes = await originalRead(path, options);
                await (String(path) === later ? releaseLater.promise : releaseOthers.promise);
                return bytes;
            } finally {
                active--;
                if (String(path) === later) laterReturned.resolve();
            }
        });
        pending = resolvePrivateRuntime({ binaryPath: f.entry, expectedBinarySha256: sha("engine") }).then(
            value => { settled = true; return value; },
            error => { settled = true; return error; },
        );
        await entered.promise;
        releaseLater.resolve();
        await laterReturned.promise;
        await new Promise(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(active).toBe(7);
        expect(paths).toHaveLength(8);
        releaseOthers.resolve();
        expect(await pending).toMatchObject({ code: "provenance-mismatch", cause: { message: "Runtime file digest mismatch: bin/node" } });
        expect(paths).toHaveLength(8);
        expect(active).toBe(0);
    } finally {
        releaseLater.resolve();
        releaseOthers.resolve();
        await pending;
        read?.mockRestore();
        await rm(f.parent, { recursive: true, force: true });
    }
});

const integrityCases: {
    name: string;
    change: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>;
    diagnostic: RegExp;
}[] = [
    { name: "duplicate entries", change: async f => { f.manifest.components.analysis.files.push(f.manifest.components.analysis.files[0]); }, diagnostic: /Duplicate component entry/ },
    { name: "unsafe relative paths", change: async f => { f.manifest.components.analysis.files[0].path = "../outside"; }, diagnostic: /safe relative path/ },
    { name: "ambiguous entry types", change: async f => { f.manifest.components.analysis.files[0].symlink = "node"; }, diagnostic: /exactly one digest or symlink/ },
    { name: "unlisted files", change: async f => { await writeFile(join(f.root, "components/analysis/bin/unlisted"), "extra", { mode: 0o600 }); }, diagnostic: /Unlisted runtime file/ },
    { name: "writable files", change: async f => { await chmod(join(f.root, "components/analysis/bin/node"), 0o666); }, diagnostic: /Untrusted distribution path/ },
    { name: "writable parent directories", change: async f => { await chmod(join(f.root, "components/analysis/bin"), 0o777); }, diagnostic: /Untrusted distribution path/ },
    { name: "redirected parents", change: async f => {
        await rename(join(f.root, "components/analysis/bin"), join(f.root, "components/analysis/actual-bin"));
        await symlink("actual-bin", join(f.root, "components/analysis/bin"));
    }, diagnostic: /redirected parent/ },
    { name: "escaping symlinks", change: async f => {
        await writeFile(join(f.root, "outside"), "outside", { mode: 0o600 });
        await symlink("../../../outside", join(f.root, "components/analysis/bin/link"));
        f.manifest.components.analysis.files.push({ path: "bin/link", symlink: "../../../outside" });
    }, diagnostic: /symlink leaves its component/ },
    { name: "absolute symlinks within the component", change: async f => {
        const target = join(f.root, "components/analysis/bin/node");
        await symlink(target, join(f.root, "components/analysis/bin/link"));
        f.manifest.components.analysis.files.push({ path: "bin/link", symlink: target });
    }, diagnostic: /symlink leaves its component/ },
    { name: "changed symlink targets", change: async f => {
        await symlink("node", join(f.root, "components/analysis/bin/link"));
        f.manifest.components.analysis.files.push({ path: "bin/link", symlink: "other" });
    }, diagnostic: /symlink leaves its component/ },
];

test.each(integrityCases)("complete verification rejects $name", async ({ change, diagnostic }) => {
    const f = await fixture();
    try {
        await change(f);
        await writeFile(join(f.root, "manifest.json"), JSON.stringify(f.manifest));
        await expect(resolvePrivateRuntime({ binaryPath: f.entry, expectedBinarySha256: sha("engine") })).rejects.toMatchObject({ code: "provenance-mismatch", message: expect.stringMatching(diagnostic) });
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test("complete verification retains valid internal symlinks in manifest order", async () => {
    const f = await fixture();
    try {
        await symlink("node", join(f.root, "components/analysis/bin/link"));
        f.manifest.components.analysis.files.unshift({ path: "bin/link", symlink: "node" });
        await writeFile(join(f.root, "manifest.json"), JSON.stringify(f.manifest));
        const runtime = await resolvePrivateRuntime({ binaryPath: f.entry, expectedBinarySha256: sha("engine") });
        expect(runtime.components.analysis.files).toEqual(f.manifest.components.analysis.files);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
});
