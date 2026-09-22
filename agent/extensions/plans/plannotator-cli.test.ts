import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlannotator } from "./plannotator-cli.ts";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
function executable(body: string) {
    const cwd = mkdtempSync(join(tmpdir(), "plannotator-cli-"));
    dirs.push(cwd);
    const binary = join(cwd, "cli");
    writeFileSync(binary, `#!${process.execPath}\n${body}`, { mode: 0o700 });
    return { cwd, executable: binary };
}
test("submit passes literal arguments, cwd and browser only to the child", async () => {
    const browser = process.env.PLANNOTATOR_BROWSER;
    const request = executable(`
        if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['annotate', 'a ; $(echo x).md', '--gate', '--json', '--require-approval'])) process.exit(2);
        if (process.env.PLANNOTATOR_BROWSER !== 'custom-browser') process.exit(2);
        console.log(JSON.stringify({ decision: 'approved', feedback: process.cwd() }));
    `);
    expect(
        await runPlannotator({
            ...request,
            mode: "submit",
            filePath: "a ; $(echo x).md",
            browserCommand: "custom-browser",
        }),
    ).toEqual({ decision: "approved", feedback: request.cwd });
    expect(process.env.PLANNOTATOR_BROWSER).toBe(browser);
});
test.each([
    ["annotated", 1],
    ["dismissed", 1],
] as const)(
    "submit accepts %s as a non-approval exit",
    async (decision, code) => {
        const request = executable(
            `console.log(JSON.stringify({decision:'${decision}'})); process.exit(${code});`,
        );
        expect(
            await runPlannotator({
                ...request,
                mode: "submit",
                filePath: "plan.md",
            }),
        ).toEqual({ decision, feedback: "" });
    },
);
test.each([
    ['{"decision":"approved"}', 1],
    ['{"decision":"annotated"}', 0],
    ['{"decision":"approved"}', 2],
    ['{"decision":"surprise"}', 0],
    ['{"decision":"approved","feedback":42}', 0],
    ["not json", 0],
    ['{"decision":"approved"}\n{"decision":"approved"}', 0],
])("rejects invalid result %s (exit %s)", async (output, code) => {
    const request = executable(
        `console.log(${JSON.stringify(output)}); process.exit(${code});`,
    );
    await expect(
        runPlannotator({ ...request, mode: "submit", filePath: "plan.md" }),
    ).rejects.toThrow();
});
test("manual code review uses native rendered message", async () => {
    const request = executable(
        `if (JSON.stringify(process.argv.slice(2)) !== '["review","--json"]') process.exit(2); console.log('{"decision":"annotated","message":"Review notes"}');`,
    );
    expect(await runPlannotator({ ...request, mode: "code" })).toEqual({
        decision: "annotated",
        feedback: "Review notes",
    });
});
test("cancellation kills a waiting CLI and rejects, including already-aborted calls", async () => {
    const request = executable("setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const result = runPlannotator({
        ...request,
        mode: "file",
        filePath: "doc.md",
        signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(result).rejects.toThrow(/abort|cancel/i);
    await expect(
        runPlannotator({ ...request, mode: "code", signal: controller.signal }),
    ).rejects.toThrow(/abort|cancel/i);
});
test("missing CLI produces an actionable error", async () => {
    await expect(
        runPlannotator({
            mode: "code",
            cwd: tmpdir(),
            executable: "/nonexistent/plannotator",
        }),
    ).rejects.toThrow(/install|not found/i);
});
