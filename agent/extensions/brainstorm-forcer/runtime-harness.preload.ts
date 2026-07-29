import { mock } from "bun:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
// @ts-expect-error -- Bun needs a distinct query URL to load the real installed module before mocking its root export set.
import * as piAi from "../../node_modules/@earendil-works/pi-ai/dist/index.js?pi-test-harness-actual";

void mock.module("@earendil-works/pi-ai", () => ({
    ...piAi,
    getModel: getBuiltinModel,
}));
