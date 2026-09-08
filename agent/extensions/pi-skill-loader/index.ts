import { readFile } from "node:fs/promises";
import {
    defineTool,
    getMarkdownTheme,
    keyText,
    type AgentToolResult,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { requestMarkdownLinkTransform } from "../_shared/markdown-links.ts";
import {
    extractDollarPrefix,
    findDollarSkills,
    rewriteDollarTokenToSkillRef,
    transformDollarSkillInput,
} from "./dollar-skill.ts";
import {
    buildSkillList,
    findSkill,
    searchSkills,
    type SkillEntry,
} from "./skill-index";
import {
    discoverSkillFallbacks,
    formatRescuedSkillBlock,
    getSkillRoots,
    type RescuedSkill,
} from "./skill-rescue.ts";

export type { RescuedSkill };
export {
    discoverSkillFallbacks,
    formatRescuedSkillBlock,
    getSkillRoots,
    transformDollarSkillInput,
};

export default function piSkillLoader(pi: ExtensionAPI): void {
    let skillList: SkillEntry[] = [];
    let rescuedSkills: RescuedSkill[] = [];

    const refreshSkillList = () => {
        skillList = buildSkillList(pi.getCommands(), rescuedSkills);
    };

    const sendLoadedSkills = async (
        skills: SkillEntry[],
        cwd: string,
        sourceKind: string,
    ): Promise<string[]> => {
        const loadedNames: string[] = [];
        const loadedContents: string[] = [];
        for (const skill of skills) {
            try {
                const raw =
                    skill.content ??
                    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve mention order
                    (await readFile(skill.path)).toString("utf-8");
                const content = requestMarkdownLinkTransform(pi.events, {
                    sourcePath: skill.path,
                    content: raw.startsWith("\uFEFF") ? raw.slice(1) : raw,
                    cwd,
                    sourceKind,
                });
                loadedNames.push(skill.name);
                loadedContents.push(`## Skill: ${skill.name}\n\n${content}`);
            } catch (err) {
                pi.sendMessage(
                    {
                        customType: "skill-load-error",
                        content: `Failed to load skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}`,
                        display: true,
                    },
                    { triggerTurn: false },
                );
            }
        }
        if (loadedNames.length > 0) {
            pi.sendMessage(
                {
                    customType: "skill-loaded",
                    content: loadedContents.join("\n\n---\n\n"),
                    details: { skillNames: loadedNames },
                    display: true,
                },
                { triggerTurn: false },
            );
        }
        return loadedNames;
    };

    // ---- search_skill ----
    const searchSkillTool = defineTool({
        name: "search_skill",
        label: "Search Skills",
        description:
            "Search available skills by name or description. Returns matching skill names, descriptions, and source locations.",
        promptSnippet: "Search available skills by name or description.",
        promptGuidelines: [
            "search_skill: pass a query string to find skills matching the name or description.",
            "Use this to discover what skills are available before loading one with load_skill.",
        ],
        parameters: Type.Object({
            query: Type.String({
                description:
                    "Search query — matches against skill name and description",
            }),
        }),
        async execute(
            _toolCallId: string,
            params: { query: string },
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
        ): Promise<AgentToolResult<undefined>> {
            refreshSkillList();
            const results = searchSkills(skillList, params.query);

            if (results.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No skills found matching your query. Try a different search term.",
                        },
                    ],
                    details: undefined,
                };
            }

            const lines = [
                `Found ${results.length} skill(s) matching "${params.query}":`,
                "",
            ];
            for (const s of results) {
                lines.push(`  • ${s.name} (${s.source})`);
                if (s.description) lines.push(`    ${s.description}`);
            }
            lines.push(
                "",
                `Use load_skill("${results[0].name}") to load a skill's full instructions.`,
            );

            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: undefined,
            };
        },
    });

    // ---- find_skill ----
    const findSkillTool = defineTool({
        name: "find_skill",
        label: "Find Skill",
        description:
            "Look up a specific skill by exact name. Returns full metadata including the file path.",
        promptSnippet: "Look up a specific skill by exact name.",
        promptGuidelines: [
            "find_skill: pass the exact skill name (case-insensitive) to get its metadata.",
            "Returns the skill's description and file path if found.",
        ],
        parameters: Type.Object({
            name: Type.String({
                description: "Exact skill name to look up (case-insensitive)",
            }),
        }),
        async execute(
            _toolCallId: string,
            params: { name: string },
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
        ): Promise<AgentToolResult<undefined>> {
            refreshSkillList();
            const skill = findSkill(skillList, params.name);

            if (!skill) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Skill "${params.name}" not found. Use search_skill to discover available skills.`,
                        },
                    ],
                    details: undefined,
                };
            }

            const lines = [
                `Skill: ${skill.name}`,
                `Source: ${skill.source}`,
                `Path: ${skill.path}`,
                `Description: ${skill.description || "(none)"}`,
            ];

            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: undefined,
            };
        },
    });

    // ---- load_skill ----
    const loadSkillTool = defineTool({
        name: "load_skill",
        label: "Load Skill",
        description:
            "Load a skill's full instructions (SKILL.md content). Use this when you need the complete skill documentation to follow its procedures.",
        promptSnippet: "Load a skill's full SKILL.md content into context.",
        promptGuidelines: [
            "load_skill: pass the exact skill name to load its full SKILL.md instructions.",
            "Use search_skill first if you don't know the exact skill name.",
            "Once loaded, follow the skill's procedures exactly as documented.",
        ],
        parameters: Type.Object({
            name: Type.String({
                description: "Exact skill name to load (case-insensitive)",
            }),
        }),
        async execute(
            _toolCallId: string,
            params: { name: string },
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
            context: ExtensionContext,
        ): Promise<AgentToolResult<undefined>> {
            refreshSkillList();
            const skill = findSkill(skillList, params.name);

            if (!skill) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Skill "${params.name}" not found. Use search_skill to discover available skills.`,
                        },
                    ],
                    details: undefined,
                };
            }

            let content: string;
            try {
                const buf = await readFile(skill.path);
                const raw = buf.toString("utf-8");
                content = requestMarkdownLinkTransform(pi.events, {
                    sourcePath: skill.path,
                    content: raw.startsWith("\uFEFF") ? raw.slice(1) : raw,
                    cwd: context.cwd,
                    sourceKind: "load-skill-tool",
                });
            } catch (err) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Failed to read skill file at ${skill.path}: ${err instanceof Error ? err.message : String(err)}`,
                        },
                    ],
                    details: undefined,
                };
            }

            return {
                content: [{ type: "text", text: content }],
                details: undefined,
            };
        },
    });

    // ---- input event: dollar tokens and rescued slash command fallback ----
    pi.on("input", async (event, ctx) => {
        refreshSkillList();

        const referencedSkills = findDollarSkills(event.text, skillList);
        if (referencedSkills.length > 1) {
            const loadedNames = await sendLoadedSkills(
                referencedSkills,
                ctx.cwd,
                "dollar-skill-input",
            );
            if (loadedNames.length === 0) return { action: "continue" };
            let text = event.text;
            for (const name of loadedNames) {
                text = rewriteDollarTokenToSkillRef(text, name);
            }
            return { action: "transform", text };
        }

        const dollarTransformed = transformDollarSkillInput(
            event.text,
            skillList,
        );
        if (dollarTransformed) {
            return { action: "transform", text: dollarTransformed };
        }

        const slashMatch = event.text.match(
            /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/,
        );
        if (slashMatch) {
            const coreOwnsSkill = pi
                .getCommands()
                .some(
                    (command) =>
                        command.source === "skill" &&
                        command.name.replace(/^skill:/, "").toLowerCase() ===
                            slashMatch[1].toLowerCase(),
                );
            if (!coreOwnsSkill) {
                const skill = rescuedSkills.find(
                    (candidate) =>
                        candidate.name.toLowerCase() ===
                        slashMatch[1].toLowerCase(),
                );
                if (skill) {
                    return {
                        action: "transform",
                        text: formatRescuedSkillBlock(
                            skill,
                            slashMatch[2] ?? "",
                        ),
                    };
                }
            }
        }

        return { action: "continue" };
    });

    // ---- before_agent_start: BOM-normalized fallback skills catalog ----
    pi.on("before_agent_start", (event) => {
        const coreSkillNames = new Set(
            pi
                .getCommands()
                .filter((command) => command.source === "skill")
                .map((command) =>
                    command.name.replace(/^skill:/, "").toLowerCase(),
                ),
        );
        const fallbacks = rescuedSkills.filter(
            (skill) => !coreSkillNames.has(skill.name.toLowerCase()),
        );
        if (fallbacks.length === 0) return undefined;

        const catalog = fallbacks
            .map(
                (skill) =>
                    `- \`${skill.name}\`: ${skill.description}\n  Load full instructions with \`load_skill\`.`,
            )
            .join("\n");
        return {
            systemPrompt: `${event.systemPrompt}\n\n## BOM-normalized fallback skills\n${catalog}`,
        };
    });

    // ---- /validate-skills command ----
    pi.registerCommand("validate-skills", {
        description:
            "Report BOM and frontmatter problems in discoverable skills",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            const trusted =
                typeof ctx.isProjectTrusted === "function" &&
                ctx.isProjectTrusted();
            const roots = await getSkillRoots(ctx.cwd, trusted);
            const discovery = await discoverSkillFallbacks(roots);
            const content =
                discovery.diagnostics.length === 0
                    ? "All discoverable skills passed BOM/frontmatter validation."
                    : discovery.diagnostics
                          .map(
                              (diagnostic) =>
                                  `${diagnostic.path}: ${diagnostic.message}`,
                          )
                          .join("\n");
            pi.sendMessage(
                {
                    customType: "skill-validation",
                    content,
                    display: true,
                },
                { triggerTurn: false },
            );
        },
    });

    // ---- register on session_start ----
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
        const trusted =
            typeof ctx.isProjectTrusted === "function" &&
            ctx.isProjectTrusted();
        const roots = await getSkillRoots(ctx.cwd, trusted);
        const discovery = await discoverSkillFallbacks(roots);
        rescuedSkills = discovery.skills;
        if (ctx.hasUI && discovery.diagnostics.length > 0) {
            ctx.ui.notify(
                `Normalized ${discovery.diagnostics.length} invalid skill file(s). Run /validate-skills for paths.`,
                "warning",
            );
        }
        refreshSkillList();

        if (ctx.hasUI) {
            ctx.ui.addAutocompleteProvider((current) => ({
                triggerCharacters: [...(current.triggerCharacters ?? []), "$"],
                async getSuggestions(lines, cursorLine, cursorCol, options) {
                    const prefix = extractDollarPrefix(
                        lines,
                        cursorLine,
                        cursorCol,
                    );
                    if (!prefix) {
                        return current.getSuggestions(
                            lines,
                            cursorLine,
                            cursorCol,
                            options,
                        );
                    }
                    const query = prefix.slice(1).toLowerCase();
                    const items = skillList
                        .filter((skill) =>
                            skill.name.toLowerCase().includes(query),
                        )
                        .slice(0, 20)
                        .map((skill) => ({
                            value: `$${skill.name}`,
                            label: `$${skill.name}`,
                            description: skill.description,
                        }));
                    if (items.length === 0) {
                        return current.getSuggestions(
                            lines,
                            cursorLine,
                            cursorCol,
                            options,
                        );
                    }
                    return { items, prefix };
                },
                applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                    return current.applyCompletion(
                        lines,
                        cursorLine,
                        cursorCol,
                        item,
                        prefix,
                    );
                },
                shouldTriggerFileCompletion:
                    current.shouldTriggerFileCompletion?.bind(current),
            }));
        }

        pi.registerTool(searchSkillTool);
        pi.registerTool(findSkillTool);
        pi.registerTool(loadSkillTool);

        pi.registerMessageRenderer<{ skillNames?: string[] }>(
            "skill-loaded",
            (message, options, theme) => {
                const box = new Box(1, 1, (t) =>
                    theme.bg("customMessageBg", t),
                );
                const details = message.details;
                const names = details?.skillNames?.join(", ") ?? "";
                const label = theme.fg(
                    "customMessageLabel",
                    "\x1b[1m[skill-loaded]\x1b[22m ",
                );
                const title = theme.fg(
                    "customMessageText",
                    `Loaded skill: ${names}`,
                );

                if (!options.expanded) {
                    const hint = theme.fg(
                        "dim",
                        ` (${keyText("app.tools.expand")} to expand)`,
                    );
                    box.addChild(new Text(label + title + hint, 0, 0));
                    return box;
                }

                box.addChild(new Text(label + title, 0, 0));
                box.addChild(new Spacer(1));
                const text =
                    typeof message.content === "string"
                        ? message.content
                        : Array.isArray(message.content)
                          ? (
                                message.content as Array<{
                                    type?: string;
                                    text?: string;
                                }>
                            )
                                .filter((c) => c.type === "text")
                                .map((c) => c.text)
                                .join("\n")
                          : "";
                box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
                return box;
            },
        );

        pi.registerCommand("load-skills", {
            description: "Load one or more skills by name",
            getArgumentCompletions: (
                prefix: string,
            ): { value: string; label: string; description?: string }[] => {
                refreshSkillList();

                const parts = prefix.split(/\s+/);
                const activePart = parts[parts.length - 1] ?? "";
                const priorParts = parts.slice(0, -1).filter(Boolean);
                const alreadyMatched = new Set(
                    priorParts.map((p) => p.toLowerCase()),
                );

                const lowerActive = activePart.toLowerCase();
                const prefixBase =
                    priorParts.length > 0 ? `${priorParts.join(" ")} ` : "";

                return skillList
                    .filter((s) => !alreadyMatched.has(s.name.toLowerCase()))
                    .filter((s) => s.name.toLowerCase().includes(lowerActive))
                    .map((s) => ({
                        value: `${prefixBase}${s.name}`,
                        label: s.name,
                        description: `${s.source} — ${s.description.substring(0, 60)}`,
                    }))
                    .slice(0, 30);
            },
            handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
                const names = args.trim().split(/\s+/).filter(Boolean);
                if (names.length === 0) {
                    return;
                }

                refreshSkillList();

                const skills = names
                    .map((name) => findSkill(skillList, name))
                    .filter((skill): skill is SkillEntry => skill !== null);
                await sendLoadedSkills(
                    skills,
                    cmdCtx.cwd,
                    "load-skills-command",
                );
            },
        });

        const current = pi.getActiveTools();
        const added = ["search_skill", "find_skill", "load_skill"].filter(
            (t) => !current.includes(t),
        );
        if (added.length > 0) {
            pi.setActiveTools([...new Set([...current, ...added])]);
        }
    });
}
