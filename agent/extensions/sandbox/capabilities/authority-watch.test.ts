import { afterEach, expect, mock, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorityWatch, type AuthoritySnapshot } from "./authority-watch.ts";

interface WatchFixture {
    configPath: string;
}

const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
});

function mkFixture(): WatchFixture {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-authority-watch-"));
    fixtureRoots.push(root);
    const configPath = join(root, "authority.json");
    return { configPath };
}

function writeSnapshot(path: string, snapshot: AuthoritySnapshot | string): void {
    const payload = typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
    writeFileSync(path, payload, "utf8");
}

function readSnapshot(path: string): AuthoritySnapshot {
    return JSON.parse(readFileSync(path, "utf8")) as AuthoritySnapshot;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("reads on a periodic interval as fallback while active", async () => {
    const { configPath } = mkFixture();
    const initial: AuthoritySnapshot = { key: "project", grants: ["read", "write"] };
    writeSnapshot(configPath, initial);

    let readCount = 0;
    const read = mock(async () => {
        readCount += 1;
        return readSnapshot(configPath);
    });

    const onRevoked = mock(async () => {});
    const watch = createAuthorityWatch({
        paths: [configPath],
        read,
        onRevoked,
        hasActiveProcesses: () => true,
    });

    await wait(1250);
    await watch.check();
    expect(readCount).toBeGreaterThanOrEqual(2);
    expect(onRevoked).not.toHaveBeenCalled();

    watch.close();
});

test("triggers revocation when grants are narrowed and updates from additive changes", async () => {
    const { configPath } = mkFixture();
    const readFile = () => readSnapshot(configPath);
    const initial: AuthoritySnapshot = {
        key: "project",
        grants: ["install", "network"],
    };
    const narrowed: AuthoritySnapshot = {
        key: "project",
        grants: ["install"],
    };
    const expanded: AuthoritySnapshot = {
        key: "project",
        grants: ["install", "network", "path"],
    };

    writeSnapshot(configPath, initial);

    const onRevoked = mock(async () => {});
    const watch = createAuthorityWatch({
        paths: [configPath],
        read: async () => readFile(),
        onRevoked,
        hasActiveProcesses: () => false,
    });

    await watch.check();
    writeSnapshot(configPath, narrowed);
    await watch.check();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    await watch.check();
    expect(onRevoked).toHaveBeenCalledTimes(1);

    writeSnapshot(configPath, expanded);
    await watch.check();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(readSnapshot(configPath)).toEqual(expanded);

    watch.close();
});

test("periodic checks stay idle when no processes retain permissions", async()=>{
 const read=mock(async()=>({key:"same",grants:[]}));
 const watch=createAuthorityWatch({paths:[],read,onRevoked:async()=>{},hasActiveProcesses:()=>false});
 await watch.check();const initial=read.mock.calls.length;
 await wait(1100);expect(read.mock.calls.length).toBe(initial);watch.close();
});

test("invalid read always triggers revocation and does not prevent later additive reads", async () => {
    const { configPath } = mkFixture();
    const initial: AuthoritySnapshot = {
        key: "project",
        grants: ["a", "b"],
    };
    const replaced: AuthoritySnapshot = {
        key: "project",
        grants: ["a", "b", "c"],
    };

    writeSnapshot(configPath, initial);
    const onRevoked = mock(async () => {});
    const watch = createAuthorityWatch({
        paths: [configPath],
        read: async () => {
            return readSnapshot(configPath);
        },
        onRevoked,
        hasActiveProcesses: () => false,
    });

    await watch.check();
    writeSnapshot(configPath, "{ invalid json");
    await watch.check();
    expect(onRevoked).toHaveBeenCalledTimes(1);

    writeSnapshot(configPath, replaced);
    await watch.check();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(onRevoked).toHaveBeenLastCalledWith(expect.any(Error));
    expect(readSnapshot(configPath)).toEqual(replaced);

    watch.close();
});

test("serializes checks so next check waits for onRevoked completion", async () => {
    const { configPath } = mkFixture();
    writeSnapshot(configPath, JSON.stringify({ key: "project", grants: ["a"] }));
    let releaseRevocation: () => void = () => {};
    const revocationGate = new Promise<void>((resolve) => {
        releaseRevocation = resolve;
    });
    const read = mock(async () => {
        return readSnapshot(configPath);
    });
    const onRevoked = mock(async () => {
        await revocationGate;
    });
    const watch = createAuthorityWatch({
        paths: [configPath],
        read,
        onRevoked,
        hasActiveProcesses: () => false,
    });

    await watch.check();
    writeSnapshot(configPath, JSON.stringify({
        key: "project",
        grants: [],
    }));

    const first = watch.check();
    const second = watch.check();

    const unresolved = await Promise.race([
        second.then(() => "done"),
        wait(120).then(() => "timeout"),
    ]);

    expect(unresolved).toBe("timeout");
    releaseRevocation();
    await Promise.all([first, second]);
    watch.close();
});

test("passes reason when authority is revoked while processes are active", async () => {
    const { configPath } = mkFixture();
    writeSnapshot(configPath, JSON.stringify({ key: "project", grants: ["a", "b"] }));
    let observedReason: Error | undefined;
    const onRevoked = mock(async (reason: Error | undefined) => {
        observedReason = reason;
    });
    const watch = createAuthorityWatch({
        paths: [configPath],
        read: async () => readSnapshot(configPath),
        onRevoked,
        hasActiveProcesses: () => true,
    });

    await wait(10);
    writeSnapshot(configPath, JSON.stringify({ key: "project", grants: ["a"] }));
    await watch.check();
    expect(observedReason).toBeInstanceOf(Error);
    expect(observedReason?.message).toBe(
        "Authority was revoked while active processes are running",
    );

    watch.close();
});

test("close stops periodic checks and watchers", async () => {
    const { configPath } = mkFixture();
    writeSnapshot(configPath, JSON.stringify({ key: "project", grants: ["a"] }));

    let readCount = 0;
    const watch = createAuthorityWatch({
        paths: [configPath],
        read: async () => {
            readCount += 1;
            return readSnapshot(configPath);
        },
        onRevoked: async () => {},
        hasActiveProcesses: () => false,
    });

    await wait(1300);
    watch.close();
    const beforeCloseCount = readCount;

    writeSnapshot(configPath, JSON.stringify({ key: "project", grants: ["a", "b"] }));
    await wait(1200);

    expect(readCount).toBe(beforeCloseCount);
});
