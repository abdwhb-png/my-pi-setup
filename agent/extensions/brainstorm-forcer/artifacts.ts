import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createScopedWriter } from "../_shared/scoped-write.ts";

export const BRAINSTORM_PHASES = [
    "discovery",
    "understanding",
    "exploring",
    "presenting",
    "documenting",
] as const;
export type BrainstormPhase = (typeof BRAINSTORM_PHASES)[number];

type RevisionStatus = "active" | "stale";

type ArtifactRevision = {
    phase: BrainstormPhase;
    revision: number;
    status: RevisionStatus;
    path: string;
    sha256: string;
    createdAt: string;
};

export type BrainstormArtifactManifest = {
    version: 1;
    runId: string;
    topic: string;
    root: string;
    updatedAt: string;
    activeRevisions: Partial<Record<BrainstormPhase, number>>;
    revisions: ArtifactRevision[];
};

type StoreOptions = {
    projectRoot: string;
    runId: string;
    topic: string;
    date?: string;
    now?: () => string;
};

type SubmitInput = {
    phase: BrainstormPhase;
    markdown: string;
    tool: string;
};

const PHASE_FILE_NAMES: Record<BrainstormPhase, string> = {
    discovery: "01-discovery",
    understanding: "02-understanding",
    exploring: "03-exploring",
    presenting: "04-presenting",
    documenting: "05-design",
};

function slugify(value: string): string {
    const slug = value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64)
        .replace(/-$/g, "");
    return slug || "brainstorm";
}

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

function normalizeMarkdown(markdown: string): string {
    return `${markdown.trimEnd()}\n`;
}

function expectWriteSuccess(
    result: ReturnType<ReturnType<typeof createScopedWriter>["create"]>,
): string {
    if (result.kind !== "success") throw new Error(result.reason);
    return result.path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArtifactRevision(value: unknown): value is ArtifactRevision {
    if (!isRecord(value)) return false;
    return (
        typeof value.phase === "string" &&
        BRAINSTORM_PHASES.some((phase) => phase === value.phase) &&
        typeof value.revision === "number" &&
        (value.status === "active" || value.status === "stale") &&
        typeof value.path === "string" &&
        typeof value.sha256 === "string" &&
        typeof value.createdAt === "string"
    );
}

function isManifest(value: unknown): value is BrainstormArtifactManifest {
    if (!isRecord(value) || !isRecord(value.activeRevisions)) return false;
    return (
        value.version === 1 &&
        typeof value.runId === "string" &&
        typeof value.topic === "string" &&
        typeof value.root === "string" &&
        typeof value.updatedAt === "string" &&
        Object.values(value.activeRevisions).every(
            (revision) => typeof revision === "number",
        ) &&
        Array.isArray(value.revisions) &&
        value.revisions.every(isArtifactRevision)
    );
}

function readManifest(path: string): BrainstormArtifactManifest {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!isManifest(parsed)) throw new Error("Manifest shape is invalid.");
        return parsed;
    } catch (error) {
        throw new Error(`Invalid artifact manifest: ${path}`, { cause: error });
    }
}

