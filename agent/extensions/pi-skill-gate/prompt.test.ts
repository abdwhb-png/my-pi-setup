import { expect, test } from "bun:test";
import {
    formatSkillsForPrompt,
    type BeforeProviderRequestEvent,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import { rewriteProviderSystemPrompt } from "../_shared/provider-system-prompt.ts";
import { skillCatalogFilter } from "./prompt.ts";

function skill(name: string, manual = false): Skill {
    return {
        name,
        description: `${name} fixture`,
        filePath: `/skills/${name}/SKILL.md`,
        baseDir: `/skills/${name}`,
        sourceInfo: {
            path: `/skills/${name}/SKILL.md`,
            source: "user",
            scope: "user",
            origin: "top-level",
        },
        disableModelInvocation: manual,
    };
}
const skills = [skill("visible"), skill("hidden"), skill("manual", true)];
const config = { skills: { hidden: "disabled" as const }, projects: {} };

test("default visibility needs no provider adaptation", () => {
    expect(
        skillCatalogFilter([skill("new")], { skills: {}, projects: {} }),
    ).toBeUndefined();
});

test("filters repeated catalogs idempotently while preserving text and unrelated skill blocks", () => {
    const filter = skillCatalogFilter(skills, config);
    if (!filter) throw new Error("Missing visibility filter");
    const catalog = formatSkillsForPrompt(skills);
    const instructions = `<skill>Actual loaded instructions</skill>\n${catalog}\nROLE\n${catalog}\nSHELL`;
    const filtered = filter(instructions);
    expect(filtered.match(/<name>visible<\/name>/g)).toHaveLength(2);
    expect(filtered).not.toContain("<name>hidden</name>");
    expect(filtered).toContain("<skill>Actual loaded instructions</skill>");
    expect(filtered).toContain("ROLE");
    expect(filtered).toContain("SHELL");
    expect(filter(filtered)).toBe(filtered);
    expect(filter("Custom prompt without a catalog")).toBe(
        "Custom prompt without a catalog",
    );
});

test("uses Pi's escaped names and removes an empty catalog", () => {
    const escaped = skill("hidden&special");
    const filter = skillCatalogFilter([escaped], {
        skills: { [escaped.name]: "disabled" },
        projects: {},
    });
    if (!filter) throw new Error("Missing visibility filter");
    const catalog = formatSkillsForPrompt([escaped]);
    expect(catalog).toContain("&amp;");
    expect(filter(`BEFORE${catalog}AFTER`)).not.toContain("<available_skills>");
    expect(filter(`BEFORE${catalog}AFTER`)).toContain("BEFORE");
    expect(filter(`BEFORE${catalog}AFTER`)).toContain("AFTER");
});

test("native manual-only flags override an enabled saved choice", () => {
    const manual = skill("manual", true);
    const filter = skillCatalogFilter([manual], {
        skills: { manual: "enabled" },
        projects: {},
    });
    if (!filter) throw new Error("Missing visibility filter");
    // Model-invocation metadata must still win if another extension contributes a catalog.
    expect(
        filter(
            formatSkillsForPrompt([
                { ...manual, disableModelInvocation: false },
            ]),
        ),
    ).not.toContain("<name>manual</name>");
});

test("preserves structured Pi system sections and request metadata", () => {
    const filter = skillCatalogFilter(skills, config);
    if (!filter) throw new Error("Missing visibility filter");
    const catalog = formatSkillsForPrompt(skills);
    const sections = { role: "ROLE", skills: catalog, sandbox: "SHELL" };
    const system = {
        role: "system",
        content: `ROLE${catalog}SHELL`,
        sections,
        timestamp: 123,
    };
    const user = { role: "user", content: catalog, timestamp: 124 };
    const input = {
        context: { messages: [system, user], tools: [{ name: "read" }] },
        options: { cacheRetention: "long" },
    };
    const expectedSystem = {
        ...system,
        content: filter(system.content),
        sections: { ...sections, skills: filter(catalog) },
    };
    expect(
        rewriteProviderSystemPrompt("pi-messages", input, filter, filter),
    ).toEqual({
        ...input,
        context: { ...input.context, messages: [expectedSystem, user] },
    });
    expect(input.context.messages[0]).toBe(system);
    expect(sections.skills).toContain("<name>hidden</name>");
});

const catalog = formatSkillsForPrompt(skills);
const cases: Array<[string, BeforeProviderRequestEvent["payload"]]> = [
    [
        "openai-completions",
        {
            messages: [
                { role: "system", content: catalog },
                { role: "user", content: "user" },
            ],
            tools: [],
        },
    ],
    [
        "openai-responses",
        {
            instructions: catalog,
            input: [{ role: "user", content: "user" }],
            tools: [],
        },
    ],
    [
        "openai-codex-responses",
        {
            input: [
                { role: "developer", content: catalog },
                { role: "user", content: "user" },
            ],
        },
    ],
    [
        "anthropic-messages",
        {
            system: [
                {
                    type: "text",
                    text: catalog,
                    cache_control: { type: "ephemeral" },
                },
                { type: "text", text: "ROLE" },
            ],
            messages: [{ role: "user", content: "user" }],
        },
    ],
    [
        "google-generative-ai",
        {
            config: {
                systemInstruction: {
                    parts: [{ text: catalog }, { text: "ROLE" }],
                },
            },
            contents: [{ role: "user", parts: [{ text: "user" }] }],
        },
    ],
    [
        "bedrock-converse-stream",
        {
            system: [{ text: catalog }, { text: "ROLE" }],
            messages: [{ role: "user", content: [{ text: "user" }] }],
        },
    ],
];
test.each(cases)(
    "filters %s with the shared provider adapter",
    (api, payload) => {
        const filter = skillCatalogFilter(skills, config);
        if (!filter) throw new Error("Missing visibility filter");
        const original = JSON.stringify(payload);
        const output = rewriteProviderSystemPrompt(
            api,
            payload,
            filter,
            filter,
        );
        const text = JSON.stringify(output);
        expect(text).not.toContain("<name>hidden</name>");
        expect(text).toContain("<name>visible</name>");
        expect(text).toContain("user");
        expect(JSON.stringify(payload)).toBe(original);
        expect(
            rewriteProviderSystemPrompt(api, output, filter, filter),
        ).toEqual(output);
        if (api === "anthropic-messages")
            expect(text).toContain('"cache_control":{"type":"ephemeral"}');
    },
);
