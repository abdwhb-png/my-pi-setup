import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePiSubagentsPackageRoot(): string {
    return path.dirname(fileURLToPath(import.meta.resolve("pi-subagents")));
}
