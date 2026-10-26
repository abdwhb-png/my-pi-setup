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
    it("keeps derived prose unchanged while rendering English interface text", () => {
        const output = rendered(renderThinkArtifactSearchResult({
            content: [{ type: "text", text: "Résultat conservé en français" }],
        }, { expanded: true }, theme, {}, 24));
        expect(output).toContain("artifact search");
        expect(output).toContain("Résultat conservé en français");
        expect(rendered(renderThinkExecuteResult({ content: [] }, { expanded: false }, theme, {}, 24)))
            .toContain("Unreadable Think result");
        expect(rendered(renderThinkArtifactSearchResult({ content: [] }, { expanded: true }, theme, {}, 24)))
            .toContain("No readable result");
    });

    it("uses an English notice when the displayed program is bounded", () => {
        expect(rendered(renderThinkExecuteCall({ action: "content", language: "javascript", program: "x".repeat(300) }, theme, {})))
            .toContain("120 characters hidden");
    });

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
        expect(output).toContain("2.0 KiB → 512 B");
        expect(output).toContain("2 archives · indexed · expiration ≤24h");
        expect(output).toContain("truncated");
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

        expect(rendered(component)).toContain("indexing failed");
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
        expect(output).toContain("indexing unknown");
        expect(output).not.toContain("· indexed ·");
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
            "✗ artifact search · artifact-search-failed",
        );
        expect(output).toContain("recovery: repair_store");
        expect(output).not.toContain("✓ artifact search");
    });

    it("shows safe error reason and recovery in the collapsed view", () => {
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
            { expanded: false },
            theme,
            {},
            24,
        );

        const output = rendered(component);
        expect(output).toContain("error · command · source · setup-failed");
        expect(output).toContain("recovery: restore_sandbox");
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
        expect(output).toContain("analyzer: python");
        expect(output).toContain("result = len(INPUT)");
        expect(output).not.toContain("RAW_SECRET_SOURCE");
    });
});
