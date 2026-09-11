import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
} from "../_shared/sandbox-runtime/index.ts";
import { emptyGrants } from "../sandbox/capabilities/authority.ts";
import type { ShellCapabilityResolution } from "../sandbox/capabilities/policy.ts";
import {
    publishShellRuntime,
    releaseShellRuntime,
} from "../sandbox/capabilities/runtime.ts";
import { registerBuiltinBash } from "./builtin-bash.ts";

test(
    "real Pi rejects raw legacy builtin bash hostCapability payloads before launch",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-legacy-builtin-bash-"));
        const cwd = join(root, "project");
        const owner = Symbol("legacy-builtin-bash");
        const localSupervisor = createBashProcessSupervisor();
        const legacyPayloads = [
            { label: "string", value: "editor" },
            { label: "null", value: null },
            { label: "undefined", value: undefined },
        ] as const;
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;

        await mkdir(cwd);
        claimSandboxRuntime(owner);
        publishSandboxRuntime(owner, { state: "disabled" });
        const policy: ShellCapabilityResolution = {
            state: "ready",
            projectRoot: cwd,
            mode: "host",
            requestedMode: "host",
            profile: "host",
            requestedProfile: "host",
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: join(root, "sandbox.json"),
        };
        publishShellRuntime(owner, () => policy);

        try {
            session = await createTestSession({
                cwd,
                extensionFactories: [
                    (pi) => registerBuiltinBash(pi, { localSupervisor }),
                ],
                propagateErrors: false,
            });

            const builtin = session.session.agent.state.tools.find(
                (tool) => tool.name === "bash",
            );
            expect(builtin).toBeDefined();
            expect(JSON.stringify(builtin?.parameters)).not.toContain(
                "hostCapability",
            );

            const markers = legacyPayloads.map(({ label }) =>
                join(root, `legacy-${label}-ran`),
            );
            const positiveMarker = join(root, "ordinary-builtin-ran");
            await session.run(
                when("Reject obsolete builtin bash payloads", [
                    ...legacyPayloads.map(({ value }, index) =>
                        calls("bash", {
                            command: `printf legacy > '${markers[index]}'`,
                            hostCapability: value,
                        }),
                    ),
                    calls("bash", {
                        command: `printf builtin-boundary > '${positiveMarker}'`,
                    }),
                    says("The migration refusals and ordinary command were observed."),
                ]),
            );

            const callsToBuiltin = session.events.toolCallsFor("bash");
            const results = session.events.toolResultsFor("bash");
            expect(callsToBuiltin).toHaveLength(4);
            expect(results).toHaveLength(4);

            for (const [index, { value }] of legacyPayloads.entries()) {
                expect(
                    Object.hasOwn(callsToBuiltin[index]!.input, "hostCapability"),
                ).toBe(true);
                expect(callsToBuiltin[index]!.input.hostCapability).toBe(value);
                expect(results[index]).toMatchObject({ mocked: false });
                // With propagateErrors:false, the harness catches the throw
                // and returns an error result. Pi's agent loop treats that
                // fulfilled execute() as isError:false, so assert the guard's
                // diagnostic rather than the collected event flag.
                expect(results[index]!.text).toContain("migration-required");
                expect(results[index]!.text).toContain(
                    "Legacy hostCapability was removed from tool parameters",
                );
                await expect(readFile(markers[index]!, "utf8")).rejects.toMatchObject({
                    code: "ENOENT",
                });
            }

            expect(results[3]).toMatchObject({ mocked: false, isError: false });
            expect(await readFile(positiveMarker, "utf8")).toBe(
                "builtin-boundary",
            );
        } finally {
            await session?.session.extensionRunner?.emit({
                type: "session_shutdown",
                reason: "quit",
            });
            session?.dispose();
            localSupervisor.shutdown();
            releaseSandboxRuntime(owner);
            releaseShellRuntime(owner);
            await rm(root, { recursive: true, force: true });
        }
    },
    30_000,
);
