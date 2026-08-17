import { createHash, randomUUID } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import {
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";

export type ScopedWriteOperation = "create" | "edit";

export interface ScopedWritePolicy {
    readonly id: string;
    readonly root: string;
    readonly allowedExtensions: readonly string[];
    readonly operations: readonly ScopedWriteOperation[];
    readonly maxBytes: number;
    readonly auditNamespace: string;
    readonly allowNestedDirectories: boolean;
}

export interface ScopedWriteActor {
    readonly agent: string;
    readonly role: string;
    readonly runId: string;
}

export interface ScopedWriteAuditEvent {
    readonly version: 1;
    readonly timestamp: string;
    readonly runId: string;
    readonly agent: string;
    readonly role: string;
    readonly tool: string;
    readonly policy: string;
    readonly operation: ScopedWriteOperation | "purge";
    readonly path: string;
    readonly bytesBefore: number;
    readonly bytesAfter: number;
    readonly sha256Before: string | null;
    readonly sha256After: string | null;
}

export interface ScopedWriteSuccess {
    readonly kind: "success";
    readonly path: string;
    readonly auditPath: string;
}

export interface ScopedWriteRejected {
    readonly kind: "rejected";
    readonly reason: string;
}

export interface ScopedWritePartialFailure {
    readonly kind: "partial_failure";
    readonly path: string;
    readonly reason: string;
}

export type ScopedWriteResult =
    | ScopedWriteSuccess
    | ScopedWriteRejected
    | ScopedWritePartialFailure;

export interface ScopedCreateInput {
    readonly path: string;
    readonly content: string;
    readonly tool: string;
}

export interface ScopedEditInput {
    readonly path: string;
    readonly edits: readonly { oldText: string; newText: string }[];
    readonly tool: string;
}

export interface ScopedWriterOptions {
    readonly projectRoot: string;
    readonly policy: ScopedWritePolicy;
    readonly actor: ScopedWriteActor;
    readonly appendAudit?: (path: string, event: ScopedWriteAuditEvent) => void;
}

export interface ScopedWriter {
    create(input: ScopedCreateInput): ScopedWriteResult;
    edit(input: ScopedEditInput): ScopedWriteResult;
}

export interface ArtifactRunRoot {
    readonly id: string;
    readonly resolve: (projectRoot: string, runId: string) => readonly string[];
}

export interface ArtifactRootRegistry {
    register(root: ArtifactRunRoot): void;
    resolve(projectRoot: string, runId: string): readonly string[];
}

export interface PurgeArtifactsInput {
    readonly projectRoot: string;
    readonly runId: string;
    readonly actor: ScopedWriteActor;
    readonly tool: string;
    readonly registry: ArtifactRootRegistry;
    readonly confirmed: boolean;
}

export type PurgeArtifactsResult =
    | { readonly kind: "success"; readonly removedPaths: readonly string[] }
    | { readonly kind: "rejected"; readonly reason: string }
    | {
          readonly kind: "partial_failure";
          readonly removedPaths: readonly string[];
          readonly reason: string;
      };

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

function isInside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return (
        rel === "" ||
        (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    );
}

function validatePath(
    projectRoot: string,
    policy: ScopedWritePolicy,
    rawPath: string,
): { absolutePath: string; relativePath: string } | ScopedWriteRejected {
    const path = rawPath.trim();
    if (!path) return { kind: "rejected", reason: "Path must not be empty." };
    if (isAbsolute(path)) {
        return { kind: "rejected", reason: "Absolute paths are not allowed." };
    }
    if (path.split(/[\\/]+/).includes("..")) {
        return { kind: "rejected", reason: "Path traversal is not allowed." };
    }
    if (!policy.allowNestedDirectories && /[\\/]/.test(path)) {
        return {
            kind: "rejected",
            reason: "Nested directories are not allowed.",
        };
    }
    const extension = extname(path).toLowerCase();
    if (!policy.allowedExtensions.includes(extension)) {
        return {
            kind: "rejected",
            reason: `Extension '${extension || "(none)"}' is not allowed.`,
        };
    }
    const root = resolve(projectRoot, policy.root);
    const absolutePath = resolve(root, path);
    if (!isInside(root, absolutePath)) {
        return {
            kind: "rejected",
            reason: "Path must be inside the declared root.",
        };
    }
    return { absolutePath, relativePath: relative(projectRoot, absolutePath) };
}

function hasSymlinkInExistingPath(
    projectRoot: string,
    target: string,
): boolean {
    const rel = relative(projectRoot, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return true;
    }
    let current = projectRoot;
    for (const segment of rel.split(sep)) {
        current = join(current, segment);
        if (!existsSync(current)) continue;
        if (lstatSync(current).isSymbolicLink()) return true;
    }
    return false;
}

function atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = join(
        dirname(path),
        `.${randomUUID()}.${process.pid}.tmp`,
    );
    try {
        writeFileSync(temporaryPath, content, "utf8");
        renameSync(temporaryPath, path);
    } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
}

