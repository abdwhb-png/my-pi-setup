import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";

const AGENT_ROOT = resolve(import.meta.dir, "../../..");
const SANDBOX_EXTENSION = resolve(import.meta.dir, "../index.ts");
const BASH_EXECUTION_EXTENSION = resolve(
    import.meta.dir,
    "../../bash-execution/index.ts",
);
const SESSION_STATUS_ENV = "PI_SANDBOX_SESSION_STATUS";

describe("accepted Zerobox safe_bash contract", () => {
    let fixture: string | undefined;
    let session: TestSession | undefined;
    let inheritedSessionStatus: string | undefined;

    afterEach(async () => {
        session?.dispose();
        session = undefined;
        if (fixture) await rm(fixture, { recursive: true, force: true });
        fixture = undefined;
        if (inheritedSessionStatus === undefined) {
            delete process.env[SESSION_STATUS_ENV];
        } else {
            process.env[SESSION_STATUS_ENV] = inheritedSessionStatus;
        }
    });

    it("preserves the real stderr and exit code from a shebang process", async () => {
        inheritedSessionStatus = process.env[SESSION_STATUS_ENV];
        delete process.env[SESSION_STATUS_ENV];
        fixture = await mkdtemp(resolve(AGENT_ROOT, ".zerobox-safe-bash-"));
        await mkdir(resolve(fixture, "package/node_modules"), {
            recursive: true,
        });
        const script = resolve(fixture, "failure.sh");
        await writeFile(
            script,
            "#!/bin/sh\nprintf 'real-safe-bash-error\\n' >&2\nexit 37\n",
        );
        await chmod(script, 0o755);

        session = await createTestSession({
            cwd: fixture,
            extensions: [SANDBOX_EXTENSION, BASH_EXECUTION_EXTENSION],
            propagateErrors: false,
        });
        await session.run(
            when("Run the failing script", [
                calls("safe_bash", { command: "./failure.sh" }),
                says("Failure observed."),
            ]),
        );

        const [result] = session.events.toolResultsFor("safe_bash");
        expect(result).toMatchObject({ isError: true, mocked: false });
        expect(result?.text).toBe(
            "real-safe-bash-error\n\n\nCommand exited with code 37",
        );
    }, 30_000);
});
