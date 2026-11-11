import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    installationContains,
    type GlobalInstallations,
    type InstallationRoot,
} from "./capabilities/installations.ts";
import { executableDependencies } from "./executable-inspection.ts";

/** Authorize trusted OS library directories, never paths supplied by project binaries. */
export function discoverSystemLibraries(
    watch: (path: string, permissionsOnly?: boolean) => void,
): InstallationRoot[] {
    if (process.platform !== "linux")
        throw new Error("System library discovery requires Linux");
    const roots: string[] = [];
    for (const candidate of ["/lib", "/usr/lib", "/lib64", "/usr/lib64"]) {
        if (!existsSync(candidate)) continue;
        const root = realpathSync(candidate);
        for (let current = root; ; current = dirname(current)) {
            const metadata = statSync(current);
            if (
                !metadata.isDirectory() ||
                metadata.uid !== 0 ||
                (metadata.mode & 0o022) !== 0
            )
                throw new Error(
                    `Untrusted system library directory: ${current}`,
                );
            watch(current, true);
            if (current === dirname(current)) break;
        }
        watch(candidate, true);
        roots.push(root);
    }
    if (!roots.length)
        throw new Error("No trusted system library directories found");
    return [...new Set(roots)]
        .filter(
            (root) =>
                !roots.some(
                    (other) =>
                        other !== root && installationContains(other, root),
                ),
        )
        .sort()
        .map((root) => ({ root, path: [] }));
}

/** Drop exact shared-library selections now covered by the directory authority. */
export function reconcileSystemLibraries(
    installations: GlobalInstallations,
    roots: InstallationRoot[],
): { installations: GlobalInstallations; removed: string[] } {
    const removed: string[] = [];
    const result: GlobalInstallations = {};
    for (const [name, entries] of Object.entries(installations)) {
        if (name === "system-libraries") continue;
        const next = entries.flatMap((entry) => {
            if (!entry.files) return [entry];
            const files = entry.files.filter((file) => {
                const path = join(entry.root, file);
                if (!/\.so(?:\.[^/]+)*$/.test(file)) return true;
                // A removed version may no longer exist; its parent still identifies the OS directory.
                let parent = dirname(path);
                while (!existsSync(parent) && parent !== dirname(parent))
                    parent = dirname(parent);
                const covered = roots.some((root) =>
                    installationContains(
                        root.root,
                        join(realpathSync(parent), path.slice(parent.length)),
                    ),
                );
                if (covered) removed.push(path);
                return !covered;
            });
            return files.length ? [{ ...entry, files }] : [];
        });
        // Preserve explicitly selected installation names even for former library-only groups.
        result[name] = next.length
            ? next
            : roots.map((root) => ({ ...root, path: [] }));
    }
    return { installations: result, removed };
}

/** Keep the native ELF interpreter's stable compatibility pathname addressable. */
export function systemLoaderAliases(
    roots: InstallationRoot[],
    watch: (path: string, permissionsOnly?: boolean) => void,
): InstallationRoot[] {
    const executable = "/usr/bin/env";
    const metadata = statSync(executable);
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
        throw new Error("Untrusted system ELF metadata source");
    watch(executable);
    return executableDependencies(readFileSync(executable)).absolute.flatMap(
        (path) => {
            const target = realpathSync(path);
            if (!roots.some((root) => installationContains(root.root, target)))
                throw new Error(
                    `System loader is outside trusted library directories: ${path}`,
                );
            if (path === target) return [];
            return [{ root: "/", path: [], files: [path.slice(1)] }];
        },
    );
}
