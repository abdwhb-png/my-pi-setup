import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
    isMarkdownLinkTransformRequest,
    MARKDOWN_LINKS_TRANSFORM_EVENT,
} from "../_shared/markdown-links.ts";
import {
    extractDollarPrefix,
    extractDollarSkillName,
    loadSkillContent,
    spliceSkillBlock,
    transformDollarSkillInput,
} from "./dollar-skill.ts";
import type { SkillEntry } from "./skill-index.ts";

describe("extractDollarSkillName", () => {
    it("extracts a lone token", () => {
        expect(extractDollarSkillName("$tdd")).toBe("tdd");
    });

    it("extracts a token with trailing args", () => {
        expect(extractDollarSkillName("$tdd fix login")).toBe("tdd");
    });

    it("extracts an embedded token", () => {
        expect(extractDollarSkillName("please use $tdd here")).toBe("tdd");
    });

    it("ignores text without a dollar token", () => {
        expect(extractDollarSkillName("no skill here")).toBeNull();
    });

    it("ignores shell and currency forms", () => {
        expect(extractDollarSkillName("cost $5")).toBeNull();
        expect(extractDollarSkillName("run $?")).toBeNull();
    });

    it("stops the name before trailing punctuation", () => {
        expect(extractDollarSkillName("use $tdd.")).toBe("tdd");
        expect(extractDollarSkillName("use $tdd, then deploy")).toBe("tdd");
    });
});

describe("extractDollarPrefix", () => {
    it("returns the dollar prefix under the cursor", () => {
        expect(extractDollarPrefix(["use $td"], 0, 7)).toBe("$td");
    });

    it("requires the dollar to start the token", () => {
        expect(extractDollarPrefix(["cost$5"], 0, 6)).toBeNull();
    });

    it("returns null without a dollar token", () => {
        expect(extractDollarPrefix(["plain text"], 0, 10)).toBeNull();
    });
});

describe("spliceSkillBlock", () => {
    it("replaces a lone token with the block", () => {
        expect(spliceSkillBlock("$tdd", "tdd", "<block/>")).toBe("<block/>");
    });

    it("preserves text around an embedded token", () => {
        expect(spliceSkillBlock("use $tdd now", "tdd", "<block/>")).toBe(
            "use <block/> now",
        );
    });

    it("leaves unknown names untouched", () => {
        expect(spliceSkillBlock("use $nope now", "tdd", "<block/>")).toBe(
            "use $nope now",
        );
    });
});

describe("loadSkillContent", () => {
    it("returns error result on read failure", async () => {
        const events = createEventBus();
        const skill: SkillEntry = {
            name: "missing",
            description: "Missing",
            path: "/nonexistent/SKILL.md",
            source: "user",
        };
        const result = await loadSkillContent(events, skill, "/workspace", "test");
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain("Failed to read skill file");
        }
    });
});

describe("transformDollarSkillInput", () => {
    it("rewrites a sole dollar token for a core skill to slash form", async () => {
        const events = createEventBus();
        const skillList: SkillEntry[] = [
            {
                name: "tdd",
                description: "TDD skill",
                path: "/skills/tdd/SKILL.md",
                source: "user",
            },
        ];
        const result = await transformDollarSkillInput(
            "$tdd fix login",
            skillList,
            events,
            "/workspace",
        );
        expect(result).toBe("/skill:tdd fix login");
    });

    it("splices an embedded dollar token and transforms markdown links", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-dollar-test-"));
        try {
            const skillDir = join(root, "tdd");
            await mkdir(skillDir, { recursive: true });
            const skillPath = join(skillDir, "SKILL.md");
            await writeFile(
                skillPath,
                "---\nname: tdd\ndescription: TDD skill\n---\n\n# TDD\n\nRead [guide](guide.md).\n",
            );
            const events = createEventBus();
            events.on(MARKDOWN_LINKS_TRANSFORM_EVENT, (value) => {
                if (!isMarkdownLinkTransformRequest(value)) return;
                expect(value.sourcePath).toBe(skillPath);
                expect(value.sourceKind).toBe("dollar-skill-input");
                value.result = value.content.replace("guide.md", join(skillDir, "guide.md"));
            });

            const skillList: SkillEntry[] = [
                {
                    name: "tdd",
                    description: "TDD skill",
                    path: skillPath,
                    source: "user",
                },
            ];

            const result = await transformDollarSkillInput(
                "please use $tdd right now",
                skillList,
                events,
                root,
            );

            expect(result).toBe(
                `please use <skill name="tdd" location="${skillPath}">\nReferences are relative to ${skillDir}.\n\n# TDD\n\nRead [guide](${join(skillDir, "guide.md")}).\n</skill> right now`,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("expands a sole dollar token for a rescued skill directly with args", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-dollar-test-"));
        try {
            const skillDir = join(root, "bom-skill");
            await mkdir(skillDir, { recursive: true });
            const skillPath = join(skillDir, "SKILL.md");
            await writeFile(
                skillPath,
                "\uFEFF---\nname: bom-skill\ndescription: Rescued BOM skill\n---\n\n# Rescued\n",
            );
            const events = createEventBus();
            const skillList: SkillEntry[] = [
                {
                    name: "bom-skill",
                    description: "Rescued BOM skill",
                    path: skillPath,
                    source: "rescued",
                },
            ];

            const result = await transformDollarSkillInput(
                "$bom-skill run now",
                skillList,
                events,
                root,
            );

            expect(result).toBe(
                `<skill name="bom-skill" location="${skillPath}">\nReferences are relative to ${skillDir}.\n\n# Rescued\n</skill>\n\nrun now`,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("returns undefined for unknown dollar token", async () => {
        const events = createEventBus();
        const skillList: SkillEntry[] = [];
        const result = await transformDollarSkillInput(
            "cost $unknown here",
            skillList,
            events,
            "/workspace",
        );
        expect(result).toBeUndefined();
    });
});
