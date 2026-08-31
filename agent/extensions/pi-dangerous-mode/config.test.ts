import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const paths: string[] = [];
afterEach(() => {
    for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(prefix: string): string {
    const path = mkdtempSync(join(tmpdir(), prefix));
    paths.push(path);
    return path;
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
}

describe("pi-dangerous-mode configuration", () => {
    it("loads only Dangerous protection lists and merges project overrides", () => {
        const agentDir = directory("dangerous-agent-");
        const cwd = directory("dangerous-cwd-");
        writeJson(join(agentDir, "pi-dangerous-mode.json"), {
            protectedTools: ["safe_bash"],
            protectedExtensions: ["permission-system"],
        });
        writeJson(join(cwd, ".pi", "pi-dangerous-mode.json"), {
            protectedTools: ["bash"],
        });

        expect(loadConfig(cwd, agentDir)).toEqual({
            protectedTools: ["bash"],
            protectedExtensions: ["permission-system"],
        });
    });

    it("rejects malformed protection lists", () => {
        const agentDir = directory("dangerous-agent-");
        const cwd = directory("dangerous-cwd-");
        writeJson(join(agentDir, "pi-dangerous-mode.json"), {
            protectedTools: ["bash", 42],
        });
        expect(() => loadConfig(cwd, agentDir)).toThrow("Invalid configuration");
    });
});