function countMatches(content: string, needle: string): number {
    if (!needle) return content === "" ? 1 : 0;
    let count = 0;
    let index = 0;
    while ((index = content.indexOf(needle, index)) !== -1) {
        count++;
        index += needle.length;
    }
    return count;
}

function appendAuditEvent(
    projectRoot: string,
    runId: string,
    event: ScopedWriteAuditEvent,
): string {
    const auditPath = join(
        projectRoot,
        ".pi",
        "artifacts",
        ".audit",
        `${runId}.jsonl`,
    );
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(event)}\n`, "utf8");
    return auditPath;
}

function listFiles(path: string): string[] {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
        throw new Error(`Registered purge root contains a symlink: ${path}`);
    }
    if (stat.isFile()) return [path];
    if (!stat.isDirectory()) return [];
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
        listFiles(join(path, entry.name)),
    );
}

export function createArtifactRootRegistry(): ArtifactRootRegistry {
    const roots = new Map<string, ArtifactRunRoot>();
    return {
        register(root) {
            if (!/^[A-Za-z0-9._-]+$/.test(root.id)) {
                throw new Error(
                    "Artifact root id must contain only safe characters.",
                );
            }
            if (roots.has(root.id)) {
                throw new Error(
                    `Artifact root '${root.id}' is already registered.`,
                );
            }
            roots.set(root.id, root);
        },
        resolve(projectRoot, runId) {
            return [...roots.values()].flatMap((root) =>
                root.resolve(projectRoot, runId),
            );
        },
    };
}

export function purgeArtifacts(
    input: PurgeArtifactsInput,
): PurgeArtifactsResult {
    if (!/^[A-Za-z0-9._-]+$/.test(input.runId)) {
        return {
            kind: "rejected",
            reason: "Run id must contain only safe characters.",
        };
    }
    if (!input.confirmed) {
        return {
            kind: "rejected",
            reason: "Purge requires explicit confirmation.",
        };
    }
    const projectRoot = resolve(input.projectRoot);
    const roots = input.registry
        .resolve(projectRoot, input.runId)
        .map((root) => resolve(root));
    if (roots.some((root) => !isInside(projectRoot, root))) {
        return {
            kind: "rejected",
            reason: "Registered purge root is outside the project.",
        };
    }
    const removedPaths: string[] = [];
    try {
        for (const root of roots) {
            if (!existsSync(root)) continue;
            const events = listFiles(root).map((file) => {
                const content = readFileSync(file, "utf8");
                return {
                    version: 1 as const,
                    timestamp: new Date().toISOString(),
                    runId: input.runId,
                    agent: input.actor.agent,
                    role: input.actor.role,
                    tool: input.tool,
                    policy: "purge-v1",
                    operation: "purge" as const,
                    path: relative(projectRoot, file),
                    bytesBefore: Buffer.byteLength(content, "utf8"),
                    bytesAfter: 0,
                    sha256Before: sha256(content),
                    sha256After: null,
                } satisfies ScopedWriteAuditEvent;
            });
            rmSync(root, { recursive: true, force: false });
            for (const event of events) {
                appendAuditEvent(projectRoot, input.runId, event);
                removedPaths.push(event.path);
            }
        }
    } catch (error) {
        return {
            kind: "partial_failure",
            removedPaths,
            reason: `Purge failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    return { kind: "success", removedPaths };
}

