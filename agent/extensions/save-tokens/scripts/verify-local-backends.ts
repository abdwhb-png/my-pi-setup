/**
 * Live integration verification for the save-tokens compression extension.
 *
 * Exercises the REAL Pi extension modules (backend registry, tool-result
 * handler, archive) against locally running compression services. This is the
 * Pi-side half of the split verification: the Docker lifecycle, topology, and
 * security checks live in
 * `~/projects/shared-services/compression/scripts/verify-local-backends.ts`.
 *
 * This script assumes the selected service is already running on its loopback
 * relay (headroom `127.0.0.1:8787`, edgee `127.0.0.1:8320`). It does NOT
 * manage Docker Compose — bring the profile up first, e.g.:
 *
 * ```sh
 * docker compose --profile headroom up -d --wait
 * bun extensions/save-tokens/scripts/verify-local-backends.ts --backend headroom
 * ```
 *
 * Run from `~/.pi/agent`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCompressorConfig } from "../config-runtime";
import { archiveOriginalToolResult } from "../tool-results/archive";
import { createToolResultHandler } from "../tool-results/core";
import { CompressionBackendRegistry } from "../tool-results/registry";
import type {
    CompressionBackendId,
    CompressionObservation,
    CompressorModel,
    ToolResultHandlerOptions,
} from "../tool-results/types";

const MODEL: CompressorModel = {
    provider: "openai",
    id: "gpt-4o-mini",
    contextWindow: 128_000,
};

const DEAD_ENDPOINT = "http://127.0.0.1:1";

const E2E_TIMEOUT_MS: Record<CompressionBackendId, number> = {
    headroom: 30_000,
    edgee: 5_000,
};

/**
 * Self-contained, deterministic fixtures. These exercise the integration
 * wiring (backend selection, compression, archive recovery, fail-open), not
 * the full benchmark corpus — so they stay in the harness with no cross-repo
 * import. Each is large and repetitive enough to compress reliably.
 */
const FIXTURES = [
    {
        name: "read-json",
        toolName: "read",
        commandHint: "/repo/agent/package.json",
        text: JSON.stringify(
            Array.from({ length: 200 }, (_, index) => ({
                name: `dependency-${index}`,
                version: `^${index}.0.0`,
                resolved: `https://registry.example/${index}/-/${index}-1.0.0.tgz`,
                integrity: `sha512-${"a".repeat(64)}`,
            })),
            null,
            2,
        ),
    },
    {
        name: "grep-matches",
        toolName: "grep",
        commandHint: "ERROR",
        text: Array.from(
            { length: 400 },
            (_, index) =>
                `src/file-${index}.ts:${index}: ERROR request failed id=${index} status=500`,
        ).join("\n"),
    },
    {
        name: "bash-logs",
        toolName: "bash",
        commandHint: "cat logs/app.log",
        text: Array.from(
            { length: 400 },
            (_, index) =>
                `2026-08-18T00:00:00Z INFO request id=${index} status=200 duration=${index}ms bytes=${index * 512}`,
        ).join("\n"),
    },
] as const;

type ToolResultEvent = Parameters<
    ReturnType<typeof createToolResultHandler>
>[0];

type Options = {
    backends: CompressionBackendId[];
};

function parseOptions(args: string[]): Options {
    if (args.includes("--all")) {
        return { backends: ["headroom", "edgee"] };
    }
    const backendIndex = args.indexOf("--backend");
    const backend = backendIndex >= 0 ? args[backendIndex + 1] : "headroom";
    if (backend !== "headroom" && backend !== "edgee") {
        throw new Error('Expected --backend "headroom" or "edgee"');
    }
    return { backends: [backend] };
}

function eventFor(fixture: (typeof FIXTURES)[number]): ToolResultEvent {
    return {
        type: "tool_result",
        toolCallId: `verify-${fixture.name}`,
        toolName: fixture.toolName,
        input: { command: fixture.commandHint, path: fixture.commandHint },
        content: [{ type: "text", text: fixture.text }],
        isError: false,
        details: undefined,
    };
}

