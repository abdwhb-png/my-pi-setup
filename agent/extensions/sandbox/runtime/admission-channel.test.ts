import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createPrivateTempLease } from "./private-temp.ts";
import { createZeroboxAdmissionChannel } from "./status-channel.ts";

test("a dedicated admission descriptor is drained and invalid child data is rejected", async () => {
    const parent = await mkdtemp(join(tmpdir(), "z-"));
    const lease = await createPrivateTempLease({rootDir: join(parent, "r")});
    const channel = await createZeroboxAdmissionChannel(lease);
    try {
        const child = spawn(process.execPath, ["-e", "require('node:fs').writeSync(4, '{}'); require('node:fs').closeSync(4)"], {stdio:["ignore", "ignore", "pipe", "ignore", channel.childStdio]});
        const closed = new Promise(resolve => child.once("close", resolve));
        await expect(channel.read()).rejects.toMatchObject({code:"protocol-error"});
        expect(await closed).toBe(0);
    } finally { await channel.dispose(); await lease.dispose(); await rm(parent,{recursive:true,force:true}); }
});
