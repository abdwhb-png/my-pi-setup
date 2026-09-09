import { expect, it } from "bun:test";
import { debugLog } from "./debug.ts";

it("keeps debug diagnostics non-fatal", () => {
    expect(() => debugLog("test", "diagnostic")).not.toThrow();
});
