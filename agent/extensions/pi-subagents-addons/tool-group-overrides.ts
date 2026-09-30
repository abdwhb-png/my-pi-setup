import { createHash } from "node:crypto";
import {
    lstatSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentEntry } from "../_shared/subagents/workflow-agents.ts";
import { loadToolGroupsConfig } from "../_shared/tool-groups/config.ts";
import { resolveToolAliases } from "../_shared/tool-groups/resolver.ts";

export interface ToolGroupOverridesConfig {
    enabled: boolean;
    userAgentDirs: string[];
    projectAgentDirs: string[];
    agentTools: Record<string, string[]>;
}

function configStrings(value: unknown, field: string): string[] {
    if (
        !Array.isArray(value) ||
        !value.every(
            (item): item is string =>
                typeof item === "string" &&
                item.trim() === item &&
                item.length > 0 &&
                !/[?*]/.test(item),
        )
    )
        throw new Error(`Invalid toolGroupOverrides.${field}`);
    return [...value];
}

export function parseToolGroupOverridesConfig(
    value: unknown,
): ToolGroupOverridesConfig {
    if (value === undefined)
        return {
            enabled: false,
            userAgentDirs: [],
            projectAgentDirs: [],
            agentTools: {},
        };
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("enabled" in value) ||
        typeof value.enabled !== "boolean"
    )
        throw new Error("Invalid toolGroupOverrides.enabled");
    if (!value.enabled)
        return {
            enabled: false,
            userAgentDirs: [],
            projectAgentDirs: [],
            agentTools: {},
        };
    const userAgentDirs = configStrings(
        "userAgentDirs" in value
            ? value.userAgentDirs
            : ["agents", "~/.agents"],
        "userAgentDirs",
    );
    const projectAgentDirs = configStrings(
        "projectAgentDirs" in value
            ? value.projectAgentDirs
            : [".pi/agents", ".agents"],
        "projectAgentDirs",
    );
    if (
        projectAgentDirs.some(
            (path) =>
                isAbsolute(path) ||
                path.startsWith("~") ||
                path.split(/[\\/]/).includes(".."),
        )
    )
        throw new Error(
            "Invalid toolGroupOverrides.projectAgentDirs: paths must stay relative to the project",
        );
    const rawTools = "agentTools" in value ? value.agentTools : {};
    if (!rawTools || typeof rawTools !== "object" || Array.isArray(rawTools))
        throw new Error("Invalid toolGroupOverrides.agentTools");
    const agentTools = Object.fromEntries(
        Object.entries(rawTools).map(([name, tools]) => {
            const selectors = configStrings(tools, `agentTools.${name}`);
            if (!name.trim() || name.trim() !== name || !selectors.length)
                throw new Error(
                    `Invalid toolGroupOverrides.agentTools.${name}`,
                );
            return [name, selectors];
        }),
    );
    return { enabled: true, userAgentDirs, projectAgentDirs, agentTools };
}

export interface CompiledToolOverride {
    tools: string[] | "inherit";
    sources: string[];
}

export interface ToolGroupCompilation {
    global: Record<string, CompiledToolOverride>;
    project?: Record<string, CompiledToolOverride>;
}

export interface CompileToolGroupOverridesOptions {
    cwd: string;
    agentDir: string;
    projectTrusted: boolean;
    config: ToolGroupOverridesConfig;
    workflowAgents?: readonly WorkflowAgentEntry[];
}

interface Declaration {
    selectors?: string[];
    source: string;
    contentHash?: string;
}

