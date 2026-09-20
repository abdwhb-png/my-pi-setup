import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { SandboxExecutionError } from "./errors.ts";

export function localMachineId(): string {
    const identity = readFileSync("/etc/machine-id", "utf8").trim();
    if (!identity)
        throw new SandboxExecutionError("invalid-policy", {
            diagnostic: "Machine identity is unavailable",
            cause: new Error("Machine identity is unavailable"),
        });
    return createHash("sha256")
        .update(`${identity}:${process.getuid?.()}`)
        .digest("hex");
}
