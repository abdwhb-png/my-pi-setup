import { expect, test } from "bun:test";
import { createTestSession } from "@abdwhb-png/pi-test-harness";

import { getSharedVisibilityBroker } from "../../_shared/tool-groups/broker.ts";
import { publicExtensionEntrypoints } from "./public-extension-session.ts";

test("Brainstorm and SDD publish distinct workflow groups", async () => {
    const session = await createTestSession({
        extensions: publicExtensionEntrypoints(
            "brainstorm-forcer",
            "sdd-orchestrator",
        ),
    });
    try {
        const names = session.session
            .getAllTools()
            .map((tool) => tool.name);
        const brainstorm = names.filter((name) =>
            name.startsWith("brainstorm_"),
        );
        const sdd = names.filter((name) => name.startsWith("sdd_"));

        expect(brainstorm).toHaveLength(10);
        expect(new Set(brainstorm).size).toBe(brainstorm.length);
        expect(sdd).toHaveLength(8);
        expect(new Set(sdd).size).toBe(sdd.length);
        expect(getSharedVisibilityBroker().getWorkflowGroups()).toEqual(
            expect.arrayContaining(["brainstorm", "sdd"]),
        );
    } finally {
        session.dispose();
    }
});
