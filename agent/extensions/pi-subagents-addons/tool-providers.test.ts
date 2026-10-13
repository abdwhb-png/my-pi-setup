import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import { collectToolProviders } from "./tool-providers.ts";

const source = (path: string, scope: SourceInfo["scope"] = "user"): SourceInfo => ({ path, scope, source: "fixture", origin: "top-level" });

test("groups canonical global tool owners and excludes project, synthetic, and coordination providers", () => {
    const root = mkdtempSync(join(tmpdir(), "global-tool-provenance-"));
    try {
        const native = join(root, "subagents");
        mkdirSync(native);
        const provider = join(root, "provider.ts"), alias = join(root, "alias.ts"), own = join(native, "index.ts"), adjacent = join(root, "subagents-extra.ts");
        for (const file of [provider, own, adjacent]) writeFileSync(file, "export default () => {};");
        writeFileSync(join(root, "aliases-only.ts"), "export default () => {};");
        symlinkSync(provider, alias);
        const tools = [
            { name: "inspect_z", sourceInfo: source(alias) },
            { name: "inspect_a", sourceInfo: source(provider) },
            { name: "inspect_a", sourceInfo: source(provider) },
            { name: "read", sourceInfo: source(provider) },
            { name: "@inspect", sourceInfo: source(provider) },
            { name: "@aliases_only", sourceInfo: source(join(root, "aliases-only.ts")) },
            { name: "adjacent", sourceInfo: source(adjacent) },
            { name: "subagent", sourceInfo: source(own) },
            { name: "project", sourceInfo: source(provider, "project") },
            { name: "temporary", sourceInfo: source(provider, "temporary") },
            { name: "builtin", sourceInfo: source("builtin:read") },
            { name: "inline", sourceInfo: source("<inline:fixture>") },
            { name: "sdk", sourceInfo: source("<sdk:fixture>") },
        ];
        const catalogue = collectToolProviders(tools, realpathSync(native));
        expect(catalogue).toEqual(collectToolProviders([...tools].reverse(), realpathSync(native)));
        expect(catalogue.map(entry => entry.whenTools)).toEqual([["inspect_a", "inspect_z", "read"], ["adjacent"]]);
        expect(catalogue[0]?.path).toBe(realpathSync(provider));
        expect(catalogue[0]?.id).toMatch(/^global-tools\.[a-f0-9]{64}$/);
        expect(collectToolProviders([...tools, { name: "late_tool", sourceInfo: source(provider) }], native)[0]?.whenTools).toContain("late_tool");
        expect(() => collectToolProviders([{ name:"missing", sourceInfo:source(join(root,"missing.ts")) }],native)).toThrow();
        expect(() => collectToolProviders([{ name:"directory", sourceInfo:source(root) }],native)).toThrow("not a file");
    } finally { rmSync(root, { recursive:true, force:true }); }
});
