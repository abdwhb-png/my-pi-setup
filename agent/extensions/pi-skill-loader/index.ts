import { readFile } from "node:fs/promises";
import {
    defineTool,
    type AgentToolResult,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    buildSkillList,
    findSkill,
    searchSkills,
    type SkillEntry,
} from "./skill-index";

export default function piSkillLoader(pi: ExtensionAPI): void {
    let skillList: SkillEntry[] = [];

    const refreshSkillList = () => {
        skillList = buildSkillList(pi.getCommands());
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
                content = buf.toString("utf-8");
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

    // ---- register on session_start ----
    pi.on("session_start", () => {
        refreshSkillList();

        pi.registerTool(searchSkillTool);
        pi.registerTool(findSkillTool);
        pi.registerTool(loadSkillTool);

        pi.registerCommand("load-skills", {
            description: "Load one or more skills by name",
            getArgumentCompletions: (
                prefix: string,
            ): { value: string; label: string; description?: string }[] => {
                refreshSkillList();

                const parts = prefix.split(/\s+/);
                const activePart = parts[parts.length - 1] ?? "";
                const alreadyMatched = new Set(
                    parts.slice(0, -1).filter(Boolean),
                );

                const lowerActive = activePart.toLowerCase();

                return skillList
                    .filter((s) => !alreadyMatched.has(s.name))
                    .filter((s) => s.name.toLowerCase().includes(lowerActive))
                    .map((s) => ({
                        value: s.name,
                        label: s.name,
                        description: `${s.source} — ${s.description.substring(0, 60)}`,
                    }))
                    .slice(0, 30);
            },
            handler: async (args: string) => {
                const names = args.trim().split(/\s+/).filter(Boolean);
                if (names.length === 0) {
                    return;
                }

                refreshSkillList();

                for (const name of names) {
                    const skill = findSkill(skillList, name);
                    if (!skill) {
                        continue;
                    }

                    try {
                        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential load by design
                        const buf = await readFile(skill.path);
                        const content = buf.toString("utf-8");

                        pi.sendMessage(
                            {
                                customType: "skill-loaded",
                                content: `Loaded skill: ${skill.name}\n\n${content}`,
                                display: true,
                            },
                            { triggerTurn: false },
                        );
                    } catch {}
                }
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
