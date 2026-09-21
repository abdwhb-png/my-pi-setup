#!/usr/bin/env bun
import process from "node:process";
import { verifyRuntimeCoherence } from "../bin/pi-fork-release.ts";
import { loadActivePiRuntime } from "../bin/pi-runtime-store.ts";

try {
  const runtime = loadActivePiRuntime();
  const report = verifyRuntimeCoherence(runtime);
  if (!report.ok) {
    for (const error of report.errors) console.error(error);
    process.exit(1);
  }
  console.log(`Pi runtime coherent: ${runtime.releaseId}`);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
