import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentsAddons from "../index.ts";
import { resolvePiSubagentsPackageRoot } from "./package-path";

const EXTENSIONS_DIR = path.resolve(import.meta.dir, "..", "..");
const ADDONS_DIR = path.resolve(import.meta.dir, "..");

describe("pi-subagents-addons discovery contract", () => {
    it("keeps the disabled overview behind the sole aggregate entrypoint", () => {
        const commands: string[] = [];
        const renderers: string[] = [];
        const pi = {
            events: { on: () => () => {}, emit: () => {} },
            on: () => {},
            registerCommand: (name: string) => commands.push(name),
            registerMessageRenderer: (name: string) => renderers.push(name),
        } as unknown as ExtensionAPI;

        registerSubagentsAddons(pi);

        expect(commands).toEqual([]);
        expect(renderers).toEqual([]);

        const manifest = JSON.parse(
            fs.readFileSync(path.join(ADDONS_DIR, "package.json"), "utf8"),
        ) as { pi?: { extensions?: string[] } };
        expect(manifest.pi?.extensions).toEqual(["./index.ts"]);
        expect(
            fs.existsSync(path.join(EXTENSIONS_DIR, "pi-subagents-overview")),
        ).toBe(false);
    });

    // Installation source/version/provenance belong to official-package.smoke.test.ts.
    it("resolves the package exposing the overview fleetStatus contract", () => {
        const packageRoot = resolvePiSubagentsPackageRoot();
        const extensionApi = fs.readFileSync(
            path.join(packageRoot, "docs", "extension-api.md"),
            "utf8",
        );

        expect(extensionApi).toContain("ping.capabilities.fleetStatus");
    });
});
