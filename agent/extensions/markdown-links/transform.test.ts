import { afterEach, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarkdownParser } from "./transform.ts";
import {
    collectMarkdownLinkSourceSlices,
    transformMarkdownLinks,
} from "./transform.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "markdown-links-transform-"));
    tempDirs.push(dir);
    return dir;
}

async function loadParser(): Promise<MarkdownParser> {
    const { markdownToMdast, mdxToMdast } = await import("satteri");
    return { markdownToMdast, mdxToMdast };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("transformMarkdownLinks", () => {
    it("resolves the browser-debug prompt link from its Markdown source", async () => {
        const root = makeTempDir();
        const promptDir = join(root, ".pi", "prompts");
        const targetDir = join(root, ".agents", "prompts");
        mkdirSync(promptDir, { recursive: true });
        mkdirSync(targetDir, { recursive: true });

        const sourcePath = join(promptDir, "browser-debug.md");
        const targetPath = join(targetDir, "browser-debug.md");
        const targetBody = "SECRET_TARGET_BODY";
        writeFileSync(targetPath, targetBody);

        const source =
            "Read [browser-debug](../../.agents/prompts/browser-debug.md) for guidelines.";
        const result = transformMarkdownLinks(
            source,
            {
                sourcePath,
                cwd: root,
                allowedRoots: [root],
            },
            await loadParser(),
        );

        expect(result.content).toBe(
            `Read [browser-debug](${targetPath}) for guidelines.`,
        );
        expect(result.content).not.toContain(targetBody);
        expect(result.rewritten).toBe(1);
        expect(result.diagnostics).toEqual([]);
    });

    it("preserves angle destinations, titles, balanced parentheses, and escapes", async () => {
        const root = makeTempDir();
        const docs = join(root, "docs");
        mkdirSync(docs);
        writeFileSync(join(docs, "guide (draft).md"), "guide");
        writeFileSync(join(docs, "a(b).txt"), "text");
        writeFileSync(join(docs, "space name.md"), "space");
        const sourcePath = join(root, "README.md");
        const source = [
            '[guide](<docs/guide (draft).md> "Guide")',
            "[balanced](docs/a(b).txt)",
            "[escaped](docs/a\\(b\\).txt)",
        ].join("\n");

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: root, allowedRoots: [root] },
            await loadParser(),
        );

        expect(result.content).toBe(
            [
                `[guide](<${join(docs, "guide (draft).md")}> "Guide")`,
                `[balanced](${join(docs, "a(b).txt")})`,
                `[escaped](${join(docs, "a(b).txt")})`,
            ].join("\n"),
        );
        expect(result.rewritten).toBe(3);
    });

    it("rewrites referenced definitions but ignores image-only definitions", async () => {
        const root = makeTempDir();
        const docs = join(root, "docs");
        mkdirSync(docs);
        writeFileSync(join(docs, "guide.md"), "guide");
        writeFileSync(join(docs, "cover.png"), "cover");
        const sourcePath = join(root, "README.md");
        const source = [
            "[Guide][guide]",
            "![Cover][cover]",
            "",
            '[guide]: docs/guide.md "Guide title"',
            "[cover]: docs/cover.png",
        ].join("\n");

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: root, allowedRoots: [root] },
            await loadParser(),
        );

        expect(result.content).toContain(
            `[guide]: ${join(docs, "guide.md")} "Guide title"`,
        );
        expect(result.content).toContain("[cover]: docs/cover.png");
        expect(result.rewritten).toBe(1);
    });

    it("ignores code, images, external URLs, protocol-relative URLs, and anchors", async () => {
        const root = makeTempDir();
        const sourcePath = join(root, "README.md");
        const source = [
            "`[inline](inline.md)`",
            "```md",
            "[fenced](fenced.md)",
            "```",
            "![image](image.png)",
            "[web](https://example.com/file.md)",
            "[cdn](//example.com/file.md)",
            "[anchor](#section)",
        ].join("\n");

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: root, allowedRoots: [root] },
            await loadParser(),
        );

        expect(result.content).toBe(source);
        expect(result.rewritten).toBe(0);
        expect(result.diagnostics).toEqual([]);
    });

    it("rewrites local files, directories, fragments, and query strings", async () => {
        const root = makeTempDir();
        const docs = join(root, "docs");
        mkdirSync(docs);
        writeFileSync(join(docs, "data.json"), "{}");
        const sourcePath = join(root, "README.md");
        const source = [
            "[file](docs/data.json?raw=1#top)",
            "[directory](docs)",
        ].join("\n");

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: root, allowedRoots: [root] },
            await loadParser(),
        );

        expect(result.content).toBe(
            [
                `[file](${join(docs, "data.json")}?raw=1#top)`,
                `[directory](${docs})`,
            ].join("\n"),
        );
        expect(result.rewritten).toBe(2);
    });

    it("applies multiple edits correctly with Unicode and CRLF before links", async () => {
        const root = makeTempDir();
        writeFileSync(join(root, "one.md"), "one");
        writeFileSync(join(root, "two.md"), "two");
        const sourcePath = join(root, "README.md");
        const source = "Préface 😀 [one](one.md)\r\nPuis [two](two.md)";

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: root, allowedRoots: [root] },
            await loadParser(),
        );

        expect(result.content).toBe(
            `Préface 😀 [one](${join(root, "one.md")})\r\nPuis [two](${join(root, "two.md")})`,
        );
        expect(result.rewritten).toBe(2);
    });

    it("parses MDX without rewriting JSX attributes", async () => {
        const root = makeTempDir();
        writeFileSync(join(root, "guide.md"), "guide");
        const sourcePath = join(root, "document.mdx");
        const source = '<Card href="./component.tsx" />\n\n[guide](guide.md)';

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: root, allowedRoots: [root] },
            await loadParser(),
        );

        expect(result.content).toBe(
            `<Card href="./component.tsx" />\n\n[guide](${join(root, "guide.md")})`,
        );
        expect(result.rewritten).toBe(1);
    });

    it("annotates missing targets without changing their destinations", async () => {
        const root = makeTempDir();
        const sourcePath = join(root, "README.md");
        const missingPath = join(root, "missing.md");
        const source = "Read [missing](missing.md).";

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: root, allowedRoots: [root] },
            await loadParser(),
        );

        expect(result.content).toBe(
            `Read [missing](missing.md)<!-- markdown-links: missing ${missingPath} -->.`,
        );
        expect(result.rewritten).toBe(0);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                sourcePath,
                destination: "missing.md",
                reason: "missing",
                line: 1,
                column: 6,
            }),
        ]);
    });

    it("blocks existing and missing targets that escape through symlinks", async () => {
        const root = makeTempDir();
        const docs = join(root, "docs");
        const outside = makeTempDir();
        mkdirSync(docs);
        writeFileSync(join(outside, "secret.md"), "secret");
        symlinkSync(outside, join(docs, "outside"), "dir");
        const sourcePath = join(docs, "README.md");
        const source = [
            "[secret](outside/secret.md)",
            "[missing](outside/missing.md)",
        ].join("\n");

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: docs, allowedRoots: [docs] },
            await loadParser(),
        );

        expect(result.content).toContain(
            `[secret](outside/secret.md)<!-- markdown-links: outside allowedRoots ${join(outside, "secret.md")} -->`,
        );
        expect(result.content).toContain(
            `[missing](outside/missing.md)<!-- markdown-links: outside allowedRoots ${join(outside, "missing.md")} -->`,
        );
        expect(result.diagnostics.map((item) => item.reason)).toEqual([
            "outside-allowed-roots",
            "outside-allowed-roots",
        ]);
    });

    it("limits prompt rewrites to static links from the source template", async () => {
        const root = makeTempDir();
        writeFileSync(join(root, "guide.md"), "guide");
        writeFileSync(join(root, "argument.md"), "argument");
        const sourcePath = join(root, "prompt.md");
        const parser = await loadParser();
        const slices = collectMarkdownLinkSourceSlices(
            "Args: $ARGUMENTS\nStatic [guide](guide.md)",
            sourcePath,
            parser,
        );

        const result = transformMarkdownLinks(
            "Args: [argument](argument.md)\nStatic [guide](guide.md)",
            {
                sourcePath,
                cwd: root,
                allowedRoots: [root],
                allowedSourceSlices: slices,
            },
            parser,
        );

        expect(result.content).toBe(
            `Args: [argument](argument.md)\nStatic [guide](${join(root, "guide.md")})`,
        );
        expect(result.rewritten).toBe(1);
    });

    it("fails unchanged when a parser node has no source position", () => {
        const sourcePath = "/workspace/README.md";
        const source = "[guide](guide.md)";
        const parser: MarkdownParser = {
            markdownToMdast: () =>
                ({
                    type: "root",
                    children: [
                        {
                            type: "paragraph",
                            children: [
                                {
                                    type: "link",
                                    url: "guide.md",
                                    children: [{ type: "text", value: "guide" }],
                                },
                            ],
                        },
                    ],
                }) as never,
            mdxToMdast: () => ({ type: "root", children: [] }) as never,
        };

        const result = transformMarkdownLinks(
            source,
            { sourcePath, cwd: "/workspace", allowedRoots: ["/workspace"] },
            parser,
        );

        expect(result.content).toBe(source);
        expect(result.rewritten).toBe(0);
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ reason: "source-correlation" }),
        ]);
    });
});
