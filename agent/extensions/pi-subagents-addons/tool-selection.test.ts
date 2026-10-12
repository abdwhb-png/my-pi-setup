import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import * as groupConfig from "../_shared/tool-groups/config.ts";
import { resolveTools } from "./tool-selection.ts";

let root: string;
let agentDir: string;
let cwd: string;
function groups(dir: string, values: Record<string, string[]>) {
    fs.mkdirSync(join(dir, "config"), { recursive: true });
    fs.writeFileSync(join(dir, "config/tool-groups.json"), JSON.stringify({ groups: values }));
}
beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "host-tool-groups-"));
    agentDir = join(root, "agent");
    cwd = join(root, "project");
    fs.mkdirSync(cwd);
    groups(agentDir, { inspect: ["read"], review: ["@inspect", "read", "mcp:fixture/echo"] });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function resolve(selectors: string[], scope: "user" | "project" | "both" = "both", projectTrusted = true) {
    return resolveTools({ cwd, agentDir, scope, projectTrusted, selections: [{ agentName: "fixture", selectors }] })[0];
}
test("expands nested groups with ordered exact and MCP selections", () => {
    expect(resolve(["@review", "read", "child_only"])).toEqual({ ok: true, selectors: ["read", "mcp:fixture/echo", "child_only"] });
    expect(resolve([])).toEqual({ ok: true, selectors: [] });
});
test("keeps per-agent exact tools isolated when resolving a shared policy batch", () => {
    const result = resolveTools({cwd, agentDir, scope:"user", projectTrusted:false, selections:[
        {agentName:"a", selectors:["@inspect", "private_a"]},
        {agentName:"b", selectors:["@review", "private_b"]},
    ]});
    expect(result).toEqual([
        {ok:true, selectors:["read", "private_a"]},
        {ok:true, selectors:["read", "mcp:fixture/echo", "private_b"]},
    ]);
});
test("uses only saved project trust and isolates user scope", () => {
    groups(join(cwd, ".pi"), { inspect: ["grep"] });
    expect(resolve(["@inspect"])).toEqual({ ok: true, selectors: ["read"] });
    new ProjectTrustStore(agentDir).set(cwd, true);
    expect(resolve(["@inspect"])).toEqual({ ok: true, selectors: ["grep"] });
    expect(resolve(["@inspect"], "user")).toEqual({ ok: true, selectors: ["read"] });
    expect(resolve(["@inspect"], "project", false)).toEqual({ ok: true, selectors: ["read"] });
    const argv = process.argv;
    try {
        process.argv = [...argv, "--no-approve"];
        expect(resolve(["@inspect"])).toEqual({ ok: true, selectors: ["read"] });
    } finally { process.argv = argv; }
});
test("reads group configuration once per batch and observes subsequent edits", () => {
    const load = groupConfig.loadToolGroupsConfig;
    let reads = 0;
    const spy = spyOn(groupConfig, "loadToolGroupsConfig").mockImplementation((...args) => {
        reads++;
        return load(...args);
    });
    try {
        const result = resolveTools({ cwd, agentDir, scope: "user", projectTrusted: false, selections: ["a", "b", "c"].map(agentName => ({agentName, selectors: ["@inspect"]})) });
        expect(result).toHaveLength(3);
        expect(reads).toBe(1);
        groups(agentDir, { inspect: ["find"] });
        expect(resolve(["@inspect"])).toEqual({ok:true, selectors:["find"]});
    } finally { spy.mockRestore(); }
});
test.each(["@missing", "@", "bad*", "@cycle", "@wild"])("returns explicit errors for unsupported selectors %j", selectors => {
    groups(agentDir, { cycle: ["@cycle"], wild: ["read*"] });
    expect(resolve([selectors])).toMatchObject({ok:false});
});
test("reports malformed configuration instead of granting inherited tools", () => {
    fs.writeFileSync(join(agentDir, "config/tool-groups.json"), "{");
    expect(() => resolve(["@inspect"])).toThrow();
});