export function createScopedWriter(options: ScopedWriterOptions): ScopedWriter {
    const projectRoot = resolve(options.projectRoot);
    const auditPath = join(
        projectRoot,
        ".pi",
        "artifacts",
        ".audit",
        `${options.actor.runId}.jsonl`,
    );
    const appendAudit =
        options.appendAudit ??
        ((path: string, event: ScopedWriteAuditEvent) => {
            mkdirSync(dirname(path), { recursive: true });
            appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
        });

    function mutate(
        input:
            | (ScopedCreateInput & { readonly operation: "create" })
            | (ScopedEditInput & { readonly operation: "edit" }),
    ): ScopedWriteResult {
        const { operation } = input;
        if (!options.policy.operations.includes(operation)) {
            return {
                kind: "rejected",
                reason: `Operation '${operation}' is not allowed by policy.`,
            };
        }
        const resolved = validatePath(projectRoot, options.policy, input.path);
        if ("kind" in resolved) return resolved;
        const policyRoot = resolve(projectRoot, options.policy.root);
        if (hasSymlinkInExistingPath(policyRoot, resolved.absolutePath)) {
            return {
                kind: "rejected",
                reason: "Symlinks are not allowed in scoped paths.",
            };
        }

        const existed = existsSync(resolved.absolutePath);
        let before = "";
        if (existed) {
            if (lstatSync(resolved.absolutePath).isSymbolicLink()) {
                return {
                    kind: "rejected",
                    reason: "Symlink targets are not allowed.",
                };
            }
            before = readFileSync(resolved.absolutePath, "utf8");
        }
        if (operation === "create" && existed) {
            return {
                kind: "rejected",
                reason: "Create target already exists.",
            };
        }

        let after: string;
        if (input.operation === "create") {
            after = input.content;
        } else {
            after = before;
            for (const edit of input.edits) {
                const matches = countMatches(after, edit.oldText);
                if (matches !== 1) {
                    return {
                        kind: "rejected",
                        reason:
                            matches === 0
                                ? "Edit text was not found."
                                : `Edit text matches ${matches} locations.`,
                    };
                }
                after = after.replace(edit.oldText, edit.newText);
            }
        }
        if (Buffer.byteLength(after, "utf8") > options.policy.maxBytes) {
            return {
                kind: "rejected",
                reason: "Content exceeds the policy size limit.",
            };
        }

        try {
            atomicWrite(resolved.absolutePath, after);
        } catch (error) {
            return {
                kind: "rejected",
                reason: `Write failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        const event: ScopedWriteAuditEvent = {
            version: 1,
            timestamp: new Date().toISOString(),
            runId: options.actor.runId,
            agent: options.actor.agent,
            role: options.actor.role,
            tool: input.tool,
            policy: options.policy.id,
            operation,
            path: resolved.relativePath,
            bytesBefore: Buffer.byteLength(before, "utf8"),
            bytesAfter: Buffer.byteLength(after, "utf8"),
            sha256Before: existed ? sha256(before) : null,
            sha256After: sha256(after),
        };
        try {
            appendAudit(auditPath, event);
        } catch (error) {
            return {
                kind: "partial_failure",
                path: resolved.relativePath,
                reason: `Artifact was written but audit failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        return { kind: "success", path: resolved.relativePath, auditPath };
    }

    return {
        create(input) {
            return mutate({ ...input, operation: "create" });
        },
        edit(input) {
            return mutate({ ...input, operation: "edit" });
        },
    };
}
