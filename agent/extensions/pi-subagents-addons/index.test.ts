import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentsAddons, { readAddonsConfig } from "./index";

it("keeps disabled addons inert regardless of personal config", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-disabled-"));
    const path = join(root, "config.json");
    try {
        writeFileSync(path, JSON.stringify({ subagentWaitGuard: { enabled: false }, piSubagentsOverview: { enabled: false }, fallbackAdvice: { enabled: false } }));
        const calls: string[] = [];
        const pi = new Proxy({}, { get: (_target, property) => property === "events"
            ? { on: (channel: string) => calls.push(channel) }
            : (name: string) => calls.push(name) }) as ExtensionAPI;
        registerSubagentsAddons(pi, path);
        expect(calls).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("loads and validates enabled advice from an isolated config, without changing child models", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-addons-"));
    const path = join(root, "config.json");
    try {
        writeFileSync(path, JSON.stringify({ fallbackAdvice: { enabled: true, fallbackModels: { worker: ["p/second", "p/third"] } } }));
        expect(readAddonsConfig(path).fallbackAdvice.fallbackModels.worker).toEqual(["p/second", "p/third"]);
        const hooks: string[] = [];
        const pi = new Proxy({}, { get: (_target, property) => property === "events"
            ? { on: (channel: string) => hooks.push(channel) }
            : (name: string) => hooks.push(name) }) as ExtensionAPI;
        registerSubagentsAddons(pi, path);
        expect(hooks).toContain("tool_result");
        expect(hooks).toContain("before_provider_request");
        writeFileSync(path, JSON.stringify({ fallbackAdvice: { enabled: true, fallbackModels: { worker: ["p/second", "p/second"] } } }));
        expect(() => readAddonsConfig(path)).toThrow();
        writeFileSync(path, "{");
        expect(() => readAddonsConfig(path)).toThrow();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
