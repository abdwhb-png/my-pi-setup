import { randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
    persistedCapabilityPath,
    readGlobalSandboxConfig,
    readProjectSandboxConfig,
    sandboxConfigPath,
} from "./authority.ts";
import {
    parseGlobalInstallations,
    validateGlobalInstallations,
    parseInstallationSelection,
    selectInstallations,
    type GlobalInstallations,
} from "./installations.ts";

type ManageInstallationsOptions = {
    agentDir: string;
    machineId: string;
    onChanged: () => Promise<void>;
};

const ACTIONS = [
    "Global: Add",
    "Global: Edit",
    "Global: Revoke",
    "Project: Select",
    "Project: Inherit",
    "Project: None",
    "Cancel",
] as const;

type Action = (typeof ACTIONS)[number];

function toMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readBytes(path: string): Buffer | undefined {
    if (!existsSync(path)) return undefined;
    return readFileSync(path);
}

function sameBytes(
    left: Buffer | undefined,
    right: Buffer | undefined,
): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left.byteLength !== right.byteLength) return false;
    return left.equals(right);
}

function sortUnique(values: string[]): string[] {
    return [...new Set(values)].toSorted();
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new Error(`Invalid JSON: ${toMessage(error)}`, { cause: error });
    }
}

function parseProjectSelection(raw: string | undefined): string[] {
    if (!raw) return [];
    return sortUnique(
        raw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
}

function formatInstallations(declarations: GlobalInstallations): string {
    const entries = Object.entries(declarations);
    if (entries.length === 0) return "- (none)";
    return entries
        .map(([name, roots]) => {
            const details = roots
                .map((entry) =>
                    entry.path.length === 0
                        ? `${entry.root} (read-only)`
                        : `${entry.root} (read-only); PATH: ${entry.path.map((part) => join(entry.root, part)).join(", ")}`,
                )
                .join("; ");
            return `- ${name}: ${details}`;
        })
        .join("\n");
}

function describeProjectSelection(
    selection: string[] | undefined,
    globalNames: string[],
): string {
    if (selection === undefined)
        return `inherit (${globalNames.join(", ") || "none"})`;
    return selection.length === 0
        ? "none"
        : globalNames.filter((name) => selection.includes(name)).join(", ");
}

function readConfigRaw(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};

    const metadata = lstatSync(path);
    const owner = process.getuid?.();
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o022) !== 0 ||
        (owner !== undefined && metadata.uid !== owner)
    ) {
        throw new Error(`Configuration file is not trusted: ${path}`);
    }

    const value = parseJson(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Configuration file is not a JSON object: ${path}`);
    }

    return value as Record<string, unknown>;
}

function preserveEnvironment(
    raw: Record<string, unknown>,
    installations: Record<string, unknown>,
    machineId: string,
): Record<string, unknown> {
    const environmentRaw =
        raw.environment !== undefined &&
        typeof raw.environment === "object" &&
        raw.environment !== null &&
        !Array.isArray(raw.environment)
            ? { ...raw.environment }
            : {};

    return {
        ...raw,
        version: 2,
        machineId,
        environment: {
            ...environmentRaw,
            installations,
        },
    };
}

function persistInstallations(
    declarations: GlobalInstallations,
): Record<string, unknown> {
    const persisted: Record<string, unknown> = {};
    for (const [name, entries] of Object.entries(declarations)) {
        persisted[name] = entries.map((entry) => ({
            root: persistedCapabilityPath(entry.root),
            path: [...new Set(entry.path)],
        }));
    }
    return persisted;
}

async function saveConfig(
    path: string,
    before: Buffer | undefined,
    next: Record<string, unknown>,
) {
    await withFileMutationQueue(path, async () => {
        const current = readBytes(path);
        if (!sameBytes(before, current)) {
            throw new Error(`Configuration changed while editing: ${path}`);
        }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = join(dirname(path), `.sandbox-${randomUUID()}.tmp`);
        try {
            writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
                mode: 0o600,
                flag: "wx",
            });
            renameSync(temporary, path);
        } catch (error) {
            if (existsSync(temporary)) unlinkSync(temporary);
            throw error;
        }
    });
}

function parseAddOrEditPayload(
    name: string,
    body: string,
): GlobalInstallations {
    const raw = parseJson(body);
    if (!Array.isArray(raw)) {
        throw new Error(`Editor input for ${name} must be an array`);
    }
    return parseGlobalInstallations({ [name]: raw }, true);
}

function globalSummary(raw: unknown): {
    installations: GlobalInstallations;
    canonicalized: boolean;
    diagnostics?: string;
} {
    try {
        return {
            installations: parseGlobalInstallations(raw, true),
            canonicalized: true,
        };
    } catch (error) {
        return {
            installations: validateGlobalInstallations(raw),
            canonicalized: false,
            diagnostics: toMessage(error),
        };
    }
}

export async function manageInstallations(
    ctx: ExtensionCommandContext,
    options: ManageInstallationsOptions,
): Promise<void> {
    if (!ctx.hasUI) {
        ctx.ui.notify(
            "Usage: /sandbox installations is interactive only. Run this command from a UI session.",
        );
        return;
    }

    const globalPath = sandboxConfigPath(options.agentDir);
    const projectPath = join(ctx.cwd, ".pi", "sandbox.json");

    try {
        const globalConfig = readGlobalSandboxConfig(
            globalPath,
            options.machineId,
        );
        const projectConfig = readProjectSandboxConfig(projectPath);

        const globalSource = globalSummary(
            globalConfig?.environment?.installations,
        );
        const projectSource = describeProjectSelection(
            parseInstallationSelection(
                projectConfig?.environment?.installations,
                "project",
            ),
            Object.keys(globalSource.installations),
        );
        const status = [
            "Installations",
            `Global declaration summary:\n${formatInstallations(globalSource.installations)}`,
            `Project configured selection: ${projectSource}`,
            "Permissions apply only after the next successful admission. Project filesystem restrictions and denials remain in force.",
            globalSource.canonicalized
                ? "Global installation roots were canonicalized for preview."
                : `Global installation preview has unresolved roots: ${globalSource.diagnostics}`,
        ].join("\n\n");

        const action = (await ctx.ui.select(`${status}\n\nChoose an action`, [
            ...ACTIONS,
        ])) as Action | undefined;

        if (!action || action === "Cancel") return;

        if (
            action === "Global: Add" ||
            action === "Global: Edit" ||
            action === "Global: Revoke"
        ) {
            const declarations = validateGlobalInstallations(
                globalConfig?.environment?.installations,
            );
            const rawGlobal = readConfigRaw(globalPath);
            const snapshot = readBytes(globalPath);

            if (action === "Global: Revoke") {
                const choices = sortUnique(Object.keys(declarations));
                if (choices.length === 0) {
                    ctx.ui.notify("No global installation to revoke.");
                    return;
                }
                const name = await ctx.ui.select(
                    "Select a global installation to revoke.",
                    choices,
                );
                if (!name) return;
                const next = { ...declarations };
                delete next[name];
                const persisted = persistInstallations(next);

                const preview = [
                    "Remove this global installation and save this change:",
                    formatInstallations(next),
                ].join("\n");
                if (!(await ctx.ui.confirm("Revoke installation", preview)))
                    return;

                await saveConfig(
                    globalPath,
                    snapshot,
                    preserveEnvironment(
                        rawGlobal,
                        persisted,
                        options.machineId,
                    ),
                );
                await options.onChanged();
                return;
            }

            const names = sortUnique(Object.keys(declarations));
            const name =
                action === "Global: Add"
                    ? await ctx.ui.input(
                          "Enter a new global installation name.",
                      )
                    : await ctx.ui.select(
                          "Select an installation to edit:",
                          names,
                      );

            if (!name) return;
            if (action === "Global: Add" && names.includes(name)) {
                ctx.ui.notify(
                    `Global installation ${name} already exists. Use Edit to change it.`,
                    "warning",
                );
                return;
            }
            if (action === "Global: Edit" && !names.includes(name)) return;

            const explanation =
                'Use JSON array format.\nExample:\n  [{"root": "~/tools", "path": ["bin"]}]\n\n' +
                "Each root is read-only and each path is a command subdirectory relative to the root.";

            const currentRoots =
                action === "Global: Edit" && declarations[name]
                    ? declarations[name]
                    : [];
            const draft = await ctx.ui.editor(
                explanation,
                JSON.stringify(currentRoots, null, 2),
            );
            if (!draft) return;

            const parsed = parseAddOrEditPayload(name, draft);
            const next = {
                ...declarations,
                ...parsed,
            };
            const persisted = persistInstallations(next);

            selectInstallations(next);
            const canonical = parseGlobalInstallations(next);
            const preview = [
                "Preview canonical paths:",
                formatInstallations(canonical),
                `Save changes to global installation ${name}?`,
            ].join("\n");

            if (!(await ctx.ui.confirm("Authorize installation", preview)))
                return;

            await saveConfig(
                globalPath,
                snapshot,
                preserveEnvironment(rawGlobal, persisted, options.machineId),
            );
            await options.onChanged();
            return;
        }

        if (!ctx.isProjectTrusted()) {
            ctx.ui.notify(
                "Project installation changes require trusted-project context.",
                "warning",
            );
            return;
        }

        const rawProject = readConfigRaw(projectPath);
        const projectSnapshot = readBytes(projectPath);
        const available = sortUnique(
            Object.keys(globalConfig?.environment?.installations ?? {}),
        );

        if (action === "Project: Inherit") {
            const next = {
                ...rawProject,
                environment: {
                    ...(projectConfig?.environment &&
                    typeof projectConfig.environment === "object" &&
                    !Array.isArray(projectConfig.environment)
                        ? projectConfig.environment
                        : {}),
                    ...(projectConfig?.environment as object | undefined),
                },
            } as Record<string, unknown>;
            if (
                next.environment &&
                typeof next.environment === "object" &&
                !Array.isArray(next.environment)
            ) {
                delete (next.environment as Record<string, unknown>)
                    .installations;
            }

            if (
                !(await ctx.ui.confirm(
                    "Inherit global installations",
                    "Clear explicit project installation overrides?",
                ))
            )
                return;

            await saveConfig(projectPath, projectSnapshot, next);
            await options.onChanged();
            return;
        }

        if (action === "Project: None") {
            const next = {
                ...rawProject,
                environment: {
                    ...(projectConfig?.environment &&
                    typeof projectConfig.environment === "object" &&
                    !Array.isArray(projectConfig.environment)
                        ? projectConfig.environment
                        : {}),
                    installations: [],
                },
            } as Record<string, unknown>;
            if (
                !(await ctx.ui.confirm(
                    "Remove project installations",
                    "Set project installation selection to none?",
                ))
            )
                return;
            await saveConfig(projectPath, projectSnapshot, next);
            await options.onChanged();
            return;
        }

        const selection = await ctx.ui.input(
            available.length
                ? `Comma-separated global installations to use. Available: ${available.join(", ")}`
                : "No global installation to choose",
        );
        if (selection === undefined) return;
        const names = parseProjectSelection(selection);

        const unknown = names.filter((name) => !available.includes(name));
        if (unknown.length > 0) {
            ctx.ui.notify(
                `Unknown global installation names: ${unknown.join(", ")}`,
                "warning",
            );
            return;
        }

        const next = {
            ...rawProject,
            environment: {
                ...(projectConfig?.environment &&
                typeof projectConfig.environment === "object" &&
                !Array.isArray(projectConfig.environment)
                    ? projectConfig.environment
                    : {}),
                installations: names,
            },
        } as Record<string, unknown>;

        const selected = selectInstallations(
            globalConfig?.environment?.installations,
            names,
        );
        const preview = formatInstallations(
            Object.fromEntries(
                selected.map((installation) => [
                    installation.name,
                    installation.roots,
                ]),
            ),
        );
        if (
            !(await ctx.ui.confirm(
                "Select project installations",
                `Apply project selection: ${
                    names.length ? names.join(", ") : "(none)"
                }?\n\n${preview}`,
            ))
        )
            return;

        await saveConfig(projectPath, projectSnapshot, next);
        await options.onChanged();
    } catch (error) {
        ctx.ui.notify(
            `Failed to manage installations: ${toMessage(error)}`,
            "error",
        );
    }
}
