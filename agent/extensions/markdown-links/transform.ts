import { existsSync, realpathSync } from "node:fs";
import {
    dirname,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from "node:path";
import type { MdastNode } from "satteri";

export interface MarkdownParser {
    markdownToMdast(source: string): MdastNode;
    mdxToMdast(source: string): MdastNode;
}

export type MarkdownLinkDiagnosticReason =
    | "missing"
    | "outside-allowed-roots"
    | "source-correlation"
    | "dynamic-destination"
    | "parser-error"
    | "partial-source-context";

export interface MarkdownLinkDiagnostic {
    sourcePath: string;
    destination?: string;
    line?: number;
    column?: number;
    reason: MarkdownLinkDiagnosticReason;
    message: string;
}

export interface TransformMarkdownLinksOptions {
    sourcePath: string;
    cwd: string;
    allowedRoots: string[];
    allowedSourceSlices?: ReadonlyMap<string, number>;
}

export interface TransformMarkdownLinksResult {
    content: string;
    rewritten: number;
    diagnostics: MarkdownLinkDiagnostic[];
}

interface PositionedNode {
    type: string;
    url?: string;
    identifier?: string;
    position?: {
        start: { offset?: number; line?: number; column?: number };
        end: { offset?: number; line?: number; column?: number };
    };
    children?: PositionedNode[];
}

interface DestinationSpan {
    start: number;
    end: number;
    angle: boolean;
}

interface Edit {
    start: number;
    end: number;
    replacement: string;
}

interface CanonicalCandidate {
    path: string;
    exists: boolean;
}

function normalizeIdentifier(identifier: string): string {
    return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

function walk(
    node: PositionedNode,
    visit: (node: PositionedNode) => void,
): void {
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
}

function skipWhitespace(source: string, start: number): number {
    let index = start;
    while (/\s/.test(source[index] ?? "")) index++;
    return index;
}

function findLabelEnd(source: string): number | null {
    if (source[0] !== "[") return null;
    let depth = 0;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === "[") depth++;
        if (char === "]") {
            depth--;
            if (depth === 0) return index;
        }
    }
    return null;
}

function parseDestination(
    source: string,
    start: number,
): DestinationSpan | null {
    const destinationStart = skipWhitespace(source, start);
    if (destinationStart >= source.length) return null;

    if (source[destinationStart] === "<") {
        let escaped = false;
        for (let index = destinationStart + 1; index < source.length; index++) {
            const char = source[index];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === ">") {
                return {
                    start: destinationStart + 1,
                    end: index,
                    angle: true,
                };
            }
        }
        return null;
    }

    let escaped = false;
    let nestedParentheses = 0;
    for (let index = destinationStart; index < source.length; index++) {
        const char = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === "(") {
            nestedParentheses++;
            continue;
        }
        if (char === ")") {
            if (nestedParentheses === 0) {
                return {
                    start: destinationStart,
                    end: index,
                    angle: false,
                };
            }
            nestedParentheses--;
            continue;
        }
        if (/\s/.test(char) && nestedParentheses === 0) {
            return {
                start: destinationStart,
                end: index,
                angle: false,
            };
        }
    }

    return destinationStart < source.length
        ? { start: destinationStart, end: source.length, angle: false }
        : null;
}

function locateDestination(
    nodeSource: string,
    type: string,
): DestinationSpan | null {
    const labelEnd = findLabelEnd(nodeSource);
    if (labelEnd === null) return null;

    const index = skipWhitespace(nodeSource, labelEnd + 1);
    if (type === "link") {
        if (nodeSource[index] !== "(") return null;
        return parseDestination(nodeSource, index + 1);
    }
    if (type === "definition") {
        if (nodeSource[index] !== ":") return null;
        return parseDestination(nodeSource, index + 1);
    }
    return null;
}

function splitDestination(destination: string): {
    path: string;
    suffix: string;
} | null {
    const trimmed = destination.trim();
    if (
        !trimmed ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("//") ||
        /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ) {
        return null;
    }

    const suffixIndex = trimmed.search(/[?#]/);
    const rawPath =
        suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);
    if (!rawPath) return null;

    let decodedPath: string;
    try {
        decodedPath = decodeURI(rawPath);
    } catch {
        decodedPath = rawPath;
    }

    return {
        path: decodedPath,
        suffix: suffixIndex === -1 ? "" : trimmed.slice(suffixIndex),
    };
}

function canonicalizeExistingOrParent(candidate: string): CanonicalCandidate {
    const absolute = resolve(candidate);
    if (existsSync(absolute)) {
        return { path: realpathSync(absolute), exists: true };
    }

    const missingParts: string[] = [];
    let current = absolute;
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current) return { path: absolute, exists: false };
        missingParts.unshift(
            current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
        );
        current = parent;
    }

    return {
        path: resolve(realpathSync(current), ...missingParts),
        exists: false,
    };
}

