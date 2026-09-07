import { describe, expect, it } from "bun:test";
import {
    extractDollarPrefix,
    extractDollarSkillName,
    rewriteDollarTokenToSkillRef,
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

    it("recognizes punctuation boundaries without treating escaped or shell tokens as skills", () => {
        expect(extractDollarSkillName("($bun), next")).toBe("bun");
        expect(extractDollarSkillName("$$bun")).toBeNull();
        expect(extractDollarSkillName("\\$bun")).toBeNull();
        expect(extractDollarSkillName("prefix$bun")).toBeNull();
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

    it("completes after punctuation while ignoring escaped or shell dollars", () => {
        expect(extractDollarPrefix(["($bu"], 0, 4)).toBe("$bu");
        expect(extractDollarPrefix(["$$bu"], 0, 4)).toBeNull();
        expect(extractDollarPrefix(["\\$bu"], 0, 4)).toBeNull();
    });
});

describe("rewriteDollarTokenToSkillRef", () => {
    it("rewrites a lone token to skill:name", () => {
        expect(rewriteDollarTokenToSkillRef("$tdd", "tdd")).toBe("skill:tdd");
    });

    it("rewrites an embedded token to skill:name", () => {
        expect(
            rewriteDollarTokenToSkillRef("please use $tdd before pushing", "tdd"),
        ).toBe("please use skill:tdd before pushing");
    });

    it("rewrites a trailing token to skill:name", () => {
        expect(
            rewriteDollarTokenToSkillRef("this is a test $bun", "bun"),
        ).toBe("this is a test skill:bun");
    });

    it("preserves trailing punctuation on token", () => {
        expect(
            rewriteDollarTokenToSkillRef("use $tdd, then deploy", "tdd"),
        ).toBe("use skill:tdd, then deploy");
    });

    it("rewrites every matching reference without rewriting escapes, longer names, or mid-word uses", () => {
        expect(rewriteDollarTokenToSkillRef(
            "($bun),$BUN and $bun-test prefix$bun \\$bun $$bun",
            "bun",
        )).toBe("(skill:bun),skill:bun and $bun-test prefix$bun \\$bun $$bun");
    });
});

describe("transformDollarSkillInput", () => {
    const skillList: SkillEntry[] = [
        {
            name: "tdd",
            description: "TDD skill",
            path: "/skills/tdd/SKILL.md",
            source: "user",
        },
        {
            name: "bun",
            description: "Bun skill",
            path: "/skills/bun/SKILL.md",
            source: "user",
        },
        {
            name: "bom-skill",
            description: "Rescued skill",
            path: "/skills/bom-skill/SKILL.md",
            baseDir: "/skills/bom-skill",
            content: "---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n",
            source: "rescued",
        },
    ];

    it("rewrites a lone dollar token for a core skill to slash command without trailing duplicate", () => {
        expect(transformDollarSkillInput("$tdd", skillList)).toBe("/skill:tdd");
    });

    it("rewrites a leading dollar token with trailing text maintaining skill:name trace", () => {
        expect(transformDollarSkillInput("$tdd fix login", skillList)).toBe(
            "/skill:tdd skill:tdd fix login",
        );
    });

    it("rewrites an embedded dollar token prepending slash command and keeping skill:name in prompt", () => {
        expect(
            transformDollarSkillInput("please use $tdd before pushing", skillList),
        ).toBe("/skill:tdd please use skill:tdd before pushing");
    });

    it("rewrites a trailing dollar token prepending slash command and keeping skill:name in prompt", () => {
        expect(
            transformDollarSkillInput(
                "this is just a test to see if it works $bun",
                skillList,
            ),
        ).toBe("/skill:bun this is just a test to see if it works skill:bun");
    });

    it("rewrites a dollar token followed by punctuation cleanly", () => {
        expect(
            transformDollarSkillInput("use $tdd, then deploy", skillList),
        ).toBe("/skill:tdd use skill:tdd, then deploy");
    });

    it("formats a rescued skill with block at byte 0 and maintains trace in user prompt", () => {
        const result = transformDollarSkillInput("$bom-skill run now", skillList);
        expect(result).toBe(
            `<skill name="bom-skill" location="/skills/bom-skill/SKILL.md">\nReferences are relative to /skills/bom-skill.\n\n# Instructions\n</skill>\n\nskill:bom-skill run now`,
        );
    });

    it("formats a lone rescued skill without extra user prompt", () => {
        const result = transformDollarSkillInput("$bom-skill", skillList);
        expect(result).toBe(
            `<skill name="bom-skill" location="/skills/bom-skill/SKILL.md">\nReferences are relative to /skills/bom-skill.\n\n# Instructions\n</skill>`,
        );
    });

    it("returns undefined for unknown dollar token so text remains untouched", () => {
        expect(
            transformDollarSkillInput("cost $unknown here", skillList),
        ).toBeUndefined();
    });

    it("does not re-expand dollar examples inside an already expanded rescued skill", () => {
        const result = transformDollarSkillInput("$bom-skill", [
            ...skillList,
        ].map(skill => skill.name === "bom-skill" ? { ...skill, content: "Use $bun in a prompt" } : skill));
        expect(result).toContain("Use $bun in a prompt");
        expect(transformDollarSkillInput(result!, skillList)).toBeUndefined();
    });
});
