import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config.ts";
import { ThinkStore } from "./store.ts";

const nodeProbe = fileURLToPath(new URL("./testing/cross-runtime-node.mjs", import.meta.url));

test("Bun and Node reopen one project store and search each other's artifacts", () => {
    const home = mkdtempSync(join(tmpdir(), "think-cross-runtime-"));
    const storeRoot = join(home, "project-store");
    const env = {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, "agent"),
    };
    function runNode(mode: string, root: string, archiveId = "") {
        const child = spawnSync("node", [nodeProbe, mode, root, archiveId], {
            env,
            encoding: "utf8",
            timeout: 30_000,
        });
        if (child.error) throw child.error;
        expect(child.status, child.stderr + child.stdout).toBe(0);
        return JSON.parse(child.stdout.trim()) as Record<string, string | boolean>;
    }
    let store: ThinkStore | undefined;
    try {
        store = new ThinkStore({
            config: DEFAULT_THINK_IN_CODE_CONFIG,
            storeRoot,
            canonicalPath: "/probe/project",
            now: () => 1_700_000_000_000,
        });
        const node = runNode("write", storeRoot);
        expect(store.search("alpha-2847", 5)).toHaveLength(1);
        expect(store.search('"quoted phrase"', 5)).toHaveLength(1);
        expect(store.readArchives([node.archiveId as string], 1024)[0]?.data).toBe("node original content");

        const bunArchive = store.archive({ kind: "command-output", data: "bun original content" });
        store.index({
            kind: "command-summary",
            source: "bun fixture",
            text: "bun-token-5111 search value",
            archiveIds: [bunArchive.id],
        });
        expect(statSync(bunArchive.archivePath).mode & 0o777).toBe(0o600);
        expect(runNode("read", storeRoot, bunArchive.id).read).toBe(true);
        expect(runNode("rollback", join(home, "rollback-store")).rolledBack).toBe(true);
    } finally {
        store?.close();
        rmSync(home, { recursive: true, force: true });
    }
}, 20_000);