async function verifyBackend(backendId: CompressionBackendId): Promise<void> {
    const resolved = resolveCompressorConfig({
        backend: backendId,
        backends: {
            [backendId]: { timeoutMs: E2E_TIMEOUT_MS[backendId] },
        },
        minTokensByGroup: { shell: 0, read: 0, search: 0 },
        archiveOriginal: true,
        aggregates: false,
        capErrors: false,
    });
    const backend = new CompressionBackendRegistry(resolved).getBackend();
    if (!backend || backend.id !== backendId) {
        throw new Error(`Backend selection failed for ${backendId}`);
    }

    const observations: CompressionObservation[] = [];
    const archiveRoot = mkdtempSync(
        join(tmpdir(), `pi-compression-${backendId}-`),
    );
    const previousArchiveRoot = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = archiveRoot;
    const handlerOptions: ToolResultHandlerOptions = {
        backend,
        archiveOriginal: archiveOriginalToolResult,
        enabled: true,
        excludeTools: [],
        minTokensByGroup: { shell: 0, read: 0, search: 0 },
        aggregates: false,
        capErrors: false,
        onObservation: (observation) => observations.push(observation),
    };
    const handler = createToolResultHandler(handlerOptions);

    let compressed = 0;
    let archiveVerified = false;
    try {
        for (const fixture of FIXTURES) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential keeps failures attributable
            const result = await handler(eventFor(fixture), MODEL);
            if (!result) continue;
            compressed += 1;
            if (!archiveVerified) {
                const archivePath = result.details?.compression.archivePath;
                const output = result.content[0];
                if (
                    !archivePath ||
                    output?.type !== "text" ||
                    !output.text.includes(archivePath)
                ) {
                    throw new Error(
                        `${backendId} result did not expose archive recovery path`,
                    );
                }
                if (readFileSync(archivePath, "utf8") !== fixture.text) {
                    throw new Error(
                        `${backendId} live archive recovery was not byte-identical`,
                    );
                }
                archiveVerified = true;
            }
        }

        const failure = observations.find(
            (observation) => observation.kind === "failed",
        );
        if (failure) {
            throw new Error(
                `${backendId} compression failed: ${failure.reason ?? "unknown"}`,
            );
        }
        if (compressed === 0 || !archiveVerified) {
            throw new Error(
                `${backendId} produced no archived compressed result across the fixtures`,
            );
        }
    } finally {
        if (previousArchiveRoot === undefined)
            delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
        else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previousArchiveRoot;
        rmSync(archiveRoot, { recursive: true, force: true });
    }
    console.log(
        `PASS ${backendId}: ${compressed}/${FIXTURES.length} compressed and archived`,
    );
}

async function verifyFailOpenAndArchive(): Promise<void> {
    const backend = new CompressionBackendRegistry(
        resolveCompressorConfig({
            backend: "headroom",
            backends: { headroom: { baseUrl: DEAD_ENDPOINT, timeoutMs: 100 } },
        }),
    ).getBackend();
    if (!backend) throw new Error("Dead-endpoint backend was not created");

    const failures: CompressionObservation[] = [];
    const failOpen = createToolResultHandler({
        backend,
        minTokensByGroup: { shell: 0, read: 0, search: 0 },
        aggregates: false,
        capErrors: false,
        onObservation: (observation) => failures.push(observation),
    });
    const untouched = await failOpen(eventFor(FIXTURES[0]), MODEL);
    if (
        untouched !== undefined ||
        !failures.some((observation) => observation.kind === "failed")
    ) {
        throw new Error(
            "Dead backend did not fail open to the original tool result",
        );
    }

    console.log("PASS fail-open");
}

const options = parseOptions(process.argv.slice(2));
await verifyFailOpenAndArchive();
for (const backend of options.backends) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- backends are verified sequentially
    await verifyBackend(backend);
}
