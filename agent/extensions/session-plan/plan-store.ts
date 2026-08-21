import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

export const PLAN_ROOT = ".pi/session-plans";
export const MIGRATED_MARKER = ".migrated";

// ── Types ────────────────────────────────────────────────────────────────────

export type PlanVersionEntry = {
    version: number;
    path: string;
    createdAt: string;
    bytes: number;
};

export type PlanManifest = {
    version: 1;
    topic: string;
    root: string;
    createdAt: string;
    updatedAt: string;
    latestVersion: number;
    versions: PlanVersionEntry[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function slugify(value: string): string {
    const slug = value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64)
        .replace(/-$/, "");
    return slug || "plan";
}

export function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

export function extractFirstHeading(content: string): string | undefined {
    for (const line of content.split("\n")) {
        const match = /^#\s+(.+)$/.exec(line);
        if (match) return match[1].trim();
    }
    return undefined;
}

export function resolvePlanDir(cwd: string, topic: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const slug = slugify(topic);
    return join(cwd, PLAN_ROOT, `${date}-${slug}`);
}

export function resolvePlanDirForDate(
    cwd: string,
    topic: string,
    date: string,
): string {
    const slug = slugify(topic);
    return join(cwd, PLAN_ROOT, `${date}-${slug}`);
}

function readManifestSafe(manifestPath: string): PlanManifest | undefined {
    try {
        // oxlint-disable-next-line no-unsafe-type-assertion
        return JSON.parse(readFileSync(manifestPath, "utf8")) as PlanManifest;
    } catch {
        return undefined;
    }
}

function writeManifest(manifestPath: string, manifest: PlanManifest): void {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
    );
}

function versionFileName(version: number): string {
    return `v${String(version).padStart(3, "0")}.md`;
}

// ── Core operations ──────────────────────────────────────────────────────────

export function savePlan(
    cwd: string,
    topic: string,
    content: string,
    sessionId?: string,
): { path: string; manifestPath: string; version: number; bytes: number } {
    let planDir = resolvePlanDir(cwd, topic);
    let manifestPath = join(planDir, "manifest.json");

    // Collision handling: if dir exists but manifest belongs to a different directory, append sessionId
    if (existsSync(manifestPath) && sessionId) {
        const existing = readManifestSafe(manifestPath);
        if (existing && existing.versions.length > 0) {
            // firstPath is like '.pi/session-plans/2026-08-21-slug/v001.md'
            // Extract the plan directory name (index 2 after '.pi/session-plans/')
            const firstDirName = existing.versions[0].path.split("/")[2];
            const expectedDirName = planDir.split("/").pop()!;
            if (firstDirName !== expectedDirName) {
                const slug = slugify(topic);
                const date = new Date().toISOString().slice(0, 10);
                const disambiguatedSlug = `${slug}-${slugify(sessionId)}`;
                planDir = join(cwd, PLAN_ROOT, `${date}-${disambiguatedSlug}`);
                manifestPath = join(planDir, "manifest.json");
            }
        }
    }

    mkdirSync(planDir, { recursive: true });

    const now = new Date().toISOString();
    const normalizedContent = `${content.trimEnd()}\n`;
    const existingManifest = readManifestSafe(manifestPath);
    const dirName = planDir.split("/").pop()!;
    let manifest: PlanManifest = existingManifest ?? {
        version: 1,
        topic,
        root: join(PLAN_ROOT, dirName),
        createdAt: now,
        updatedAt: now,
        latestVersion: 0,
        versions: [],
    };

    const newVersion = manifest.latestVersion + 1;
    const fileName = versionFileName(newVersion);
    const versionPath = join(planDir, fileName);
    const relativePath = `${manifest.root}/${fileName}`;

    writeFileSync(versionPath, normalizedContent, "utf8");

    manifest = {
        ...manifest,
        updatedAt: now,
        latestVersion: newVersion,
        versions: [
            ...manifest.versions,
            {
                version: newVersion,
                path: relativePath,
                createdAt: now,
                bytes: Buffer.byteLength(normalizedContent, "utf8"),
            },
        ],
    };

    writeManifest(manifestPath, manifest);

    return {
        path: versionPath,
        manifestPath,
        version: newVersion,
        bytes: Buffer.byteLength(normalizedContent, "utf8"),
    };
}

export function readPlan(
    cwd: string,
    topic: string,
    version?: number,
): { content: string; version: number } | undefined {
    const slug = slugify(topic);
    const plansRoot = join(cwd, PLAN_ROOT);

    if (!existsSync(plansRoot)) return undefined;

    // Find the plan directory matching this topic slug
    const dirs = readdirSync(plansRoot);
    const matchingDir = dirs.find((d) => {
        if (d === MIGRATED_MARKER) return false;
        // Match date-slug or date-slug-disambiguation patterns
        const afterDate = d.replace(/^\d{4}-\d{2}-\d{2}-/, "");
        return afterDate === slug || afterDate.startsWith(`${slug}-`);
    });

    if (!matchingDir) return undefined;

    const manifestPath = join(plansRoot, matchingDir, "manifest.json");
    const manifest = readManifestSafe(manifestPath);
    if (!manifest || manifest.versions.length === 0) return undefined;

    const targetEntry =
        version != null
            ? manifest.versions.find((v) => v.version === version)
            : manifest.versions[manifest.versions.length - 1];

    if (!targetEntry) return undefined;

    const versionPath = join(
        plansRoot,
        matchingDir,
        versionFileName(targetEntry.version),
    );

    if (!existsSync(versionPath)) return undefined;

    return {
        content: readFileSync(versionPath, "utf8"),
        version: targetEntry.version,
    };
}

export function clearPlan(cwd: string, topic: string): boolean {
    const slug = slugify(topic);
    const plansRoot = join(cwd, PLAN_ROOT);

    if (!existsSync(plansRoot)) return false;

    const dirs = readdirSync(plansRoot);
    const matchingDir = dirs.find((d) => {
        if (d === MIGRATED_MARKER) return false;
        const afterDate = d.replace(/^\d{4}-\d{2}-\d{2}-/, "");
        return afterDate === slug || afterDate.startsWith(`${slug}-`);
    });

    if (!matchingDir) return false;

    const planDirPath = join(plansRoot, matchingDir);
    rmSync(planDirPath, { recursive: true, force: true });
    return true;
}

export function listVersions(
    cwd: string,
    topic: string,
): PlanVersionEntry[] | undefined {
    const slug = slugify(topic);
    const plansRoot = join(cwd, PLAN_ROOT);

    if (!existsSync(plansRoot)) return undefined;

    const dirs = readdirSync(plansRoot);
    const matchingDir = dirs.find((d) => {
        if (d === MIGRATED_MARKER) return false;
        const afterDate = d.replace(/^\d{4}-\d{2}-\d{2}-/, "");
        return afterDate === slug || afterDate.startsWith(`${slug}-`);
    });

    if (!matchingDir) return undefined;

    const manifestPath = join(plansRoot, matchingDir, "manifest.json");
    const manifest = readManifestSafe(manifestPath);
    return manifest?.versions;
}
