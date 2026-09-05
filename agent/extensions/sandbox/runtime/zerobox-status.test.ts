import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";

import {
    MAX_STATUS_EVENTS,
    MAX_STATUS_LINE_BYTES,
    superviseZeroboxStatusStream,
} from "./zerobox-status.ts";

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

const started = { version: 1, event: "child_started", pid: 42, pid_scope: "supervisor" };
const exited = { version: 1, event: "child_exit", code: 0 };

describe("Zerobox status protocol v1", () => {
    it("accepts fragmented JSONL and waits for terminal EOF", async () => {
        const stream = new PassThrough();
        const status = superviseZeroboxStatusStream(stream);
        const first = line(started);
        stream.write(first.slice(0, 7));
        stream.write(first.slice(7));
        await expect(status.ready).resolves.toBeUndefined();

        let settled = false;
        void status.settled.then(() => {
            settled = true;
        });
        stream.write(line({ ...exited, code: 125 }));
        await Bun.sleep(0);
        expect(settled).toBe(false);
        stream.end();
        await expect(status.settled).resolves.toBeUndefined();
    });

    it("maps setup_error to setup-failed without leaking its fields", async () => {
        const stream = new PassThrough();
        const status = superviseZeroboxStatusStream(stream);
        stream.end(
            line({
                version: 1,
                event: "setup_error",
                code: "raw-secret-code",
                message: "raw-secret-message",
            }),
        );
        for (const promise of [status.ready, status.settled]) {
            try {
                await promise;
                throw new Error("expected rejection");
            } catch (error) {
                expect(error).toMatchObject({ code: "setup-failed" });
                expect((error as Error).message).not.toContain("raw-secret");
            }
        }
    });

    for (const events of [
        [],
        [exited],
        [started],
        [started, started, exited],
        [started, exited, exited],
        [{ version: 2, event: "child_started", pid: 42, pid_scope: "supervisor" }],
        [{ nope: true }],
    ]) {
        it(`rejects impossible sequence ${JSON.stringify(events)}`, async () => {
            const stream = new PassThrough();
            const status = superviseZeroboxStatusStream(stream);
            void status.ready.catch(() => undefined);
            stream.end(events.map(line).join(""));
            await expect(status.settled).rejects.toMatchObject({
                code: "protocol-error",
            });
        });
    }

    it("rejects invalid JSON, oversized lines, too many events, and stream errors", async () => {
        const inputs: Array<(stream: PassThrough) => void> = [
            (stream) => stream.end("not-json\n"),
            (stream) => stream.end(`${"x".repeat(MAX_STATUS_LINE_BYTES + 1)}\n`),
            (stream) => {
                for (let index = 0; index <= MAX_STATUS_EVENTS; index += 1) {
                    stream.write(line({ ...started, pid: index + 1 }));
                }
                stream.end();
            },
            (stream) => stream.destroy(new Error("private stream detail")),
        ];
        for (const write of inputs) {
            const stream = new PassThrough();
            const status = superviseZeroboxStatusStream(stream);
            void status.ready.catch(() => undefined);
            write(stream);
            await expect(status.settled).rejects.toMatchObject({
                code: "protocol-error",
            });
        }
    });
});
