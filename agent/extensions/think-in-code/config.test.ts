import { describe, expect, it } from "bun:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

import {
    DEFAULT_THINK_IN_CODE_CONFIG,
    hashProjectPath,
    loadThinkInCodeConfig,
    normalizeThinkInCodeConfig,
    resolveProjectStorePath,
    resolveThinkInCodeRoot,
} from "./config";

describe("think-in-code config", () => {
    it("returns defaults for unknown input shapes", () => {
        const normalized = normalizeThinkInCodeConfig("not a config");
        expect(normalized).toEqual(DEFAULT_THINK_IN_CODE_CONFIG);
    });

    it("clamps retention, quota, and snippet sizes downward", () => {
        const normalized = normalizeThinkInCodeConfig({
            retentionHours: 96,
            projectQuotaBytes: 4 * 1024 ** 3,
            restoreTokenBudget: 10_000,
            searchSnippetChars: 4096,
            indexedSnippetChars: 8192,
            maxResultBytes: 1024 * 1024,
            batchConcurrency: 16,
            maxBatchCommands: 64,
        });
        expect(normalized.retentionHours).toBe(24);
        expect(normalized.projectQuotaBytes).toBe(512 * 1024 * 1024);
        expect(normalized.restoreTokenBudget).toBe(1500);
        expect(normalized.searchSnippetChars).toBe(240);
        expect(normalized.indexedSnippetChars).toBe(1024);
        expect(normalized.maxResultBytes).toBe(64 * 1024);
        expect(normalized.batchConcurrency).toBe(2);
        expect(normalized.maxBatchCommands).toBe(16);
    });

    it("falls back to defaults when values are malformed", () => {
        const normalized = normalizeThinkInCodeConfig({
            retentionHours: -3,
            projectQuotaBytes: "huge",
            restoreTokenBudget: 1.5,
            searchSnippetChars: null,
            batchConcurrency: Number.NaN,
            maxBatchCommands: Number.POSITIVE_INFINITY,
        });
        expect(normalized.retentionHours).toBe(24);
        expect(normalized.projectQuotaBytes).toBe(512 * 1024 * 1024);
        expect(normalized.restoreTokenBudget).toBe(1500);
        expect(normalized.searchSnippetChars).toBe(240);
        expect(normalized.batchConcurrency).toBe(2);
        expect(normalized.maxBatchCommands).toBe(16);
    });

    it("filters unknown languages and falls back to the default set", () => {
        const normalized = normalizeThinkInCodeConfig({
            languages: ["javascript", "ruby", "typescript"],
        });
        expect(normalized.languages).toEqual(["javascript", "typescript"]);
    });

    it("always disables network access regardless of input", () => {
        const normalized = normalizeThinkInCodeConfig({
            network: true as unknown as false,
        });
        expect(normalized.network).toBe(false);
    });

    it("owns an independent deny-default command policy and telemetry", () => {
        const normalized = normalizeThinkInCodeConfig({
            commandPolicy: {
                guardPolicy: { sudo: "allow", unknown: "allow" },
                allowedShellCommands: ["grep", 42],
                rewrites: [
                    {
                        match: "^npm test$",
                        rewrite: "bun test",
                        tools: ["think_execute", "bash"],
                    },
                ],
            },
            telemetry: {
                enabled: false,
                retentionDays: 7,
                captureCommand: false,
                maxCommandLength: 500,
                auditDays: 5,
                auditLimit: 20,
            },
        });

        expect(normalized.commandPolicy).toEqual({
            guardPolicy: { sudo: "allow" },
            allowedShellCommands: ["grep"],
            rewrites: [
                {
                    match: "^npm test$",
                    rewrite: "bun test",
                    tools: ["think_execute"],
                },
            ],
        });
        expect(normalized.telemetry).toMatchObject({
            enabled: false,
            retentionDays: 7,
            captureCommand: false,
            maxCommandLength: 500,
            auditDays: 5,
            auditLimit: 20,
        });
    });

    it("never widens the fixed Think audit bounds", () => {
        const normalized = normalizeThinkInCodeConfig({
            telemetry: {
                retentionDays: 31,
                maxCommandLength: 10_001,
                auditDays: 31,
                auditLimit: 101,
            },
        });

        expect(normalized.telemetry.retentionDays).toBe(30);
        expect(normalized.telemetry.maxCommandLength).toBe(10_000);
        expect(normalized.telemetry.auditDays).toBe(30);
        expect(normalized.telemetry.auditLimit).toBe(100);
    });

    it("never falls back to safeBash policy", () => {
        const settings = {
            getGlobalSettings: () => ({
                safeBash: {
                    guardPolicy: { sudo: "allow" },
                    allowedShellCommands: ["grep"],
                },
            }),
            getProjectSettings: () => ({}),
        } as unknown as SettingsManager;

        const loaded = loadThinkInCodeConfig(
            "/workspace/project",
            undefined,
            settings,
        );

        expect(loaded.commandPolicy).toEqual(
            DEFAULT_THINK_IN_CODE_CONFIG.commandPolicy,
        );
    });

    it("loads downward project overlays through the shared verified loader", () => {
        const settings = {
            getGlobalSettings: () => ({
                thinkInCode: { maxResultBytes: 8192, batchConcurrency: 1 },
            }),
            getProjectSettings: () => ({
                thinkInCode: { maxResultBytes: 4096, batchConcurrency: 99 },
            }),
        } as unknown as SettingsManager;
        const loaded = loadThinkInCodeConfig("/workspace/project", undefined, settings);
        expect(loaded.maxResultBytes).toBe(4096);
        expect(loaded.batchConcurrency).toBe(2);
    });

    it("merges partial project policy and telemetry overlays without resetting global fields", () => {
        const settings = {
            getGlobalSettings: () => ({
                thinkInCode: {
                    commandPolicy: {
                        allowedShellCommands: ["grep"],
                        rewrites: [
                            {
                                match: "^npm test$",
                                rewrite: "bun test",
                                tools: ["think_execute"],
                            },
                        ],
                    },
                    telemetry: { retentionDays: 7, captureCommand: false },
                },
            }),
            getProjectSettings: () => ({
                thinkInCode: {
                    commandPolicy: { guardPolicy: { sudo: "allow" } },
                    telemetry: { auditLimit: 25 },
                },
            }),
        } as unknown as SettingsManager;

        const loaded = loadThinkInCodeConfig(
            "/workspace/project",
            undefined,
            settings,
        );

        expect(loaded.commandPolicy.allowedShellCommands).toEqual(["grep"]);
        expect(loaded.commandPolicy.guardPolicy).toEqual({ sudo: "allow" });
        expect(loaded.commandPolicy.rewrites).toHaveLength(1);
        expect(loaded.telemetry.retentionDays).toBe(7);
        expect(loaded.telemetry.captureCommand).toBe(false);
        expect(loaded.telemetry.auditLimit).toBe(25);
    });

    it("places the project store under the resolved home root", () => {
        const root = resolveThinkInCodeRoot("/tmp/fake-home");
        expect(root).toBe("/tmp/fake-home/.pi/agent/think-in-code");
        const projectPath = resolveProjectStorePath("/workspace/foo", {
            home: "/tmp/fake-home",
        });
        expect(projectPath.startsWith(root + "/projects/")).toBe(true);
        const expectedHash = hashProjectPath("/workspace/foo");
        expect(projectPath.endsWith(`/projects/${expectedHash}`)).toBe(true);
    });

    it("produces deterministic hashes for identical canonical paths", () => {
        expect(hashProjectPath("/workspace/foo")).toBe(
            hashProjectPath("/workspace/foo"),
        );
        expect(hashProjectPath("/workspace/foo")).not.toBe(
            hashProjectPath("/workspace/bar"),
        );
    });

    it("falls back to defaults when the global settings manager is unavailable", () => {
        const settings = {
            getGlobalSettings: () => {
                throw new Error("settings unavailable");
            },
            getProjectSettings: () => ({}),
        } as unknown as SettingsManager;
        const loaded = loadThinkInCodeConfig("/workspace/project", undefined, settings);
        expect(loaded).toEqual(DEFAULT_THINK_IN_CODE_CONFIG);
    });

    it("clamps each overlay key independently and never widens a hard ceiling", () => {
        const settings = {
            getGlobalSettings: () => ({
                thinkInCode: {
                    retentionHours: 9999,
                    projectQuotaBytes: 9999 * 1024 ** 2,
                    restoreTokenBudget: 9999,
                    searchSnippetChars: 9999,
                    indexedSnippetChars: 9999,
                    maxResultBytes: 9999 * 1024,
                    batchConcurrency: 9999,
                    maxBatchCommands: 9999,
                },
            }),
            getProjectSettings: () => ({}),
        } as unknown as SettingsManager;
        const loaded = loadThinkInCodeConfig("/workspace/project", undefined, settings);
        expect(loaded.retentionHours).toBe(24);
        expect(loaded.projectQuotaBytes).toBe(512 * 1024 * 1024);
        expect(loaded.restoreTokenBudget).toBe(1500);
        expect(loaded.searchSnippetChars).toBe(240);
        expect(loaded.indexedSnippetChars).toBe(1024);
        expect(loaded.maxResultBytes).toBe(64 * 1024);
        expect(loaded.batchConcurrency).toBe(2);
        expect(loaded.maxBatchCommands).toBe(16);
    });
});
