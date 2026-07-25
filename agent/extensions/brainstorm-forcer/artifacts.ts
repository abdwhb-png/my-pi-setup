import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createScopedWriter } from "../pi-scoped-write/core";

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

export function createBrainstormArtifactStore(options: StoreOptions) {
    const now = options.now ?? (() => new Date().toISOString());
    const createdAt = now();
    const date = options.date ?? createdAt.slice(0, 10);
    let relativeRoot = `${date}-${slugify(options.topic)}`;
    let manifestPath = `docs/brainstorms/${relativeRoot}/manifest.json`;
    let absoluteManifestPath = join(options.projectRoot, manifestPath);
    if (existsSync(absoluteManifestPath)) {
        const existing = JSON.parse(
            readFileSync(absoluteManifestPath, "utf8"),
        ) as BrainstormArtifactManifest;
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
        manifest = JSON.parse(
            readFileSync(absoluteManifestPath, "utf8"),
        ) as BrainstormArtifactManifest;
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
        getManifest(): BrainstormArtifactManifest {
            return structuredClone(manifest);
        },
    };
}
