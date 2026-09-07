import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
