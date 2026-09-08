import { describe, expect, it } from "bun:test";
import {
    collectToolPolicyAugmentations,
    registerToolPolicyAugmenter,
} from "./policy-augmenters.ts";

describe("tool policy augmenters", () => {
    it("deduplicates contributions while preserving registration order", () => {
        const unregisterA = registerToolPolicyAugmenter(
            "policy-augmenters-order-a",
            () => ["herdr_layout", "herdr_pane"],
        );
        const unregisterB = registerToolPolicyAugmenter(
            "policy-augmenters-order-b",
            () => ["herdr_pane", "herdr_agent"],
        );

        expect(collectToolPolicyAugmentations()).toEqual([
            "herdr_layout",
            "herdr_pane",
            "herdr_agent",
        ]);
        unregisterA();
        unregisterB();
    });

    it("does not let stale reload cleanup remove a replacement", () => {
        const unregisterStale = registerToolPolicyAugmenter(
            "policy-augmenters-reload",
            () => ["stale"],
        );
        const unregisterCurrent = registerToolPolicyAugmenter(
            "policy-augmenters-reload",
            () => ["current"],
        );

        unregisterStale();
        expect(collectToolPolicyAugmentations()).toContain("current");
        unregisterCurrent();
        expect(collectToolPolicyAugmentations()).not.toContain("current");
    });
});
