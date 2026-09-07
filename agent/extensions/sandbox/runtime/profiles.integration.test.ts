import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createSandboxedBashOps } from "../index.ts";
import { createBashProcessSupervisor } from "../../_shared/command-execution/exec.ts";
import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { createPrivateTempLease } from "./private-temp.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createSandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";

test("development shares host tmp while both Think profiles isolate it and sibling leases", async () => {
    const cwd = await mkdtemp(join(import.meta.dir, ".tmp-profiles-"));
    const hostTmp = await mkdtemp("/tmp/pi-host-contract-");
    const sibling = await createPrivateTempLease();
    const service = createSandboxService({
        backend: createZeroboxBackend(),
        config: validatePiSandboxConfig({ filesystem: { allowWrite: ["."] } }),
    });
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    try {
        await writeFile(join(hostTmp, "from-host"), "from host");
        await service.startBashSession(cwd);
        for (const profile of ["bash-general", "think-strict", "analysis-strict"] as const) {
            const events: object[] = [];
            let dispose: (() => Promise<void>) | undefined;
            const operations = createBashOperations({
                onExecution: event => events.push(event),
                prepareSpawn: async ({ command }) => {
                    const input = { file: "/bin/bash", args: ["-c", command], cwd };
                    if (profile === "bash-general") return service.prepareBash(input);
                    if (profile === "think-strict") return service.prepareThinkBash(input);
                    const handle = await service.prepareAnalysis(input, ["/bin/bash", "/usr/bin"]);
                    dispose = () => handle.dispose();
                    return handle.spawn;
                },
                afterClose: async () => { await dispose?.(); },
            });
            const command = profile === "bash-general"
                ? `test "$(cat ${quote(join(hostTmp, "from-host"))})" = 'from host' && printf 'from shell' > ${quote(join(hostTmp, "from-shell"))}`
                : `test "$TMPDIR" = /tmp && test ! -e ${quote(join(hostTmp, "from-host"))} && test ! -e ${quote(sibling.markerPath)} && printf private > /tmp/own && test "$(cat /tmp/own)" = private`;
            let output = "";
            const result = await operations.exec(command, cwd, {
                onData: (chunk) => { output += chunk.toString(); }, timeout: 10,
            });
            expect(result.exitCode, `${profile}: ${output}`).toBe(0);
            expect(events.at(-1)).toMatchObject({
                status: "sandboxed", profile, backend: "zerobox", outcome: "succeeded", exitCode: 0,
                tmpNamespace: profile === "bash-general" ? "host" : "lease-private",
            });
        }
        expect(await readFile(join(hostTmp, "from-shell"), "utf8")).toBe("from shell");
    } finally {
        await service.shutdown();
        await sibling.dispose();
        await rm(hostTmp, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("development resolves home-relative project paths without granting home writes", async () => {
    const cwd = await mkdtemp(join(import.meta.dir, ".tmp-home-"));
    const outside = join(homedir(), `.pi-home-write-probe-${process.pid}`);
    const service = createSandboxService({ backend: createZeroboxBackend(), config: validatePiSandboxConfig({ filesystem: { allowWrite: ["."], denyRead: [join(cwd, "denied.txt")] } }) });
    const supervisor = createBashProcessSupervisor();
    try {
        await writeFile(join(cwd, "denied.txt"), "private fixture");
        await service.startBashSession(cwd);
        const operations = createSandboxedBashOps(service, supervisor);
        let output = "";
        const command = `cd ~/${relative(homedir(), cwd)} && printf '%s' "$PWD"`;
        const result = await operations.exec(command, cwd, { timeout: 10, onData: chunk => { output += chunk.toString(); } });
        expect({ code: result.exitCode, output }).toEqual({ code: 0, output: cwd });
        const cache = await operations.exec('test -n "$XDG_CACHE_HOME" && test -n "$BUN_INSTALL_CACHE_DIR" && test -n "$npm_config_cache" && mkdir -p "$XDG_CACHE_HOME" "$BUN_INSTALL_CACHE_DIR" "$npm_config_cache" && printf cache > "$XDG_CACHE_HOME/probe"', cwd, { timeout: 10, onData: () => {} });
        expect(cache.exitCode).toBe(0);
        for (const blocked of [`printf forbidden > ${outside}`, "cat denied.txt"]) {
            const denied = await operations.exec(blocked, cwd, { timeout: 10, onData: () => {} });
            expect(denied.exitCode).not.toBe(0);
        }
    } finally {
        supervisor.shutdown();
        await service.shutdown();
        await rm(cwd, { recursive: true, force: true });
        await rm(outside, { force: true });
    }
}, 30_000);

test("Sandbox shell reports an upstream failure even when the final pipeline command succeeds", async () => {
    const service = createSandboxService({ backend: createZeroboxBackend(), config: validatePiSandboxConfig({}) });
    const supervisor = createBashProcessSupervisor();
    try {
        await service.startBashSession(import.meta.dir);
        const events: object[] = [];
        const operations = createSandboxedBashOps(service, supervisor, { onExecution: value => events.push(value) });
        const result = await operations.exec("(printf failed; exit 7) | tail -n 1", import.meta.dir, { timeout: 10, onData: () => {} });
        expect(result.exitCode).toBe(7);
        expect(events.at(-1)).toMatchObject({ outcome: "failed", exitCode: 7 });
    } finally { supervisor.shutdown(); await service.shutdown(); }
}, 30_000);
