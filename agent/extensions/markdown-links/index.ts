import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
    getAgentDir,
    stripFrontmatter,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
    isMarkdownLinkTransformRequest,
    MARKDOWN_LINKS_TRANSFORM_EVENT,
} from "../_shared/markdown-links.ts";
import { findInvokedSlashCommand } from "../_shared/slash-command-source.ts";
import {
    collectMarkdownLinkSourceSlices,
    transformMarkdownLinks,
    type MarkdownLinkDiagnostic,
    type MarkdownParser,
    type TransformMarkdownLinksResult,
} from "./transform.ts";

export interface MarkdownLinksConfig {
    allowedRoots: string[];
}

const DEFAULT_CONFIG: MarkdownLinksConfig = {
    allowedRoots: ["$cwd", "$agentDir", "$agentDir/..", "$sourceDir"],
};
const MAX_STATUS_DIAGNOSTICS = 20;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

interface PromptProvenance {
    sourcePath: string;
    allowedSourceSlices: ReadonlyMap<string, number>;
}

interface StatusSnapshot {
    processed: number;
    rewritten: number;
    sources: Map<string, number>;
    diagnostics: MarkdownLinkDiagnostic[];
}

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

function markdownLinksSettings(
    settings: Record<string, unknown>,
): Record<string, unknown> {
    const value = settings.markdownLinks;
    return isRecord(value) ? value : {};
}

function configuredRoots(
    settings: Record<string, unknown>,
): string[] | undefined {
    const roots = settings.allowedRoots;
    return Array.isArray(roots) &&
        roots.every((root): root is string => typeof root === "string")
        ? roots
        : undefined;
}

export async function loadMarkdownLinksConfig(
    cwd: string,
    agentDir: string = getAgentDir(),
    projectTrusted = true,
): Promise<MarkdownLinksConfig> {
    const globalSettings = markdownLinksSettings(
        await readSettings(join(agentDir, "settings.json")),
    );
    const projectSettings = projectTrusted
        ? markdownLinksSettings(
              await readSettings(join(cwd, ".pi", "settings.json")),
          )
        : {};

    return {
        allowedRoots: configuredRoots(projectSettings) ??
            configuredRoots(globalSettings) ?? [...DEFAULT_CONFIG.allowedRoots],
    };
}

export interface ExpandAllowedRootsOptions {
    patterns: string[];
    cwd: string;
    agentDir: string;
    sourcePath: string;
    homeDir?: string;
}

export function expandAllowedRoots(
    options: ExpandAllowedRootsOptions,
): string[] {
    const sourceDir = dirname(options.sourcePath);
    const homeDir = options.homeDir ?? homedir();

    return options.patterns.map((pattern) => {
        if (pattern === "$cwd") return resolve(options.cwd);
        if (pattern === "$agentDir") return resolve(options.agentDir);
        if (pattern === "$agentDir/..") return resolve(options.agentDir, "..");
        if (pattern === "$sourceDir" || pattern === "$contextDirs") {
            return resolve(sourceDir);
        }
        if (pattern === "~") return resolve(homeDir);
        if (pattern.startsWith("~/")) {
            return resolve(homeDir, pattern.slice(2));
        }
        return resolve(pattern);
    });
}

