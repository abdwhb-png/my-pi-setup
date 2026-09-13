import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SandboxExecutionError } from "../runtime/contracts.ts";
import { expandShellPathEntry } from "../runtime/shell-baseline.ts";

export interface InstallationRoot {
    root: string;
    path: string[];
    files?: string[];
}

export type GlobalInstallations = Record<string, InstallationRoot[]>;

export interface SelectedInstallation {
    name: string;
    roots: InstallationRoot[];
}

function invalid(message: string): never {
    throw new SandboxExecutionError("invalid-policy", { diagnostic: message });
}

function object(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        invalid(`${field} must be an object`);
    return value as Record<string, unknown>;
}

export function installationContains(root: string, target: string): boolean {
    const suffix = relative(root, target);
    return (
        suffix === "" ||
        (suffix !== ".." &&
            !suffix.startsWith(`..${sep}`) &&
            !isAbsolute(suffix))
    );
}

/** Validate declarations without requiring resources to remain available for repair. */
export function validateGlobalInstallations(
    value: unknown,
): GlobalInstallations {
    if (value === undefined) return {};
    const declarations = object(value, "global environment.installations");
    const result: GlobalInstallations = {};
    for (const [name, rawRoots] of Object.entries(declarations)) {
        if (
            !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) ||
            ["__proto__", "constructor", "prototype"].includes(name)
        )
            invalid("Invalid installation name");
        if (!Array.isArray(rawRoots) || rawRoots.length === 0)
            invalid(`Installation ${name} must contain at least one root`);
        result[name] = rawRoots.map((raw) => {
            const entry = object(raw, `Installation ${name} root`);
            if (
                Object.keys(entry).some(
                    (key) =>
                        key !== "root" && key !== "path" && key !== "files",
                )
            )
                invalid(`Unknown installation ${name} root field`);
            if (
                typeof entry.root !== "string" ||
                !entry.root ||
                /[\0*?[\]{}:]/.test(entry.root)
            )
                invalid(`Invalid installation ${name} root`);
            const expanded = expandShellPathEntry(entry.root);
            if (!isAbsolute(expanded))
                invalid(
                    `Installation ${name} root must be absolute or home-relative`,
                );
            const root = resolve(expanded);
            const path = entry.path ?? [];
            if (
                !Array.isArray(path) ||
                path.some(
                    (part) =>
                        typeof part !== "string" ||
                        !part ||
                        isAbsolute(part) ||
                        /[\0*?[\]{}:]/.test(part) ||
                        !installationContains(root, resolve(root, part)),
                )
            )
                invalid(
                    `Installation ${name} path must contain directories relative to its root`,
                );
            const files = entry.files;
            if (
                files !== undefined &&
                (!Array.isArray(files) ||
                    files.length === 0 ||
                    files.some(
                        (part) =>
                            typeof part !== "string" ||
                            !part ||
                            isAbsolute(part) ||
                            /[\0*?[\]{}:]/.test(part) ||
                            !installationContains(root, resolve(root, part)),
                    ))
            )
                invalid(
                    `Installation ${name} files must be a nonempty list of file paths relative to its root`,
                );
            const resourceEntry = {
                root,
                path: [...new Set(path as string[])],
                ...(files === undefined
                    ? {}
                    : { files: [...new Set(files as string[])] }),
            };
            for (const resource of installationReadPaths(resourceEntry))
                assertPublicResource(resource);
            return resourceEntry;
        });
    }
    return result;
}

function assertPublicResource(path: string): void {
    if (
        installationContains(path, "/__zerobox") ||
        installationContains("/__zerobox", path)
    )
        invalid("Installation resources cannot cover the internal runtime");
}

/** A file selection grants only the listed files, never its containing root. */
export function installationReadPaths(entry: InstallationRoot): string[] {
    return entry.files === undefined
        ? [entry.root]
        : entry.files.map((file) => resolve(entry.root, file));
}

/** Canonical roots persist the boundary rather than following a redirected alias. */
export function parseGlobalInstallations(
    value: unknown,
    canonicalize = false,
): GlobalInstallations {
    const declarations = validateGlobalInstallations(value);
    for (const [name, entries] of Object.entries(declarations)) {
        for (const entry of entries) {
            let root: string;
            try {
                root = realpathSync(entry.root);
            } catch {
                invalid(
                    `Installation ${name} root is unavailable: ${entry.root}`,
                );
            }
            if (!canonicalize && root !== entry.root)
                invalid(
                    `Installation ${name} root was redirected; authorize its canonical path: ${root}`,
                );
            if (!statSync(root).isDirectory())
                invalid(`Installation ${name} root must be a directory`);
            entry.root = root;
            for (const resource of installationReadPaths(entry)) {
                assertPublicResource(resource);
                if (entry.files === undefined) continue;
                let metadata;
                try {
                    metadata = statSync(resource);
                } catch {
                    invalid(
                        `Installation ${name} file is unavailable: ${resource}`,
                    );
                }
                if (!metadata.isFile())
                    invalid(
                        `Installation ${name} resource must be a regular file: ${resource}`,
                    );
            }
        }
    }
    return declarations;
}

export function parseInstallationSelection(
    value: unknown,
    scope: string,
): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string"))
        invalid(
            `${scope} environment.installations must be a list of global installation names`,
        );
    return [...new Set(value as string[])];
}

export function selectInstallations(
    global: unknown,
    project?: unknown,
    session?: unknown,
): SelectedInstallation[] {
    const installations = parseGlobalInstallations(global);
    const select = (value: unknown, ceiling: string[], scope: string) => {
        const selection = parseInstallationSelection(value, scope) ?? ceiling;
        for (const name of selection)
            if (!ceiling.includes(name))
                invalid(`Installation ${name} is outside the ${scope} ceiling`);
        return ceiling.filter((name) => selection.includes(name));
    };
    const selected = select(
        session,
        select(project, Object.keys(installations), "project"),
        "session",
    );
    const roots = selected.flatMap((name) =>
        installations[name].map((entry) => entry.root),
    );
    const result = selected.map((name) => ({
        name,
        roots: installations[name],
    }));
    const resources = result.flatMap((installation) =>
        installation.roots.flatMap((entry) =>
            installationReadPaths(entry).map((path) => ({
                path,
                directory: entry.files === undefined,
            })),
        ),
    );
    for (const installation of result) {
        for (const entry of installation.roots) {
            if (entry.files !== undefined)
                for (const file of installationReadPaths(entry)) {
                    const target = realpathSync(file);
                    assertPublicResource(target);
                    if (
                        !resources.some((resource) =>
                            resource.directory
                                ? installationContains(resource.path, target)
                                : resource.path === target,
                        )
                    )
                        invalid(
                            `Installation ${installation.name} file target is outside the authorized resources: ${target}`,
                        );
                }
            for (const part of entry.path) {
                const target = resolve(entry.root, part);
                let canonical: string;
                try {
                    canonical = realpathSync(target);
                } catch {
                    invalid(
                        `Installation ${installation.name} command directory is unavailable: ${target}`,
                    );
                }
                if (
                    !roots.some((root) => installationContains(root, canonical))
                )
                    invalid(
                        `Installation ${installation.name} command directory escapes the authorized roots: ${target}`,
                    );
                if (!statSync(canonical).isDirectory())
                    invalid(
                        `Installation ${installation.name} command path is not a directory: ${target}`,
                    );
            }
        }
    }
    return result;
}
