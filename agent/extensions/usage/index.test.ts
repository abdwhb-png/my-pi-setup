import { expect, test } from "bun:test";
import { join } from "node:path";

test("loading usage leaves its report dependencies unloaded until the command runs", async () => {
    const { default: usage } = await import("./index.ts");
    expect(typeof usage).toBe("function");
    for (const name of ["scanner", "aggregator", "pricing", "inline-view", "widget"]) {
        expect(require.cache[join(import.meta.dir, `${name}.ts`)]).toBeUndefined();
    }
});