function sourcePath(base: string, path: string): string {
    return path.startsWith("~/")
        ? resolve(homedir(), path.slice(2))
        : resolve(base, path);
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseDeclaration(
    content: string,
    path: string,
): { name: string; declaration: Declaration } | undefined {
    try {
        if (content.startsWith("---") && !content.includes("\n---", 3))
            throw new Error("Unclosed frontmatter");
        const { frontmatter } = parseFrontmatter(content);
        if (
            !frontmatter ||
            typeof frontmatter !== "object" ||
            Array.isArray(frontmatter)
        )
            throw new Error("Frontmatter must be an object");
        if (frontmatter.name === undefined && frontmatter.tools === undefined)
            return undefined;
        if (
            typeof frontmatter.name !== "string" ||
            !frontmatter.name.trim() ||
            typeof frontmatter.description !== "string" ||
            !frontmatter.description.trim()
        )
            throw new Error("Agent requires name and description");
        if (frontmatter.runner !== undefined) {
            const runner = frontmatter.runner;
            if (
                !runner ||
                typeof runner !== "object" ||
                Array.isArray(runner) ||
                !("type" in runner) ||
                runner.type !== "pi" ||
                Object.keys(runner).length !== 1
            )
                throw new Error(
                    "Unsupported runner; only native Pi declarations are supported",
                );
        }
        const packageName = frontmatter.package;
        if (
            packageName !== undefined &&
            packageName !== false &&
            packageName !== "" &&
            (typeof packageName !== "string" ||
                !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(
                    packageName,
                ))
        )
            throw new Error(
                "Use a canonical package identifier; implicit package sanitization is unsupported",
            );
        const name = packageName
            ? `${packageName}.${frontmatter.name}`
            : frontmatter.name;
        const value = frontmatter.tools;
        let selectors: string[] | undefined;
        if (value !== undefined) {
            const items = Array.isArray(value) ? value : [value];
            selectors = items.flatMap((item) => {
                if (typeof item !== "string" || !item.trim())
                    throw new Error("tools must contain nonempty strings");
                return item
                    .split(",")
                    .map((selector) => selector.trim())
                    .filter(Boolean);
            });
        }
        return {
            name,
            declaration: {
                selectors,
                source: path,
                contentHash: createHash("sha256").update(content).digest("hex"),
            },
        };
    } catch (error) {
        throw new Error(`Invalid agent ${path}: ${String(error)}`, {
            cause: error,
        });
    }
}

function readDeclarations(
    base: string,
    directories: string[],
): Map<string, Declaration> {
    const declarations = new Map<string, Declaration>();
    const seenRoots = new Set<string>();
    const seenFiles = new Set<string>();
    for (const directory of directories) {
        const declaredRoot = sourcePath(base, directory);
        try {
            lstatSync(declaredRoot);
        } catch (error) {
            if (isMissing(error)) continue;
            throw error;
        }
        const root = realpathSync(declaredRoot);
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        for (const entry of readdirSync(root, { withFileTypes: true }).toSorted(
            (left, right) => left.name.localeCompare(right.name),
        )) {
            if (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md"))
                continue;
            const path = join(root, entry.name);
            const actualPath = realpathSync(path);
            const relativePath = relative(root, actualPath);
            if (
                relativePath === ".." ||
                relativePath.startsWith(`..${sep}`) ||
                isAbsolute(relativePath)
            )
                throw new Error(`Agent symlink escapes declared root: ${path}`);
            if (!statSync(actualPath).isFile())
                throw new Error(`Agent source is not a file: ${path}`);
            if (seenFiles.has(actualPath)) continue;
            seenFiles.add(actualPath);
            const parsed = parseDeclaration(
                readFileSync(actualPath, "utf8"),
                actualPath,
            );
            if (!parsed) continue;
            const previous = declarations.get(parsed.name);
            if (previous)
                throw new Error(
                    `Ambiguous duplicate agent ${parsed.name}: ${previous.source}, ${actualPath}`,
                );
            declarations.set(parsed.name, parsed.declaration);
        }
    }
    return declarations;
}

function expandSelection(
    declaration: Declaration,
    groups: Record<string, string[]>,
): CompiledToolOverride {
    if (!declaration.selectors)
        return { tools: "inherit", sources: [declaration.source] };
    const available = [
        ...declaration.selectors,
        ...Object.values(groups).flat(),
    ].filter((value) => !value.startsWith("@") && !/[?*]/.test(value));
    const expanded = resolveToolAliases(
        declaration.selectors,
        available,
        groups,
    );
    const visitedMembers = [
        ...declaration.selectors,
        ...expanded.expandedAliases.flatMap(
            (alias) => groups[alias.slice(1)] ?? [],
        ),
    ];
    if (visitedMembers.some((value) => /[?*]/.test(value)))
        throw new Error(
            `${declaration.source}: wildcard tool selections are unsupported`,
        );
    if (visitedMembers.includes("@"))
        throw new Error(`${declaration.source}: empty group alias`);
    if (expanded.diagnostics.length)
        throw new Error(
            `${declaration.source}: ${expanded.diagnostics.map((d) => d.message).join("; ")}`,
        );
    return { tools: expanded.names, sources: [declaration.source] };
}

function compileLayer(
    declarations: Map<string, Declaration>,
    groups: Record<string, string[]>,
    requiredNames: string[],
): Record<string, CompiledToolOverride> {
    const required = new Set(requiredNames);
    return Object.fromEntries(
        [...declarations].flatMap(([name, declaration]) => {
            if (
                !required.has(name) &&
                !declaration.selectors?.some((selector) =>
                    selector.startsWith("@"),
                )
            )
                return [];
            return [[name, expandSelection(declaration, groups)]];
        }),
    );
}

function validateUpstreamSettings(path: string): void {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if (isMissing(error)) return;
        throw error;
    }
    try {
        const settings: unknown = JSON.parse(text);
        if (
            !settings ||
            typeof settings !== "object" ||
            Array.isArray(settings)
        )
            throw new Error("Expected settings object");
        if (!("subagents" in settings)) return;
        const subagents = settings.subagents;
        if (
            !subagents ||
            typeof subagents !== "object" ||
            Array.isArray(subagents)
        )
            throw new Error("Expected subagents object");
        for (const key of ["agentScanDirs", "agentExcludeDirs"] as const) {
            if (key in subagents)
                throw new Error(
                    `Unsupported subagents.${key}; declare bounded addon directories instead`,
                );
        }
        if (
            "projectRootResolution" in subagents &&
            subagents.projectRootResolution !== "nearest"
        )
            throw new Error(
                "Unsupported subagents.projectRootResolution; open the supported project root",
            );
        if ("agentOverridesByProvider" in subagents) {
            const providers = subagents.agentOverridesByProvider;
            if (
                !providers ||
                typeof providers !== "object" ||
                Array.isArray(providers)
            )
                throw new Error("Invalid agentOverridesByProvider");
            for (const entries of Object.values(providers)) {
                if (
                    !entries ||
                    typeof entries !== "object" ||
                    Array.isArray(entries)
                )
                    throw new Error("Invalid provider overrides");
                for (const override of Object.values(entries)) {
                    if (
                        !override ||
                        typeof override !== "object" ||
                        Array.isArray(override)
                    )
                        throw new Error("Invalid provider agent override");
                    if ("tools" in override)
                        throw new Error(
                            "Unsupported subagents.agentOverridesByProvider tools; selection must not depend on provider",
                        );
                }
            }
        }
    } catch (error) {
        throw new Error(`Invalid configuration ${path}: ${String(error)}`, {
            cause: error,
        });
    }
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

/** Refuse ancestor redirection rather than create a nested project or emulate discovery. */
function hasSupportedProject(cwd: string): boolean {
    const home = realpathSync(homedir());
    const root = realpathSync(cwd);
    if (root === home) return false;
    const supported =
        isDirectory(join(root, ".pi")) || isDirectory(join(root, ".agents"));
    for (let directory = root; directory !== home; ) {
        if (
            isDirectory(join(directory, ".pi")) ||
            isDirectory(join(directory, ".agents"))
        ) {
            if (!supported)
                throw new Error(
                    `Open the project root ${directory} before generating overrides; cwd ${root} is nested`,
                );
            validateUpstreamSettings(join(directory, ".pi", "settings.json"));
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return supported;
}

/** Compile a complete snapshot without mutating settings or source Markdown. */
export function compileToolGroupOverrides(
    options: CompileToolGroupOverridesOptions,
): ToolGroupCompilation | null {
    const { agentDir, cwd, config } = options;
    if (!config.enabled) return null;
    if (process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS?.trim())
        throw new Error(
            "Unsupported PI_SUBAGENT_EXTRA_AGENT_DIRS; declare addon source directories explicitly",
        );
    validateUpstreamSettings(join(agentDir, "settings.json"));
    const projectEnabled = options.projectTrusted && hasSupportedProject(cwd);
    const user = readDeclarations(agentDir, config.userAgentDirs);
    for (const entry of options.workflowAgents ?? []) {
        const parsed = parseDeclaration(
            entry.markdown,
            `workflow:${entry.name}`,
        );
        if (!parsed || parsed.name !== entry.name)
            throw new Error(`Invalid workflow identity: ${entry.name}`);
        const existing = user.get(entry.name);
        if (existing && existing.contentHash !== parsed.declaration.contentHash)
            throw new Error(
                `Conflicting workflow definition: ${entry.name}, ${existing.source}`,
            );
        user.set(entry.name, parsed.declaration);
    }
    const globalGroups = loadToolGroupsConfig(cwd, {
        agentDir,
        projectTrusted: false,
        strict: true,
    }).groups;
    const explicit = Object.entries(config.agentTools).map(
        ([name, selectors]): [string, Declaration] => [
            name,
            { selectors, source: `agentTools.${name}` },
        ],
    );
    const global = compileLayer(
        new Map([...user, ...explicit]),
        globalGroups,
        Object.keys(config.agentTools),
    );
    if (!projectEnabled) return { global };
    const local = readDeclarations(cwd, config.projectAgentDirs);
    const effective = new Map([...user, ...local, ...explicit]);
    const projectGroups = loadToolGroupsConfig(cwd, {
        agentDir,
        strict: true,
    }).groups;
    const project = compileLayer(effective, projectGroups, Object.keys(global));
    return { global, project };
}