function isWithinRoot(candidate: string, root: string): boolean {
    const pathRelative = relative(root, candidate);
    return (
        pathRelative === "" ||
        (!pathRelative.startsWith("..") && !isAbsolute(pathRelative))
    );
}

function formatResolvedDestination(
    destination: string,
    angle: boolean,
): string {
    const mustUseAngles =
        /[\s<>]/.test(destination) || !balancedParentheses(destination);
    const escaped = destination
        .replace(/\\/g, "\\\\")
        .replace(/</g, "\\<")
        .replace(/>/g, "\\>");
    if (angle) return escaped;
    return mustUseAngles ? `<${escaped}>` : escaped;
}

function balancedParentheses(value: string): boolean {
    let depth = 0;
    for (const char of value) {
        if (char === "(") depth++;
        if (char === ")") {
            depth--;
            if (depth < 0) return false;
        }
    }
    return depth === 0;
}

function sanitizeCommentValue(value: string): string {
    return value.replace(/--/g, "- -").replace(/>/g, "&gt;");
}

function codePointOffsetMap(source: string): number[] {
    const offsets = [0];
    let stringIndex = 0;
    for (const character of source) {
        stringIndex += character.length;
        offsets.push(stringIndex);
    }
    return offsets;
}

function diagnosticFor(
    node: PositionedNode,
    sourcePath: string,
    destination: string | undefined,
    reason: MarkdownLinkDiagnosticReason,
    message: string,
): MarkdownLinkDiagnostic {
    return {
        sourcePath,
        ...(destination === undefined ? {} : { destination }),
        ...(node.position?.start.line === undefined
            ? {}
            : { line: node.position.start.line }),
        ...(node.position?.start.column === undefined
            ? {}
            : { column: node.position.start.column }),
        reason,
        message,
    };
}

export function collectMarkdownLinkSourceSlices(
    source: string,
    sourcePath: string,
    parser: MarkdownParser,
): ReadonlyMap<string, number> {
    let tree: MdastNode;
    try {
        tree =
            extname(sourcePath).toLowerCase() === ".mdx"
                ? parser.mdxToMdast(source)
                : parser.markdownToMdast(source);
    } catch {
        return new Map();
    }

    const root = tree as PositionedNode;
    const sourceOffsets = codePointOffsetMap(source);
    const referencedDefinitions = new Set<string>();
    walk(root, (node) => {
        if (node.type === "linkReference" && node.identifier) {
            referencedDefinitions.add(normalizeIdentifier(node.identifier));
        }
    });

    const slices = new Map<string, number>();
    walk(root, (node) => {
        if (node.type !== "link" && node.type !== "definition") return;
        if (
            node.type === "definition" &&
            (!node.identifier ||
                !referencedDefinitions.has(
                    normalizeIdentifier(node.identifier),
                ))
        ) {
            return;
        }

        const startCodePointOffset = node.position?.start.offset;
        const endCodePointOffset = node.position?.end.offset;
        if (
            startCodePointOffset === undefined ||
            endCodePointOffset === undefined
        ) {
            return;
        }
        const startOffset = sourceOffsets[startCodePointOffset];
        const endOffset = sourceOffsets[endCodePointOffset];
        if (startOffset === undefined || endOffset === undefined) return;

        const slice = source.slice(startOffset, endOffset);
        if (slice.includes("$")) return;
        slices.set(slice, (slices.get(slice) ?? 0) + 1);
    });

    return slices;
}

