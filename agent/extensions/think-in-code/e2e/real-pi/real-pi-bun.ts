#!/usr/bin/env bun

import { join } from "node:path";
import { pathToFileURL } from "node:url";

const agentRoot = join(import.meta.dir, "../../../..");
const cliPath = join(
    agentRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
await import(pathToFileURL(cliPath).href);
