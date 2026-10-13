import { expect, spyOn, test } from "bun:test";
import {
    createHash,
    type Hash,
    type BinaryLike,
    type Encoding,
} from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePrivateRuntime } from "./runtime-bundle.ts";
import { createRuntimeBundleFixture } from "./test-runtime-fixture.ts";

const MiB = 1024 * 1024;
const io: {
    readFile: (
        ...args: Parameters<typeof fs.readFile>
    ) => ReturnType<typeof fs.readFile>;
} = fs;
const digest = (data: Buffer) =>
    createHash("sha256").update(data).digest("hex");
async function fixture(target: "engine" | "helper" | "analysis" = "analysis") {
    const root = await mkdtemp(join(tmpdir(), "pi-chunked-"));
    try {
        const binaryPath = join(root, "zerobox");
        await writeFile(binaryPath, "fixture engine", { mode: 0o700 });
        const bundleFixture = await createRuntimeBundleFixture(
            binaryPath,
            "fixture-version",
        );
        const manifest = JSON.parse(
            await readFile(join(root, "manifest.json"), "utf8"),
        );
        const bytes = Buffer.alloc(3 * MiB + 19, 0x7b);
        bytes[bytes.length - 1] = 0xe7;
        const path =
            target === "engine"
                ? binaryPath
                : target === "helper"
                  ? join(root, manifest.helper.path)
                  : join(root, "components/analysis/bin/node");
        await mkdir(join(root, "components/analysis/bin"), {
            recursive: true,
            mode: 0o700,
        });
        await writeFile(path, bytes, { mode: 0o700 });
        if (target === "engine")
            bundleFixture.expectedProvenance.binarySha256 = digest(bytes);
        else if (target === "helper") manifest.helper.sha256 = digest(bytes);
        else
            manifest.components.analysis.files = [
                { path: "bin/node", sha256: digest(bytes) },
            ];
        await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
        return {
            root,
            path,
            bytes,
            options: {
                binaryPath,
                expectedBinarySha256:
                    bundleFixture.expectedProvenance.binarySha256,
                bundlePath: bundleFixture.runtimeBundlePath,
            },
        };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

test("a large distribution file is fully verified without whole-file reads or hash updates above one MiB", async () => {
    const f = await fixture();
    const prototype: Pick<
        ReturnType<typeof createHash>,
        "update"
    > = Object.getPrototypeOf(createHash("sha256"));
    const originalUpdate = prototype.update;
    let maxBytes = 0;
    const update = spyOn(prototype, "update").mockImplementation(function (
        this: Hash,
        data: BinaryLike,
        encoding?: Encoding,
    ) {
        maxBytes = Math.max(
            maxBytes,
            typeof data === "string"
                ? Buffer.byteLength(data)
                : data.byteLength,
        );
        return Reflect.apply(originalUpdate, this, [data, encoding]);
    });
    const read = spyOn(io, "readFile");
    try {
        const runtime = await resolvePrivateRuntime(f.options);
        expect(runtime.components.analysis.files).toHaveLength(1);
        expect(maxBytes).toBeLessThanOrEqual(MiB);
        expect(
            read.mock.calls.filter(([path]) => String(path) === f.path),
        ).toHaveLength(0);
    } finally {
        read.mockRestore();
        update.mockRestore();
        await rm(f.root, { recursive: true, force: true });
    }
});

test.each(["engine", "helper", "analysis"] as const)(
    "large %s integrity includes a short final block",
    async (target) => {
        const f = await fixture(target);
        try {
            await resolvePrivateRuntime(f.options);
            f.bytes[f.bytes.length - 1] ^= 0xff;
            await writeFile(f.path, f.bytes);
            await expect(
                resolvePrivateRuntime(f.options),
            ).rejects.toMatchObject({ code: "provenance-mismatch" });
        } finally {
            await rm(f.root, { recursive: true, force: true });
        }
    },
);

test("cancelling a large file drains its read and descriptor before rejecting", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("large file cancelled");
    const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    const closeEntered = Promise.withResolvers<void>(),
        releaseClose = Promise.withResolvers<void>();
    const originalOpen = fs.open;
    let readCalls = 0,
        settled = false,
        handle: FileHandle | undefined;
    let pending: Promise<unknown> | undefined;
    const open = spyOn(fs, "open").mockImplementation(
        async (path, flags, mode) => {
            const file = await originalOpen(path, flags, mode);
            if (String(path) === f.path) {
                handle = file;
                const originalRead = file.read;
                const originalClose = file.close;
                const handleIo: {
                    read: (
                        ...args: Parameters<typeof file.read>
                    ) => ReturnType<typeof file.read>;
                } = file;
                spyOn(handleIo, "read").mockImplementation(async (...args) => {
                    readCalls++;
                    entered.resolve();
                    await release.promise;
                    return Reflect.apply(originalRead, file, args);
                });
                spyOn(file, "close").mockImplementation(async () => {
                    closeEntered.resolve();
                    await releaseClose.promise;
                    await originalClose.call(file);
                });
            }
            return file;
        },
    );
    try {
        pending = resolvePrivateRuntime({
            ...f.options,
            signal: controller.signal,
        }).then(
            (value) => {
                settled = true;
                return value;
            },
            (error) => {
                settled = true;
                return error;
            },
        );
        await entered.promise;
        controller.abort(reason);
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        release.resolve();
        await closeEntered.promise;
        expect(settled).toBe(false);
        releaseClose.resolve();
        expect(await pending).toBe(reason);
        expect(readCalls).toBe(1);
        expect(handle?.fd).toBe(-1);
    } finally {
        release.resolve();
        releaseClose.resolve();
        await pending;
        open.mockRestore();
        await rm(f.root, { recursive: true, force: true });
    }
});

test("a large-file I/O failure closes its descriptor and stays an explicit integrity failure", async () => {
    const f = await fixture();
    const originalOpen = fs.open;
    let handle: FileHandle | undefined;
    const open = spyOn(fs, "open").mockImplementation(
        async (path, flags, mode) => {
            const file = await originalOpen(path, flags, mode);
            if (String(path) === f.path) {
                handle = file;
                spyOn(file, "read").mockRejectedValue(
                    new Error("fixture read failure"),
                );
            }
            return file;
        },
    );
    try {
        await expect(resolvePrivateRuntime(f.options)).rejects.toMatchObject({
            code: "provenance-mismatch",
            cause: { message: "fixture read failure" },
        });
        expect(handle?.fd).toBe(-1);
    } finally {
        open.mockRestore();
        await rm(f.root, { recursive: true, force: true });
    }
});