export function transformMarkdownLinks(
    source: string,
    options: TransformMarkdownLinksOptions,
    parser: MarkdownParser,
): TransformMarkdownLinksResult {
    let tree: MdastNode;
    try {
        tree =
            extname(options.sourcePath).toLowerCase() === ".mdx"
                ? parser.mdxToMdast(source)
                : parser.markdownToMdast(source);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: source,
            rewritten: 0,
            diagnostics: [
                {
                    sourcePath: options.sourcePath,
                    reason: "parser-error",
                    message,
                },
            ],
        };
    }

    const root = tree as PositionedNode;
    const sourceOffsets = codePointOffsetMap(source);
    const referencedDefinitions = new Set<string>();
    walk(root, (node) => {
        if (node.type === "linkReference" && node.identifier) {
            referencedDefinitions.add(normalizeIdentifier(node.identifier));
        }
    });

    const allowedSourceSlices = options.allowedSourceSlices
        ? new Map(options.allowedSourceSlices)
        : undefined;
    const roots = [...options.allowedRoots, dirname(options.sourcePath)].map(
        (rootPath) => canonicalizeExistingOrParent(rootPath).path,
    );
    const edits: Edit[] = [];
    const diagnostics: MarkdownLinkDiagnostic[] = [];
    let rewritten = 0;

    walk(root, (node) => {
        if (node.type !== "link" && node.type !== "definition") return;
        if (
            node.type === "definition" &&
            (!node.identifier ||
                !referencedDefinitions.has(
                    normalizeIdentifier(node.identifier),
                ))
        ) {
            return;
        }
        if (!node.url) return;

        const startCodePointOffset = node.position?.start.offset;
        const endCodePointOffset = node.position?.end.offset;
        const startOffset =
            startCodePointOffset === undefined
                ? undefined
                : sourceOffsets[startCodePointOffset];
        const endOffset =
            endCodePointOffset === undefined
                ? undefined
                : sourceOffsets[endCodePointOffset];
        if (
            startOffset === undefined ||
            endOffset === undefined ||
            startOffset < 0 ||
            endOffset < startOffset ||
            endOffset > source.length
        ) {
            diagnostics.push(
                diagnosticFor(
                    node,
                    options.sourcePath,
                    node.url,
                    "source-correlation",
                    "MDAST node has no usable source range",
                ),
            );
            return;
        }

        const nodeSource = source.slice(startOffset, endOffset);
        if (allowedSourceSlices) {
            const remaining = allowedSourceSlices.get(nodeSource) ?? 0;
            if (remaining === 0) return;
            allowedSourceSlices.set(nodeSource, remaining - 1);
        }

        const span = locateDestination(nodeSource, node.type);
        if (!span) {
            diagnostics.push(
                diagnosticFor(
                    node,
                    options.sourcePath,
                    node.url,
                    "source-correlation",
                    "Could not locate Markdown destination inside MDAST node",
                ),
            );
            return;
        }

        const destination = splitDestination(node.url);
        if (!destination) return;

        const lexicalTarget = isAbsolute(destination.path)
            ? resolve(destination.path)
            : resolve(dirname(options.sourcePath), destination.path);
        const candidate = canonicalizeExistingOrParent(lexicalTarget);
        const allowed = roots.some((rootPath) =>
            isWithinRoot(candidate.path, rootPath),
        );

        if (!allowed || !candidate.exists) {
            const reason = allowed ? "missing" : "outside-allowed-roots";
            const reasonText = allowed ? "missing" : "outside allowedRoots";
            const annotation = `<!-- markdown-links: ${reasonText} ${sanitizeCommentValue(candidate.path)} -->`;
            edits.push({
                start: endOffset,
                end: endOffset,
                replacement:
                    node.type === "definition" ? `\n${annotation}` : annotation,
            });
            diagnostics.push(
                diagnosticFor(
                    node,
                    options.sourcePath,
                    node.url,
                    reason,
                    `${reasonText}: ${candidate.path}`,
                ),
            );
            return;
        }

        const resolvedDestination = `${candidate.path}${destination.suffix}`;
        const replacement = formatResolvedDestination(
            resolvedDestination,
            span.angle,
        );
        const rawDestination = nodeSource.slice(span.start, span.end);
        if (replacement === rawDestination) return;

        edits.push({
            start: startOffset + span.start,
            end: startOffset + span.end,
            replacement,
        });
        rewritten++;
    });

    edits.sort(
        (left, right) => right.start - left.start || right.end - left.end,
    );
    let content = source;
    for (const edit of edits) {
        content = `${content.slice(0, edit.start)}${edit.replacement}${content.slice(edit.end)}`;
    }

    return { content, rewritten, diagnostics };
}
