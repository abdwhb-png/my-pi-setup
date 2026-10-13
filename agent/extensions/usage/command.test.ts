import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@abdwhb-png/pi-test-harness";

const io: { readdirSync: (...args: Parameters<typeof fs.readdirSync>) => ReturnType<typeof fs.readdirSync> } = fs;
const fileIo: {
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => ReturnType<typeof fs.readFileSync>;
    statSync: (...args: Parameters<typeof fs.statSync>) => ReturnType<typeof fs.statSync>;
} = fs;

test("the Pi loader supports usage's deferred inline, full and non-interactive reports", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const catalogKey = Symbol.for("pi.models-dev-catalog.v1");
    const originalCatalog = Reflect.get(globalThis, catalogKey);
    const root = await mkdtemp(join(tmpdir(), "pi-usage-command-"));
    const originalRead = fs.readdirSync;
    const originalStat = fs.statSync;
    const originalFileRead = fs.readFileSync;
    let read: ReturnType<typeof spyOn<typeof io, "readdirSync">> | undefined;
    let stat: ReturnType<typeof spyOn<typeof fileIo, "statSync">> | undefined;
    let fileRead: ReturnType<typeof spyOn<typeof fileIo, "readFileSync">> | undefined;
    let log: ReturnType<typeof spyOn<typeof console, "log">> | undefined;
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        const sessions = join(root, "sessions");
        await mkdir(sessions);
        await writeFile(join(sessions, "fixture.jsonl"), JSON.stringify({
            type: "message", timestamp: new Date().toISOString(),
            message: { role: "assistant", provider: "fixture", model: "priced", usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.25 } } },
        }) + "\n");
        read = spyOn(io, "readdirSync").mockImplementation((file, ...args) => {
            if (String(file) === join(homedir(), ".pi/agent/sessions")) return originalRead(sessions, ...args);
            return originalRead(file, ...args);
        });
        const fixturePath = (file: fs.PathLike) => typeof file === "string" && file.startsWith(join(homedir(), ".pi/agent/sessions") + "/") ? join(sessions, file.slice(join(homedir(), ".pi/agent/sessions").length)) : file;
        stat = spyOn(fileIo, "statSync").mockImplementation((file, options) => originalStat(fixturePath(file), options));
        fileRead = spyOn(fileIo, "readFileSync").mockImplementation((file, options) => originalFileRead(typeof file === "number" ? file : fixturePath(file), options));
        const { createModelsDevCatalog } = await import("../_shared/models-dev/catalog.ts");
        Reflect.set(globalThis, catalogKey, createModelsDevCatalog({ cachePath: join(root, "catalog.json"), fetchFn: async () => new Response(JSON.stringify({ fixture: { models: { "priced": { cost: { input: 1, output: 2 } } } } })) }));
        session = await createTestSession({ cwd: root, extensions: [join(import.meta.dir, "index.ts")] });
        const runner = session.session.extensionRunner!;
        const ctx = runner.createCommandContext();
        const rendered: string[] = [];
        // Only the terminal dialog is replaced. Its real component is constructed and rendered.
        const custom: ExtensionUIContext["custom"] = async (factory) => {
            const component = await Reflect.apply(factory, undefined, [undefined, ctx.ui.theme, undefined, () => {}]);
            rendered.push(component.render(100).join("\n"));
            return undefined as never;
        };
        runner.setUIContext({ ...ctx.ui, custom });
        await session.session.prompt("/usage");
        await session.session.prompt("/usage --full");
        expect(session.events.uiCallsFor("notify").filter(call => call.args[1] === "error")).toEqual([]);
        expect(rendered, JSON.stringify(session.events.ui)).toHaveLength(2);
        expect(rendered.every(text => text.includes("priced") && text.includes("$0.2500"))).toBe(true);
        runner.setUIContext();
        log = spyOn(console, "log").mockImplementation(() => {});
        await session.session.prompt("/usage");
        expect(log.mock.calls.some(call => String(call[0]).includes("fixture/priced"))).toBe(true);
    } finally {
        session?.dispose();
        read?.mockRestore();
        stat?.mockRestore();
        fileRead?.mockRestore();
        log?.mockRestore();
        if (originalCatalog === undefined) Reflect.deleteProperty(globalThis, catalogKey);
        else Reflect.set(globalThis, catalogKey, originalCatalog);
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);
