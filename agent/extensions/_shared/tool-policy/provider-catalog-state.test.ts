import { expect, test } from "bun:test";
import {
    claimProviderCatalogRecorder,
    getProviderCatalogSnapshot,
} from "./provider-catalog-state.ts";

const snapshot = {
    api: "openai-completions",
    requestNumber: 1,
    injected: true,
    observation: {
        supported: true as const,
        tools: [],
        callableTools: [],
        selection: { mode: "none" as const },
        block: "fixture",
    },
};

test("a stale finalizer generation cannot overwrite or clear current diagnostics", () => {
    const stale = claimProviderCatalogRecorder();
    const current = claimProviderCatalogRecorder();
    stale.record(snapshot);
    expect(getProviderCatalogSnapshot()).toBeUndefined();
    current.record(snapshot);
    stale.dispose();
    expect(getProviderCatalogSnapshot()).toEqual(snapshot);
    current.dispose();
    expect(getProviderCatalogSnapshot()).toBeUndefined();
});
