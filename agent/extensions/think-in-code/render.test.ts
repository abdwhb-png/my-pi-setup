import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
    renderThinkArtifactSearchResult,
    renderThinkExecuteCall,
    renderThinkExecuteResult,
} from "./render.ts";

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

function rendered(component: { render(width: number): string[] }): string {
    return component.render(160).join("\n");
}

describe("Think TUI rendering", () => {
    it("shows compact execution metadata from content without details", () => {
        const component = renderThinkExecuteResult(
            {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: "partial",
                            action: "batch",
                            sourceStatus: "mixed",
                            sourceBytes: 2048,
                            resultBytes: 512,
                            truncated: true,
                            archiveIds: ["archive-one", "archive-two"],
                            indexStatus: "indexed",
                            total: 3,
                            succeeded: 2,
                            failed: 1,
                            blocked: 0,
                        }),
                    },
                    { type: "text", text: "bounded derivation" },
                ],
            },
            { expanded: false },
            theme,
            {},
            24,
        );

        const output = rendered(component);
        expect(output).toContain("partial · batch · batch 2/3");
        expect(output).toContain("2.0 Kio → 512 o");
        expect(output).toContain("2 archives · indexé · expiration ≤24h");
        expect(output).toContain("tronqué");
        expect(output).not.toContain("bounded derivation");
    });

    it("shows the bounded derivation when expanded but never result details", () => {
        const component = renderThinkExecuteResult(
            {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: "success",
                            action: "file",
                            sourceStatus: "succeeded",
                            sourceBytes: 42,
                            resultBytes: 7,
                            truncated: false,
                            archiveIds: ["archive-one"],
                            indexStatus: "indexed",
                        }),
                    },
                    { type: "text", text: "derived" },
                ],
                details: { rawOutput: "RAW_SECRET_SOURCE" },
            },
            { expanded: true },
            theme,
            {},
            24,
        );

        const output = rendered(component);
        expect(output).toContain("success · file");
        expect(output).toContain("derived");
        expect(output).not.toContain("RAW_SECRET_SOURCE");
    });

    it("makes a non-fatal indexing failure visible", () => {
        const component = renderThinkExecuteResult(
            {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: "success",
                            action: "content",
                            sourceStatus: "succeeded",
                            sourceBytes: 4,
                            resultBytes: 2,
                            truncated: false,
                            archiveIds: ["archive-one"],
                            indexStatus: "failed",
                        }),
                    },
                    { type: "text", text: "ok" },
                ],
                details: { indexWarnings: [] },
            },
            { expanded: false },
            theme,
            {},
            24,
        );

        expect(rendered(component)).toContain("indexation échouée");
    });

    it("does not claim indexing succeeded for a legacy header", () => {
        const component = renderThinkExecuteResult(
            {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            status: "success",
                            action: "content",
                            sourceStatus: "succeeded",
                            sourceBytes: 4,
                            resultBytes: 2,
                            truncated: false,
                            archiveIds: [],
                        }),
                    },
                    { type: "text", text: "ok" },
                ],
            },
            { expanded: false },
            theme,
            {},
            24,
        );

        const output = rendered(component);
        expect(output).toContain("indexation inconnue");
        expect(output).not.toContain("· indexé ·");
    });

    it("shows artifact-search failures as errors", () => {
        const component = renderThinkArtifactSearchResult(
            {
                content: [
                    {
                        type: "text",
                        text: `Error: ${JSON.stringify({
                            tool: "think_artifact_search",
                            status: "error",
                            stage: "store",
                            code: "artifact-search-failed",
                            reason: "Artifact search unavailable",
                            recovery: "repair_store",
                        })}`,
                    },
                ],
            },
            { expanded: true },
            theme,
            {},
            24,
        );

        const output = rendered(component);
        expect(output).toContain(
            "✗ recherche d’artefacts · artifact-search-failed",
        );
        expect(output).toContain("récupération: repair_store");
        expect(output).not.toContain("✓ recherche");
    });

    it("shows safe error code and recovery without details", () => {
        const component = renderThinkExecuteResult(
            {
                content: [
                    {
                        type: "text",
                        text: `Error: ${JSON.stringify({
                            tool: "think_execute",
                            status: "error",
                            action: "command",
                            stage: "source",
                            code: "setup-failed",
                            reason: "Sandbox unavailable",
                            recovery: "restore_sandbox",
                        })}`,
                    },
                ],
            },
            { expanded: true },
            theme,
            {},
            24,
        );

        const output = rendered(component);
        expect(output).toContain("error · command · source · setup-failed");
        expect(output).toContain("récupération: restore_sandbox");
        expect(output).toContain("Sandbox unavailable");
    });

    it("shows analyzer language and program in the call view", () => {
        const component = renderThinkExecuteCall(
            {
                action: "content",
                language: "python",
                program: "result = len(INPUT)",
                content: "RAW_SECRET_SOURCE",
            },
            theme,
            {},
        );

        const output = rendered(component);
        expect(output).toContain("Think Execute · content");
        expect(output).toContain("analyseur: python");
        expect(output).toContain("result = len(INPUT)");
        expect(output).not.toContain("RAW_SECRET_SOURCE");
    });
});
