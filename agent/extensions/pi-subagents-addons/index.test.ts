import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSubagentToolSelection } from "pi-subagents/tool-selection";
import registerSubagentsAddons, { readAddonsConfig } from "./index";

it("registers group selection before a native child is planned", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-group-selection-"));
    const configPath = join(root, "config.json");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        writeFileSync(configPath, JSON.stringify({ fallbackAdvice: { enabled: false } }));
        writeFileSync(join(root, "tool-groups.json"), JSON.stringify({ groups: { inspect: ["read", "grep"] } }));
        const pi = {
            on: (event: string, callback: (...args: unknown[]) => unknown) => { hooks.set(event, callback); },
            getAllTools: () => [{ name: "read" }, { name: "grep" }],
        } as unknown as ExtensionAPI;
        registerSubagentsAddons(pi, configPath);
        writeFileSync(join(root, "tool-groups.json"), JSON.stringify({ groups: { inspect: ["ls"] } }));
        expect(resolveSubagentToolSelection({ tools: ["@inspect"] })).toEqual(["read", "grep"]);
    } finally {
        hooks.get("session_shutdown")?.();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root, { recursive: true, force: true });
    }
});

it("keeps optional addons disabled while registering child tool selection", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-disabled-"));
    const path = join(root, "config.json");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let dispose: (() => void) | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        writeFileSync(path, JSON.stringify({ subagentWaitGuard: { enabled: false }, piSubagentsOverview: { enabled: false }, fallbackAdvice: { enabled: false } }));
        const calls: string[] = [];
        const pi = new Proxy({}, { get: (_target, property) => property === "events"
            ? { on: (channel: string) => calls.push(channel) }
            : (name: string, callback?: () => void) => {
                calls.push(name);
                if (name === "session_shutdown") dispose = callback;
            } }) as ExtensionAPI;
        registerSubagentsAddons(pi, path);
        expect(calls).toEqual(["session_shutdown"]);
    } finally {
        dispose?.();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root, { recursive: true, force: true });
    }
});

it("loads and validates enabled advice from an isolated config, without changing child models", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-addons-"));
    const path = join(root, "config.json");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let dispose: (() => void) | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        writeFileSync(path, JSON.stringify({ fallbackAdvice: { enabled: true, fallbackModels: { worker: ["p/second", "p/third"] } } }));
        expect(readAddonsConfig(path).fallbackAdvice.fallbackModels.worker).toEqual(["p/second", "p/third"]);
        const hooks: string[] = [];
        const pi = new Proxy({}, { get: (_target, property) => property === "events"
            ? { on: (channel: string) => hooks.push(channel) }
            : (name: string, callback?: () => void) => {
                hooks.push(name);
                if (name === "session_shutdown") dispose = callback;
            } }) as ExtensionAPI;
        registerSubagentsAddons(pi, path);
        expect(hooks).toContain("tool_result");
        expect(hooks).toContain("before_provider_request");
        writeFileSync(path, JSON.stringify({ fallbackAdvice: { enabled: true, fallbackModels: { worker: ["p/second", "p/second"] } } }));
        expect(() => readAddonsConfig(path)).toThrow();
        writeFileSync(path, "{");
        expect(() => readAddonsConfig(path)).toThrow();
    } finally {
        dispose?.();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root, { recursive: true, force: true });
    }
});
