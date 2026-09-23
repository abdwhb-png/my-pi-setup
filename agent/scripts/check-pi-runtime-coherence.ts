#!/usr/bin/env bun
import { resolve } from "node:path";
import process from "node:process";
import { verifyRuntimeCoherence } from "../bin/pi-fork-release.ts";
import { resolvePiInstallationPaths } from "../bin/pi-installation-paths.ts";
import { loadCurrentPiRuntime } from "../bin/pi-runtime-store.ts";

try {
    const paths = resolvePiInstallationPaths(resolve(import.meta.dir, "../.."));
    const runtime = loadCurrentPiRuntime(paths.runtimeRoot);
    const report = verifyRuntimeCoherence(runtime, paths.agentDir);
    if (!report.ok) {
        for (const error of report.errors) console.error(error);
        process.exit(1);
    }
    console.log(`Pi runtime coherent: ${runtime.releaseId}`);
} catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
}