export function createBrainstormArtifactStore(options: StoreOptions) {
    const now = options.now ?? (() => new Date().toISOString());
    const createdAt = now();
    const date = options.date ?? createdAt.slice(0, 10);
    let relativeRoot = `${date}-${slugify(options.topic)}`;
    let manifestPath = `docs/brainstorms/${relativeRoot}/manifest.json`;
    let absoluteManifestPath = join(options.projectRoot, manifestPath);
    if (existsSync(absoluteManifestPath)) {
        const existing = readManifest(absoluteManifestPath);
        if (existing.runId !== options.runId) {
            relativeRoot = `${relativeRoot}-${slugify(options.runId)}`;
            manifestPath = `docs/brainstorms/${relativeRoot}/manifest.json`;
            absoluteManifestPath = join(options.projectRoot, manifestPath);
        }
    }
    const root = `docs/brainstorms/${relativeRoot}`;
    const manifestRelativePath = `${relativeRoot}/manifest.json`;
    const writer = createScopedWriter({
        projectRoot: options.projectRoot,
        actor: {
            agent: "brainstorm-forcer",
            role: "brainstorm",
            runId: options.runId,
        },
        policy: {
            id: "brainstorm-artifacts",
            root: "docs/brainstorms",
            allowedExtensions: [".md", ".json"],
            operations: ["create", "edit"],
            maxBytes: 512_000,
            auditNamespace: "brainstorm",
            allowNestedDirectories: true,
        },
    });

    let manifest: BrainstormArtifactManifest = {
        version: 1,
        runId: options.runId,
        topic: options.topic,
        root,
        updatedAt: createdAt,
        activeRevisions: {},
        revisions: [],
    };

    if (existsSync(absoluteManifestPath)) {
        manifest = readManifest(absoluteManifestPath);
        if (manifest.runId !== options.runId)
            throw new Error(
                `Artifact root already belongs to run ${manifest.runId}.`,
            );
    }

    function persistManifest(tool: string): void {
        const content = `${JSON.stringify(manifest, null, 2)}\n`;
        if (!existsSync(absoluteManifestPath)) {
            expectWriteSuccess(
                writer.create({ path: manifestRelativePath, content, tool }),
            );
            return;
        }
        const previous = readFileSync(absoluteManifestPath, "utf8");
        const result = writer.edit({
            path: manifestRelativePath,
            edits: [{ oldText: previous, newText: content }],
            tool,
        });
        if (result.kind !== "success") throw new Error(result.reason);
    }

    return {
        submit(input: SubmitInput) {
            const revision =
                Math.max(
                    0,
                    ...manifest.revisions
                        .filter((item) => item.phase === input.phase)
                        .map((item) => item.revision),
                ) + 1;
            const content = normalizeMarkdown(input.markdown);
            const fileName = `${PHASE_FILE_NAMES[input.phase]}-r${String(revision).padStart(3, "0")}.md`;
            const scopedPath = `${relativeRoot}/${fileName}`;
            const path = expectWriteSuccess(
                writer.create({ path: scopedPath, content, tool: input.tool }),
            );
            const timestamp = now();
            const phaseIndex = BRAINSTORM_PHASES.indexOf(input.phase);
            const activeRevisions = { ...manifest.activeRevisions };
            for (const phase of BRAINSTORM_PHASES.slice(phaseIndex))
                delete activeRevisions[phase];
            manifest = {
                ...manifest,
                updatedAt: timestamp,
                activeRevisions: {
                    ...activeRevisions,
                    [input.phase]: revision,
                },
                revisions: [
                    ...manifest.revisions.map((item) =>
                        item.status === "active" &&
                        BRAINSTORM_PHASES.indexOf(item.phase) >= phaseIndex
                            ? { ...item, status: "stale" as const }
                            : item,
                    ),
                    {
                        phase: input.phase,
                        revision,
                        status: "active",
                        path,
                        sha256: sha256(content),
                        createdAt: timestamp,
                    },
                ],
            };
            persistManifest(input.tool);
            return { revision, path, manifestPath, sha256: sha256(content) };
        },
        read(path: string): string {
            const revision = manifest.revisions.find(
                (item) => item.path === path,
            );
            if (!revision) throw new Error("Unknown brainstorm artifact.");

            const absoluteRoot = resolve(options.projectRoot, root);
            const absolutePath = resolve(options.projectRoot, path);
            const scopedPath = relative(absoluteRoot, absolutePath);
            if (scopedPath.startsWith("..") || isAbsolute(scopedPath))
                throw new Error(
                    "Artifact path escapes the brainstorm run root.",
                );

            let currentPath = absoluteRoot;
            for (const part of scopedPath.split(sep)) {
                currentPath = join(currentPath, part);
                if (lstatSync(currentPath).isSymbolicLink())
                    throw new Error(
                        "Symlinks are not allowed in artifact paths.",
                    );
            }

            const content = readFileSync(absolutePath, "utf8");
            if (sha256(content) !== revision.sha256)
                throw new Error("Brainstorm artifact checksum mismatch.");
            return content;
        },
        getManifest(): BrainstormArtifactManifest {
            return structuredClone(manifest);
        },
    };
}