function isMarkdownSourcePath(path: string): boolean {
    return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

function expandInputPath(path: string, cwd: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function canonicalSourcePath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

async function loadParser(): Promise<MarkdownParser> {
    const { markdownToMdast, mdxToMdast } = await import("satteri");
    return { markdownToMdast, mdxToMdast };
}

function replaceOnce(source: string, before: string, after: string): string {
    if (before === after) return source;
    const index = source.indexOf(before);
    if (index < 0) return source;
    return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function discoverDefaultPromptSource(
    cwd: string,
    agentDir: string,
    fileName: "SYSTEM.md" | "APPEND_SYSTEM.md",
    projectTrusted: boolean,
): string | undefined {
    const projectPath = join(cwd, ".pi", fileName);
    if (projectTrusted && existsSync(projectPath)) return projectPath;
    const globalPath = join(agentDir, fileName);
    return existsSync(globalPath) ? globalPath : undefined;
}

function transformSkillBlocks(
    content: string,
    cwd: string,
    transform: (
        sourcePath: string,
        content: string,
        cwd: string,
        sourceKind: string,
    ) => TransformMarkdownLinksResult,
): string {
    return content.replace(
        /<skill\b[^>]*\blocation="([^"]+)"[^>]*>([\s\S]*?)<\/skill>/g,
        (block, sourcePath: string, body: string) => {
            const result = transform(
                canonicalSourcePath(sourcePath),
                body,
                cwd,
                "skill-message",
            );
            return block.replace(body, result.content);
        },
    );
}

export default function markdownLinksExtension(pi: ExtensionAPI): void {
    let agentDir = getAgentDir();
    let config: MarkdownLinksConfig = {
        allowedRoots: [...DEFAULT_CONFIG.allowedRoots],
    };
    let parser: MarkdownParser | undefined;
    let parserError: string | undefined;
    let sessionCwd = process.cwd();
    let sessionProjectTrusted = false;
    let idlePrompt: PromptProvenance | null = null;
    let confirmedIdlePrompt: PromptProvenance | null = null;
    const streamingPrompts: Array<PromptProvenance | null> = [];
    let status: StatusSnapshot = {
        processed: 0,
        rewritten: 0,
        sources: new Map(),
        diagnostics: [],
    };

    const recordDiagnostics = (diagnostics: MarkdownLinkDiagnostic[]): void => {
        const remaining = MAX_STATUS_DIAGNOSTICS - status.diagnostics.length;
        if (remaining > 0) {
            status.diagnostics.push(...diagnostics.slice(0, remaining));
        }
    };

    const transform = (
        sourcePath: string,
        content: string,
        cwd: string,
        sourceKind: string,
        allowedSourceSlices?: ReadonlyMap<string, number>,
    ): TransformMarkdownLinksResult => {
        status.processed++;
        status.sources.set(
            sourceKind,
            (status.sources.get(sourceKind) ?? 0) + 1,
        );
        if (!parser) {
            const diagnostic: MarkdownLinkDiagnostic = {
                sourcePath,
                reason: "parser-error",
                message: parserError ?? "Markdown parser is not initialized",
            };
            recordDiagnostics([diagnostic]);
            return { content, rewritten: 0, diagnostics: [diagnostic] };
        }

        const result = transformMarkdownLinks(
            content,
            {
                sourcePath,
                cwd,
                allowedRoots: expandAllowedRoots({
                    patterns: config.allowedRoots,
                    cwd,
                    agentDir,
                    sourcePath,
                }),
                ...(allowedSourceSlices ? { allowedSourceSlices } : {}),
            },
            parser,
        );
        status.rewritten += result.rewritten;
        recordDiagnostics(result.diagnostics);
        return result;
    };

    const resetProvenance = (): void => {
        idlePrompt = null;
        confirmedIdlePrompt = null;
        streamingPrompts.length = 0;
    };

    const offTransform = pi.events.on(
        MARKDOWN_LINKS_TRANSFORM_EVENT,
        (value) => {
            if (!isMarkdownLinkTransformRequest(value)) return;
            const sourcePath = canonicalSourcePath(value.sourcePath);
            if (!isMarkdownSourcePath(sourcePath)) return;
            value.result = transform(
                sourcePath,
                value.content,
                value.cwd,
                value.sourceKind,
            ).content;
        },
    );

    pi.on("session_start", async (_event, context) => {
        agentDir = getAgentDir();
        sessionCwd = context.cwd;
        sessionProjectTrusted = context.isProjectTrusted();
        config = await loadMarkdownLinksConfig(
            sessionCwd,
            agentDir,
            sessionProjectTrusted,
        );
        status = {
            processed: 0,
            rewritten: 0,
            sources: new Map(),
            diagnostics: [],
        };
        resetProvenance();
        try {
            parser = await loadParser();
            parserError = undefined;
        } catch (error) {
            parser = undefined;
            parserError =
                error instanceof Error ? error.message : String(error);
        }
    });

    pi.on("session_shutdown", () => {
        resetProvenance();
        offTransform();
    });

    pi.on("agent_settled", () => {
        resetProvenance();
    });

    pi.registerCommand("markdown-links:status", {
        description: "Show source-aware Markdown link rewrite status",
        handler: async (_args, context) => {
            const sources = [...status.sources.entries()]
                .map(([name, count]) => `${name}=${count}`)
                .join(", ");
            const lines = [
                "**pi-markdown-links**",
                `processed: ${status.processed}`,
                `rewritten: ${status.rewritten}`,
                `sources: ${sources || "none"}`,
                `diagnostics: ${status.diagnostics.length}`,
            ];
            for (const diagnostic of status.diagnostics) {
                const location = diagnostic.line
                    ? `${diagnostic.sourcePath}:${diagnostic.line}`
                    : diagnostic.sourcePath;
                lines.push(`- ${diagnostic.reason}: ${location}`);
            }
            context.ui.notify(lines.join("\n"), "info");
        },
    });

    pi.on("input", (event) => {
        let provenance: PromptProvenance | null = null;
        const command = findInvokedSlashCommand(pi.getCommands(), event.text, [
            "prompt",
        ]);
        if (command?.sourceInfo && parser) {
            try {
                const sourcePath = canonicalSourcePath(command.sourceInfo.path);
                const body = stripFrontmatter(readFileSync(sourcePath, "utf8"));
                provenance = {
                    sourcePath,
                    allowedSourceSlices: collectMarkdownLinkSourceSlices(
                        body,
                        sourcePath,
                        parser,
                    ),
                };
            } catch (error) {
                recordDiagnostics([
                    {
                        sourcePath: command.sourceInfo.path,
                        reason: "source-correlation",
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                ]);
            }
        }

        if (event.streamingBehavior) streamingPrompts.push(provenance);
        else idlePrompt = provenance;
        return { action: "continue" as const };
    });

    pi.on("before_agent_start", (event) => {
        confirmedIdlePrompt = idlePrompt;
        idlePrompt = null;

        let systemPrompt = event.systemPrompt;
        const cwd = event.systemPromptOptions.cwd;
        const projectTrusted = sessionProjectTrusted;
        const knownPromptSources = [
            {
                path: discoverDefaultPromptSource(
                    cwd,
                    agentDir,
                    "SYSTEM.md",
                    projectTrusted,
                ),
                option: event.systemPromptOptions.customPrompt,
                kind: "system",
            },
            {
                path: discoverDefaultPromptSource(
                    cwd,
                    agentDir,
                    "APPEND_SYSTEM.md",
                    projectTrusted,
                ),
                option: event.systemPromptOptions.appendSystemPrompt,
                kind: "append-system",
            },
        ];

        for (const source of knownPromptSources) {
            if (!source.path || source.option === undefined) continue;
            try {
                const original = readFileSync(source.path, "utf8");
                if (original !== source.option) continue;
                const result = transform(
                    canonicalSourcePath(source.path),
                    original,
                    cwd,
                    source.kind,
                );
                systemPrompt = replaceOnce(
                    systemPrompt,
                    original,
                    result.content,
                );
            } catch {
                continue;
            }
        }

        for (const contextFile of event.systemPromptOptions.contextFiles ??
            []) {
            const sourcePath = canonicalSourcePath(contextFile.path);
            if (!isMarkdownSourcePath(sourcePath)) continue;
            const result = transform(
                sourcePath,
                contextFile.content,
                cwd,
                "context-file",
            );
            const before = `<project_instructions path="${contextFile.path}">\n${contextFile.content}\n</project_instructions>`;
            const after = `<project_instructions path="${contextFile.path}">\n${result.content}\n</project_instructions>`;
            systemPrompt = replaceOnce(systemPrompt, before, after);
        }

        return systemPrompt === event.systemPrompt
            ? undefined
            : { systemPrompt };
    });

    pi.on("message_end", (event) => {
        if (event.message.role !== "user") return undefined;
        const provenance =
            confirmedIdlePrompt ?? streamingPrompts.shift() ?? null;
        confirmedIdlePrompt = null;
        const transformText = (content: string): string => {
            let transformed = transformSkillBlocks(
                content,
                sessionCwd,
                transform,
            );
            if (provenance) {
                transformed = transform(
                    provenance.sourcePath,
                    transformed,
                    sessionCwd,
                    "prompt-message",
                    provenance.allowedSourceSlices,
                ).content;
            }
            return transformed;
        };

        if (typeof event.message.content === "string") {
            const content = transformText(event.message.content);
            if (content === event.message.content) return undefined;
            return { message: { ...event.message, content } };
        }

        let changed = false;
        const content = event.message.content.map((block) => {
            if (block.type !== "text") return block;
            const text = transformText(block.text);
            if (text !== block.text) changed = true;
            return text === block.text ? block : { ...block, text };
        });
        return changed ? { message: { ...event.message, content } } : undefined;
    });

    pi.on("tool_result", (event, context) => {
        if (
            event.toolName !== "read" ||
            event.isError ||
            typeof event.input.path !== "string"
        ) {
            return undefined;
        }
        const sourcePath = canonicalSourcePath(
            expandInputPath(event.input.path, context.cwd),
        );
        if (!isMarkdownSourcePath(sourcePath)) return undefined;
        if (typeof event.input.offset === "number" && event.input.offset > 1) {
            recordDiagnostics([
                {
                    sourcePath,
                    reason: "partial-source-context",
                    message:
                        "Read started after line 1; source offsets are incomplete",
                },
            ]);
            return undefined;
        }

        let changed = false;
        const content = event.content.map((block) => {
            if (block.type !== "text") return block;
            const result = transform(
                sourcePath,
                block.text,
                context.cwd,
                "read-tool",
            );
            if (result.content !== block.text) changed = true;
            return result.content === block.text
                ? block
                : { ...block, text: result.content };
        });
        return changed ? { content } : undefined;
    });
}
