import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import {
    getAgentDir,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

type LinkEvent =
    | { kind: "inline"; destination: string }
    | { kind: "reference"; identifier: string };

export function resolveLocalMarkdownDestination(
    destination: string,
    sourceFilePath: string,
): string | null {
    const target = destination.trim().replace(/^<|>$/g, "");
    if (
        !target ||
        /^[a-z][a-z\d+.-]*:/i.test(target) ||
        target.startsWith("//")
    ) {
        return null;
    }

    const pathWithoutFragment = target.split(/[?#]/, 1)[0];
    if (
        !pathWithoutFragment ||
        ![".md", ".markdown"].includes(
            extname(pathWithoutFragment).toLowerCase(),
        )
    ) {
        return null;
    }

    return isAbsolute(pathWithoutFragment)
        ? resolve(pathWithoutFragment)
        : resolve(sourceFilePath, "..", pathWithoutFragment);
}

export type MarkdownLinksScope = "all" | "context";

export interface MarkdownLinksConfig {
    scope: MarkdownLinksScope;
    maxDepth: number;
    maxBytes: number;
    allowedRoots: string[];
}

const DEFAULT_CONFIG: MarkdownLinksConfig = {
    scope: "all",
    maxDepth: 10,
    maxBytes: 500_000,
    allowedRoots: ["$cwd", "$agentDir", "$agentDir/..", "$contextDirs"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(
    filePath: string,
): Promise<Record<string, unknown>> {
    try {
        const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function getMarkdownLinksSettings(
    settings: Record<string, unknown>,
): Record<string, unknown> {
    const value = settings.markdownLinks;
    return isRecord(value) ? value : {};
}

function validNonNegativeNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : fallback;
}

export interface ExpandAllowedRootsOptions {
    patterns: string[];
    cwd: string;
    agentDir: string;
    contextDirs: string[];
    homeDir?: string;
}

export function expandAllowedRoots(
    options: ExpandAllowedRootsOptions,
): string[] {
    const {
        patterns,
        cwd,
        agentDir,
        contextDirs,
        homeDir = homedir(),
    } = options;
    return patterns.flatMap((pattern) => {
        if (pattern === "$cwd") return [resolve(cwd)];
        if (pattern === "$agentDir") return [resolve(agentDir)];
        if (pattern === "$agentDir/..") return [resolve(agentDir, "..")];
        if (pattern === "$contextDirs")
            return contextDirs.map((dir) => resolve(dir));
        if (pattern === "~") return [resolve(homeDir)];
        if (pattern.startsWith("~/"))
            return [resolve(homeDir, pattern.slice(2))];
        return [resolve(pattern)];
    });
}

export async function loadMarkdownLinksConfig(
    cwd: string,
    agentDir: string = getAgentDir(),
    projectTrusted = true,
): Promise<MarkdownLinksConfig> {
    const globalSettings = getMarkdownLinksSettings(
        await readSettings(join(agentDir, "settings.json")),
    );
    const projectSettings = projectTrusted
        ? getMarkdownLinksSettings(
              await readSettings(join(cwd, ".pi", "settings.json")),
          )
        : {};
    const merged = { ...globalSettings, ...projectSettings };
    const scope =
        merged.scope === "context" || merged.scope === "all"
            ? merged.scope
            : DEFAULT_CONFIG.scope;
    const allowedRoots =
        Array.isArray(merged.allowedRoots) &&
        merged.allowedRoots.every(
            (root): root is string => typeof root === "string",
        )
            ? merged.allowedRoots
            : DEFAULT_CONFIG.allowedRoots;

    return {
        scope,
        maxDepth: validNonNegativeNumber(
            merged.maxDepth,
            DEFAULT_CONFIG.maxDepth,
        ),
        maxBytes: validNonNegativeNumber(
            merged.maxBytes,
            DEFAULT_CONFIG.maxBytes,
        ),
        allowedRoots,
    };
}

export interface MarkdownRoot {
    path: string;
    content: string;
}

export interface DiscoverMarkdownRootsOptions {
    cwd: string;
    agentDir: string;
    trusted: boolean;
    scope: MarkdownLinksScope;
    contextFiles: MarkdownRoot[];
}

async function readOptionalFile(
    filePath: string,
): Promise<MarkdownRoot | null> {
    try {
        return { path: filePath, content: await readFile(filePath, "utf8") };
    } catch {
        return null;
    }
}

async function discoverSystemRoot(
    cwd: string,
    agentDir: string,
    fileName: "SYSTEM.md" | "APPEND_SYSTEM.md",
    trusted: boolean,
): Promise<MarkdownRoot | null> {
    const projectRoot = trusted
        ? await readOptionalFile(join(cwd, ".pi", fileName))
        : null;
    return projectRoot ?? readOptionalFile(join(agentDir, fileName));
}

export async function discoverMarkdownRoots(
    options: DiscoverMarkdownRootsOptions,
): Promise<MarkdownRoot[]> {
    const roots = [...options.contextFiles];
    if (options.scope === "context") return roots;

    const seen = new Set(roots.map((root) => resolve(root.path)));
    const discoveredRoots = await Promise.all(
        (["SYSTEM.md", "APPEND_SYSTEM.md"] as const).map((fileName) =>
            discoverSystemRoot(
                options.cwd,
                options.agentDir,
                fileName,
                options.trusted,
            ),
        ),
    );
    for (const root of discoveredRoots) {
        if (!root) continue;
        const resolvedPath = resolve(root.path);
        if (seen.has(resolvedPath)) continue;
        seen.add(resolvedPath);
        roots.push(root);
    }
    return roots;
}

export interface ResolveLinkedMarkdownOptions {
    allowedRoots: string[];
    maxDepth?: number;
    maxBytes?: number;
}

export interface ResolvedMarkdownFile {
    path: string;
    content: string;
}

export interface ResolveLinkedMarkdownResult {
    files: ResolvedMarkdownFile[];
    skipped: string[];
    totalBytes: number;
}

async function canonicalize(filePath: string): Promise<string> {
    try {
        return await realpath(filePath);
    } catch {
        return resolve(filePath);
    }
}

function isWithinRoot(candidate: string, root: string): boolean {
    const pathRelative = relative(root, candidate);
    return (
        pathRelative === "" ||
        (!pathRelative.startsWith("..") && !pathRelative.includes(`..${sep}`))
    );
}

export async function resolveLinkedMarkdownFiles(
    roots: MarkdownRoot[],
    options: ResolveLinkedMarkdownOptions,
): Promise<ResolveLinkedMarkdownResult> {
    const maxDepth = options.maxDepth ?? 10;
    const maxBytes = options.maxBytes ?? 500_000;
    const allowedRoots = await Promise.all(
        options.allowedRoots.map(canonicalize),
    );
    const visited = new Set<string>();
    const files: ResolvedMarkdownFile[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;

    const processFile = async (
        filePath: string,
        content: string,
        depth: number,
    ): Promise<void> => {
        const canonicalPath = await canonicalize(filePath);
        if (visited.has(canonicalPath)) return;
        visited.add(canonicalPath);

        const destinations = await extractMarkdownLinks(content);
        for (const destination of destinations) {
            const linkedPath = resolveLocalMarkdownDestination(
                destination,
                canonicalPath,
            );
            if (!linkedPath) continue;

            if (depth + 1 > maxDepth) {
                skipped.push(`${destination}: max depth exceeded`);
                continue;
            }

            // Sequential resolution preserves source order and global byte limits.
            // oxlint-disable-next-line no-await-in-loop
            const canonicalLinkedPath = await canonicalize(linkedPath);
            if (
                !allowedRoots.some((root) =>
                    isWithinRoot(canonicalLinkedPath, root),
                )
            ) {
                skipped.push(`${destination}: outside allowed roots`);
                continue;
            }
            if (visited.has(canonicalLinkedPath)) {
                skipped.push(`${destination}: already included`);
                continue;
            }

            let linkedContent: string;
            try {
                // Sequential resolution preserves source order and global byte limits.
                // oxlint-disable-next-line no-await-in-loop
                linkedContent = await readFile(canonicalLinkedPath, "utf8");
            } catch {
                skipped.push(`${destination}: file unavailable`);
                continue;
            }

            const bytes = Buffer.byteLength(linkedContent, "utf8");
            if (totalBytes + bytes > maxBytes) {
                skipped.push(`${destination}: size limit exceeded`);
                continue;
            }

            totalBytes += bytes;
            files.push({ path: canonicalLinkedPath, content: linkedContent });
            // Sequential resolution preserves source order and global byte limits.
            // oxlint-disable-next-line no-await-in-loop
            await processFile(canonicalLinkedPath, linkedContent, depth + 1);
        }
    };

    for (const root of roots) {
        // Sequential resolution preserves source order and global byte limits.
        // oxlint-disable-next-line no-await-in-loop
        await processFile(root.path, root.content, 0);
    }

    return { files, skipped, totalBytes };
}

function normalizeIdentifier(identifier: string): string {
    return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

interface ScanSnapshot {
    config: MarkdownLinksConfig;
    roots: MarkdownRoot[];
    result?: ResolveLinkedMarkdownResult;
    error?: string;
}

export default function markdownLinksExtension(pi: ExtensionAPI): void {
    let config: MarkdownLinksConfig = {
        ...DEFAULT_CONFIG,
        allowedRoots: [...DEFAULT_CONFIG.allowedRoots],
    };
    let agentDir = getAgentDir();
    let lastScan: ScanSnapshot | null = null;

    pi.on("session_start", async (_event, context) => {
        agentDir = getAgentDir();
        config = await loadMarkdownLinksConfig(
            context.cwd,
            agentDir,
            context.isProjectTrusted(),
        );
        lastScan = null;
    });

    pi.registerCommand("markdown-links:status", {
        description: "Show Markdown link expansion status",
        handler: (_args, context) =>
            Promise.resolve().then(() => {
                if (!lastScan) {
                    context.ui.notify("No scan data yet.", "info");
                    return;
                }

                const lines = [
                    "**pi-markdown-links**",
                    `scope: ${lastScan.config.scope}`,
                    `maxDepth: ${lastScan.config.maxDepth}`,
                    `maxBytes: ${lastScan.config.maxBytes}`,
                    `roots: ${lastScan.roots.length}`,
                ];
                if (lastScan.error) lines.push(`error: ${lastScan.error}`);
                if (lastScan.result) {
                    lines.push(
                        `included: ${lastScan.result.files.length} files, ${lastScan.result.totalBytes} bytes`,
                        `skipped: ${lastScan.result.skipped.length}`,
                    );
                }
                context.ui.notify(lines.join("\n"), "info");
            }),
    });

    pi.on("before_agent_start", async (event, context) => {
        const contextFiles = event.systemPromptOptions.contextFiles ?? [];
        if (contextFiles.length === 0) return undefined;

        const roots = await discoverMarkdownRoots({
            cwd: event.systemPromptOptions.cwd,
            agentDir,
            trusted:
                typeof context.isProjectTrusted === "function" &&
                context.isProjectTrusted(),
            scope: config.scope,
            contextFiles,
        });
        const allowedRoots = expandAllowedRoots({
            patterns: config.allowedRoots,
            cwd: event.systemPromptOptions.cwd,
            agentDir,
            contextDirs: roots.map((root) => dirname(root.path)),
        });

        try {
            const result = await resolveLinkedMarkdownFiles(roots, {
                allowedRoots,
                maxDepth: config.maxDepth,
                maxBytes: config.maxBytes,
            });
            lastScan = { config, roots, result };
            if (result.files.length === 0) return undefined;

            const sections = result.files
                .map(
                    ({ path, content }) =>
                        `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
                )
                .join("\n\n");
            return {
                systemPrompt: `${event.systemPrompt}\n\nAdditional Markdown files included by links:\n\n${sections}`,
            };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            lastScan = { config, roots, error: message };
            return undefined;
        }
    });
}

export async function extractMarkdownLinks(source: string): Promise<string[]> {
    const { defineMdastPlugin, markdownToHtml } = await import("satteri");
    const events: LinkEvent[] = [];
    const definitions = new Map<string, string>();

    const collector = defineMdastPlugin({
        name: "pi-markdown-links-collector",
        link(node) {
            events.push({ kind: "inline", destination: node.url });
        },
        linkReference(node) {
            events.push({ kind: "reference", identifier: node.identifier });
        },
        definition(node) {
            definitions.set(normalizeIdentifier(node.identifier), node.url);
        },
    });

    markdownToHtml(source, { mdastPlugins: [collector] });

    return events.flatMap((event) => {
        if (event.kind === "inline") return [event.destination];
        const destination = definitions.get(
            normalizeIdentifier(event.identifier),
        );
        return destination ? [destination] : [];
    });
}
