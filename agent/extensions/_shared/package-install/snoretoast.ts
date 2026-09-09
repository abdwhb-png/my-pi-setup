import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    lstatSync,
} from "node:fs";
import { join } from "node:path";

const SNORETOAST_EXECUTABLES = [
    "snoretoast-x64.exe",
    "snoretoast-x86.exe",
] as const;

export interface SnoreToastRepairResult {
    repaired: string[];
    warnings: string[];
}

export function isWslRuntime(): boolean {
    return (
        process.platform === "linux" &&
        Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
    );
}

export function getSnoreToastExecutablePaths(agentDir: string): string[] {
    const vendorDir = join(
        agentDir,
        "node_modules",
        "node-notifier",
        "vendor",
        "snoreToast",
    );
    return SNORETOAST_EXECUTABLES.map((name) => join(vendorDir, name));
}

export function getSnoreToastExecutablePath(
    agentDir: string,
    architecture: NodeJS.Architecture = process.arch,
): string {
    const executable =
        architecture === "x64" ? "snoretoast-x64.exe" : "snoretoast-x86.exe";
    return join(
        agentDir,
        "node_modules",
        "node-notifier",
        "vendor",
        "snoreToast",
        executable,
    );
}

export function repairSnoreToastExecutables(
    agentDir: string,
): SnoreToastRepairResult {
    const result: SnoreToastRepairResult = { repaired: [], warnings: [] };

    for (const executablePath of getSnoreToastExecutablePaths(agentDir)) {
        if (!existsSync(executablePath)) continue;

        try {
            const stats = lstatSync(executablePath);
            if (!stats.isFile()) {
                result.warnings.push(
                    `[package-finalizer] Refusing to chmod non-file SnoreToast executable: ${executablePath}`,
                );
                continue;
            }

            try {
                accessSync(executablePath, constants.X_OK);
                continue;
            } catch {
                chmodSync(executablePath, stats.mode | 0o111);
            }

            accessSync(executablePath, constants.X_OK);
            result.repaired.push(executablePath);
        } catch (error) {
            result.warnings.push(
                `[package-finalizer] Failed to repair SnoreToast executable ${executablePath}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    return result;
}
