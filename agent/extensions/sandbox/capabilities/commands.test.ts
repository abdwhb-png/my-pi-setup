import { expect, test } from "bun:test";
import { createCapabilityCommands } from "./commands.ts";

test("session mode remains in memory and persistent grants are not a command path", async () => {
    const notices: string[] = [];
    const commands = createCapabilityCommands({
        load: () => ({ state: "ready", projectRoot: "/project", mode: "sandbox", requestedMode: "sandbox", profile: "default", requestedProfile: "default", grants: { domains: [], hostDomains: [], readPaths: [], writePaths: [], hostTmp: false }, requestedGrants: { domains: [], hostDomains: [], readPaths: [], writePaths: [], hostTmp: false }, authorityPath: "/agent/sandbox.json" }),
        apply: async () => {},
    });
    const ctx = { hasUI: true, isProjectTrusted: () => true, ui: { notify: (message: string) => notices.push(message) } };
    expect(await commands.handle("mode host --session", ctx)).toBeTrue();
    expect(commands.session()).toEqual({ mode: "host" });
    expect(await commands.handle("capabilities grant host", ctx)).toBeFalse();
    expect(notices.join("\n")).toContain("Session mode");
});
