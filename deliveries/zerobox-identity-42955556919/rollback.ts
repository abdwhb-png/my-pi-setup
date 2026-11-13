// Run with Bun to restore the exact runtime preceding this delivery.
import { readFile, symlink, rename, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
const pi = join(homedir(), ".pi");
const { acquireRuntimeStorageLock } = await import(join(pi, "agent/extensions/_shared/runtime-storage.ts"));
const { resolvePrivateRuntime } = await import(join(pi, "agent/extensions/sandbox/runtime/runtime-bundle.ts"));
const { expandHomePath } = await import(join(pi, "agent/extensions/_shared/home-path.ts"));
const record = JSON.parse(await readFile(join(import.meta.dir, "activation.json"), "utf8"));
record.previous = expandHomePath(record.previous);
record.installed = expandHomePath(record.installed);
const entry = join(pi, "bin/zerobox"), next = entry + ".identity-rollback.next";
const lock = acquireRuntimeStorageLock(pi);
try {
    if (dirname(dirname(realpathSync(entry))) !== record.installed) throw new Error("Current runtime changed; rollback refused.");
    for (const root of [record.previous, record.installed]) {
        const provenance = JSON.parse(await readFile(join(root, "provenance.json"), "utf8"));
        await resolvePrivateRuntime({ binaryPath: join(root, "bin/zerobox"), bundlePath: root, expectedBinarySha256: provenance.binarySha256 });
    }
    const previous = join(pi, "runtimes/zerobox/.previous");
    await symlink(record.installed, next);
    await rename(next, previous);
    await symlink(join(record.previous, "bin/zerobox"), next);
    await rename(next, entry);
    console.log("Restored", record.previous, "— restart Pi sessions to use it.");
} finally {
    await rm(next, { force: true });
    lock.release();
}
