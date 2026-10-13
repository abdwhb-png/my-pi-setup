import { expect, test } from "bun:test";
import { join } from "node:path";

test("loading auto-translate leaves its translation and widget modules unloaded", async () => {
    const { default: extension } = await import("./index.ts");
    expect(typeof extension).toBe("function");
    for (const name of ["translator", "widget"]) {
        expect(require.cache[join(import.meta.dir, `${name}.ts`)]).toBeUndefined();
    }
});
