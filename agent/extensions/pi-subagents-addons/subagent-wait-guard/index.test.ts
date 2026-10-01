import { expect, test } from "bun:test";
import type { SubagentRpcToolResult } from "../../_shared/subagents/rpc-client.ts";
import { readActiveRuns } from "./status.ts";

function status(
    runs: Array<{ id: string; state: string }>,
): SubagentRpcToolResult {
    return {
        text: "status",
        asyncSnapshot: {
            kind: "pi-subagents.async-status-snapshot",
            version: 1,
            runs,
            omitted: { runs: 0, children: 0, byteLimitExceeded: false },
        },
    };
}

test("canonical status filters terminal runs and sorts actual async IDs", () => {
    expect(
        readActiveRuns(
            status([
                { id: "z", state: "running" },
                { id: "a", state: "paused" },
                { id: "q", state: "queued" },
                ...["complete", "failed", "partial", "stopped", "rejected"].map(
                    (state) => ({ id: state, state }),
                ),
            ]),
        ),
    ).toEqual([
        { id: "a", status: "paused" },
        { id: "q", status: "queued" },
        { id: "z", status: "running" },
    ]);
});

test("missing or unsupported projections are not settlement proof", () => {
    expect(() => readActiveRuns({ text: "status" })).toThrow("snapshot");
    const result = status([]);
    result.asyncSnapshot!.version = 2;
    expect(() => readActiveRuns(result)).toThrow("snapshot");
    expect(() =>
        readActiveRuns({ text: "owner failed", isError: true }),
    ).toThrow("owner failed");
});

test.each(["runs", "children", "byteLimitExceeded"])(
    "omitted %s is not settlement proof",
    (field) => {
        const result = status([]);
        result.asyncSnapshot!.omitted = {
            runs: 0,
            children: 0,
            byteLimitExceeded: false,
            [field]: field === "byteLimitExceeded" ? true : 1,
        };
        expect(() => readActiveRuns(result)).toThrow("incomplete");
    },
);

test("invalid states and duplicate IDs are rejected", () => {
    expect(() =>
        readActiveRuns(status([{ id: "x", state: "unknown" }])),
    ).toThrow("state");
    expect(() =>
        readActiveRuns(
            status([
                { id: "x", state: "running" },
                { id: "x", state: "running" },
            ]),
        ),
    ).toThrow("duplicate");
});

test("fleet activity without async identities is reported rather than interpreting display keys", () => {
    const result = {
        ...status([]),
        fleet: {
            version: 1,
            totalActive: 1,
            omitted: 0,
            entries: [{ key: "opaque" }],
        },
    };
    expect(() => readActiveRuns(result)).toThrow(
        "without usable async run identities",
    );
    expect(
        readActiveRuns({
            ...status([{ id: "actual-run", state: "running" }]),
            fleet: result.fleet,
        }),
    ).toEqual([{ id: "actual-run", status: "running" }]);
});
