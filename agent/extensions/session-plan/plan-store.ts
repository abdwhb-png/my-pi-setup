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
    sessionId?: string;
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
    return join(cwd, PLAN_ROOT, slugify(topic));
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

type PlanRecord = {
    planDir: string;
    manifestPath: string;
    manifest: PlanManifest;
};

function listPlanRecords(cwd: string, topic: string): PlanRecord[] {
    const plansRoot = join(cwd, PLAN_ROOT);
    if (!existsSync(plansRoot)) return [];

    const stablePlanDir = resolvePlanDir(cwd, topic);
    const records: PlanRecord[] = [];
    for (const entry of readdirSync(plansRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === MIGRATED_MARKER) continue;
        const planDir = join(plansRoot, entry.name);
        const manifestPath = join(planDir, "manifest.json");
        const manifest = readManifestSafe(manifestPath);
        if (manifest?.topic !== topic) continue;
        records.push({ planDir, manifestPath, manifest });
    }

    return records.toSorted((left, right) => {
        const stableOrder =
            Number(right.planDir === stablePlanDir) -
            Number(left.planDir === stablePlanDir);
        if (stableOrder !== 0) return stableOrder;
        const updatedOrder = right.manifest.updatedAt.localeCompare(
            left.manifest.updatedAt,
        );
        return updatedOrder || left.planDir.localeCompare(right.planDir);
    });
}

function findPlanRecord(cwd: string, topic: string): PlanRecord | undefined {
    return listPlanRecords(cwd, topic)[0];
}

// ── Core operations ──────────────────────────────────────────────────────────

export function savePlan(
    cwd: string,
    topic: string,
    content: string,
    sessionId?: string,
): { path: string; manifestPath: string; version: number; bytes: number } {
    const existingRecord = findPlanRecord(cwd, topic);
    const planDir = existingRecord?.planDir ?? resolvePlanDir(cwd, topic);
    const manifestPath =
        existingRecord?.manifestPath ?? join(planDir, "manifest.json");

    mkdirSync(planDir, { recursive: true });

    const now = new Date().toISOString();
    const normalizedContent = `${content.trimEnd()}\n`;
    const existingManifest = existingRecord?.manifest;
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
                ...(sessionId ? { sessionId } : {}),
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
    const record = findPlanRecord(cwd, topic);
    if (!record || record.manifest.versions.length === 0) return undefined;
    const { manifest } = record;

    const targetEntry =
        version != null
            ? manifest.versions.find((v) => v.version === version)
            : manifest.versions[manifest.versions.length - 1];

    if (!targetEntry) return undefined;

    const versionPath = join(
        record.planDir,
        versionFileName(targetEntry.version),
    );

    if (!existsSync(versionPath)) return undefined;

    return {
        content: readFileSync(versionPath, "utf8"),
        version: targetEntry.version,
    };
}

export function clearPlan(cwd: string, topic: string): boolean {
    const records = listPlanRecords(cwd, topic);
    for (const record of records) {
        rmSync(record.planDir, { recursive: true, force: true });
    }
    return records.length > 0;
}

export function listVersions(
    cwd: string,
    topic: string,
): PlanVersionEntry[] | undefined {
    return findPlanRecord(cwd, topic)?.manifest.versions;
}
