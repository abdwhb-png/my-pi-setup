import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateToolSelection, rollbackToolSelection } from "./tool-selection-migration.ts";

let root: string;
let path: string;
let journalPath: string;
const ownedTools = ["read", "grep"];
function fixture() {
    return { untouched: { future: true }, subagents: { agentOverrides: { reader: { tools: ownedTools, model: "p/model", thinking: "high", toolBudget: {hard:17} }, removed: { tools: ownedTools } } }, piSubagentsAddons: { generatedToolOverrides: {version:1, agents:Object.fromEntries(["reader", "removed"].map(name => [name, {sources:["fixture"], objectCreated:true, fingerprint:createHash("sha256").update(JSON.stringify(ownedTools)).digest("hex")}]))} } };
}
beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "tool-selection-migration-"));
    path = join(root, "settings.json");
    journalPath = join(root, "journal.json");
    fs.writeFileSync(path, JSON.stringify(fixture()), {mode:0o640});
});
afterEach(() => fs.rmSync(root, {recursive:true, force:true}));
function migrate(apply = true) { return migrateToolSelection([{path, manualTools:{reader:["@inspect"]}, resolver:"~/resolver.ts"}], {apply, journalPath}); }
test("previews without writes, converts aliases once and releases ownership", async () => {
    const before = fs.readFileSync(path,"utf8");
    const preview = await migrate(false);
    expect(preview.preview[0]?.fields).toContain("subagents.agentOverrides.reader.tools");
    expect(fs.readFileSync(path,"utf8")).toBe(before);
    expect(fs.existsSync(journalPath)).toBe(false);
    expect((await migrate()).changed).toEqual([path]);
    const current = JSON.parse(fs.readFileSync(path,"utf8"));
    expect(current.subagents.agentOverrides.reader).toEqual({...fixture().subagents.agentOverrides.reader, tools:["@inspect"]});
    expect(current.subagents.agentOverrides.removed?.tools).toBeUndefined();
    expect(current.piSubagentsAddons?.generatedToolOverrides).toBeUndefined();
    expect(current.untouched).toEqual(fixture().untouched);
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
    expect((await migrateToolSelection([{path, manualTools:{reader:["@inspect"]}, resolver:"~/resolver.ts"}])).preview).toEqual([]);
});
test("manual ownership conflict stops all targets before publication", async () => {
    const other = join(root,"other.json");
    const modified = fixture(); modified.subagents.agentOverrides.reader.tools = ["write"];
    fs.writeFileSync(other,JSON.stringify(modified));
    const before = fs.readFileSync(path,"utf8");
    await expect(migrateToolSelection([{path},{path:other}], {apply:true, journalPath})).rejects.toThrow("Manual edit conflicts");
    expect(fs.readFileSync(path,"utf8")).toBe(before);
    expect(fs.existsSync(journalPath)).toBe(false);
});
test("reports partial publication and journal permits scoped rollback", async () => {
    const other = join(root,"z-settings.json");
    fs.writeFileSync(other,JSON.stringify(fixture()));
    const rename = fs.renameSync;
    const spy = spyOn(fs,"renameSync").mockImplementation((from,to) => {if(to===other) throw new Error("fixture publication failed"); return rename(from,to);});
    try { await expect(migrateToolSelection([{path},{path:other}],{apply:true,journalPath})).rejects.toThrow("published files:"); }
    finally {spy.mockRestore();}
    expect(fs.existsSync(journalPath)).toBe(true);
    expect((await rollbackToolSelection(journalPath,{apply:true})).changed).toEqual([path]);
    expect(JSON.parse(fs.readFileSync(path,"utf8"))).toEqual(fixture());
});
test("rollback preserves later model edits and rejects edited alias fields", async () => {
    await migrate();
    const current = JSON.parse(fs.readFileSync(path,"utf8"));
    current.subagents.agentOverrides.reader.model = "p/later";
    fs.writeFileSync(path,JSON.stringify(current));
    await rollbackToolSelection(journalPath,{apply:true});
    expect(JSON.parse(fs.readFileSync(path,"utf8")).subagents.agentOverrides.reader).toMatchObject({tools:ownedTools, model:"p/later"});
    expect((await rollbackToolSelection(journalPath)).preview).toEqual([]);
    fs.rmSync(journalPath); fs.rmSync(journalPath+".rollback");
    fs.writeFileSync(path,JSON.stringify(fixture())); await migrate();
    const edited = JSON.parse(fs.readFileSync(path,"utf8")); edited.subagents.agentOverrides.reader.tools=["write"];
    fs.writeFileSync(path,JSON.stringify(edited));
    await expect(rollbackToolSelection(journalPath,{apply:true})).rejects.toThrow("Concurrent edit conflicts");
    expect(JSON.parse(fs.readFileSync(path,"utf8")).subagents.agentOverrides.reader.tools).toEqual(["write"]);
});
