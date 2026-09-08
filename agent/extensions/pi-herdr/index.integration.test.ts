import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";

const AGENT_ROOT = resolve(import.meta.dir, "../..");
const HERDR_EXTENSION = resolve(import.meta.dir, "index.ts");
const TOOL_GROUPS_EXTENSION = resolve(import.meta.dir, "../tool-groups/index.ts");

let session: TestSession | undefined;
let inheritedHerdrEnv: string | undefined;
let inheritedPaneId: string | undefined;

beforeEach(() => {
    inheritedHerdrEnv = process.env.HERDR_ENV;
    inheritedPaneId = process.env.HERDR_PANE_ID;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "integration-pane";
});

afterEach(() => {
    session?.dispose();
    session = undefined;
    if (inheritedHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = inheritedHerdrEnv;
    if (inheritedPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = inheritedPaneId;
});

test.skipIf(!process.env.PI_HERDR_RUNTIME_CONTRACT)(
    "manual Herdr activation is visible and executable through the Pi runtime",
    async () => {
        const current = Bun.spawnSync(["herdr", "pane", "current"]);
        expect(current.exitCode).toBe(0);
        const envelope = JSON.parse(current.stdout.toString()) as {
            result: { pane: { pane_id: string } };
        };
        process.env.HERDR_PANE_ID = envelope.result.pane.pane_id;

        session = await createTestSession({
            cwd: AGENT_ROOT,
            extensions: [TOOL_GROUPS_EXTENSION, HERDR_EXTENSION],
            propagateErrors: false,
        });

        expect(session.session.getActiveToolNames()).not.toContain(
            "herdr_pane",
        );

        await session.session.prompt("/herdr-tools on");
        expect(session.session.getActiveToolNames()).toContain("herdr_pane");
        await session.run(
            when("Inspect the current pane", [
                calls("herdr_pane", {
                    action: "get",
                    pane: envelope.result.pane.pane_id,
                }),
                says("Pane inspected."),
            ]),
        );
        expect(
            session.events.toolResultsFor("herdr_pane").at(-1),
        ).toMatchObject({
            mocked: false,
            isError: false,
        });

        await session.session.prompt("/herdr-tools off");
        expect(session.session.getActiveToolNames()).not.toContain(
            "herdr_pane",
        );
    },
    30_000,
);
