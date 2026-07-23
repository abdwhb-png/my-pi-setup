/**
 * plan-tools — plan directory-guarded write_plan / edit_plan tools.
 *
 * Pure helpers exported for testing; the extension entry point registers
 * them as Pi tools via `pi.registerTool()`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute, relative, extname } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
    loadPlannotatorConfig,
    resolvePlanFileDir,
} from '@plannotator/pi-extension/config.js';
import { getActiveRole } from '../_shared/pi-roles.ts';
import { createScopedWriter, type ScopedWriteActor } from './core.ts';

// ── Types ──

export interface PlanPathResult {
    resolved: string | null;
    error: string | null;
}

export interface WriteResult {
    message: string;
    error: string | null;
}

export interface EditInput {
    oldText: string;
    newText: string;
}

export interface EditResult {
    message: string;
    error: string | null;
}

export type PlanWriteActor = ScopedWriteActor;

const DEFAULT_PLAN_ACTOR: PlanWriteActor = {
    agent: 'plan-tools',
    role: 'plan',
    runId: 'unattributed',
};

function planWriteActor(ctx: ExtensionContext): PlanWriteActor {
    const role = getActiveRole(ctx.sessionManager.getEntries())?.name ?? 'plan';
    return { agent: role, role, runId: ctx.sessionManager.getSessionId() };
}

function scopedPlanWriter(cwd: string, planDir: string, actor: PlanWriteActor) {
    return createScopedWriter({
        projectRoot: cwd,
        policy: {
            id: 'plan-v1',
            root: planDir,
            allowedExtensions: ['.md', '.mdx'],
            operations: ['create', 'edit'],
            maxBytes: 1_048_576,
            auditNamespace: 'plans',
            allowNestedDirectories: true,
        },
        actor,
    });
}

// ── Path resolution ──

/**
 * Resolve a raw path against the configured plan directory.
 *
 * Rules:
 * - `planDir` empty/undefined → error (no config)
 * - Path must end in .md or .mdx → reject non-plan files
 * - Path contains `..` → reject
 * - Absolute path → must start with resolved plan dir
 * - Relative path → prepend plan dir
 */
export function resolvePlanPath(
    rawPath: string,
    cwd: string,
    planDir: string | undefined,
): PlanPathResult {
    if (!planDir || !planDir.trim()) {
        return {
            resolved: null,
            error: "No plan directory configured. Set 'planFileDir' in plannotator.json.",
        };
    }

    const trimmed = rawPath.trim();
    if (!trimmed) {
        return { resolved: null, error: 'Path must not be empty.' };
    }

    // Reject non-markdown extensions (plan files only)
    const ext = extname(trimmed).toLowerCase();
    if (ext !== '.md' && ext !== '.mdx') {
        return {
            resolved: null,
            error: `Plan files must be markdown (.md or .mdx). Got: ${ext || '(no extension)'}`,
        };
    }

    // Reject .. traversals
    if (trimmed.includes('..')) {
        return {
            resolved: null,
            error: `Path must be inside the plan directory: ${trimmed}`,
        };
    }

    const planDirResolved = resolve(cwd, planDir.trim());
    let resolvedPath: string;

    if (isAbsolute(trimmed)) {
        resolvedPath = trimmed;
    } else {
        resolvedPath = resolve(planDirResolved, trimmed);
    }

    // Verify absolute paths are inside plan dir
    const rel = relative(planDirResolved, resolvedPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        return {
            resolved: null,
            error: `Path must be inside the plan directory (${planDir.trim()}): ${trimmed}`,
        };
    }

    return { resolved: resolvedPath, error: null };
}

// ── writePlan ──

/**
 * Write content to a file inside the plan directory.
 *
 * Auto-creates the plan directory and any parent directories.
 * Returns `{ message, error }` — at most one is set.
 */
export function writePlan(
    rawPath: string,
    cwd: string,
    planDir: string | undefined,
    content: string,
    actor: PlanWriteActor = DEFAULT_PLAN_ACTOR,
): WriteResult {
    const resolved = resolvePlanPath(rawPath, cwd, planDir);
    if (resolved.error) {
        return { message: '', error: resolved.error };
    }

    const writer = scopedPlanWriter(cwd, planDir!, actor);
    const scopedPath = relative(resolve(cwd, planDir!), resolved.resolved!);
    const existing = existsSync(resolved.resolved!)
        ? readFileSync(resolved.resolved!, 'utf-8')
        : undefined;
    const result =
        existing === undefined
            ? writer.create({ path: scopedPath, content, tool: 'write_plan' })
            : writer.edit({
                  path: scopedPath,
                  edits: [{ oldText: existing, newText: content }],
                  tool: 'write_plan',
              });
    if (result.kind !== 'success') {
        return { message: '', error: result.reason };
    }

    return {
        message: `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${rawPath}`,
        error: null,
    };
}

// ── editPlan ──

/**
 * Edit a file inside the plan directory using text replacements.
 *
 * Each edit must have exactly one unique match for `oldText`.
 * Returns `{ message, error }` — at most one is set.
 */
export function editPlan(
    rawPath: string,
    cwd: string,
    planDir: string | undefined,
    edits: EditInput[],
    actor: PlanWriteActor = DEFAULT_PLAN_ACTOR,
): EditResult {
    const resolved = resolvePlanPath(rawPath, cwd, planDir);
    if (resolved.error) {
        return { message: '', error: resolved.error };
    }

    if (!existsSync(resolved.resolved!)) {
        return { message: '', error: `File not found: ${rawPath}` };
    }

    const result = scopedPlanWriter(cwd, planDir!, actor).edit({
        path: relative(resolve(cwd, planDir!), resolved.resolved!),
        edits,
        tool: 'edit_plan',
    });
    if (result.kind !== 'success') {
        if (result.reason === 'Edit text was not found.') {
            return {
                message: '',
                error: `Could not find match for oldText in ${rawPath}.`,
            };
        }
        if (result.reason.startsWith('Edit text matches ')) {
            return {
                message: '',
                error: result.reason.replace('Edit text', 'oldText'),
            };
        }
        return { message: '', error: result.reason };
    }

    return {
        message: `Successfully replaced ${edits.length} block(s) in ${rawPath}`,
        error: null,
    };
}

const writePlanSchema = Type.Object({
    path: Type.String({
        description:
            "Path to the plan file, relative to the configured plan directory (for example 'my-plan.md' or 'features/auth.md').",
    }),
    content: Type.String({
        description: 'Complete Markdown content to write to the plan file.',
    }),
});

const editPlanSchema = Type.Object({
    path: Type.String({
        description:
            "Path to the plan file, relative to the configured plan directory (for example 'my-plan.md').",
    }),
    edits: Type.Array(
        Type.Object({
            oldText: Type.String({
                description: 'Exact text to replace; it must be unique.',
            }),
            newText: Type.String({ description: 'Replacement text.' }),
        }),
    ),
});

export function registerPlanTools(pi: ExtensionAPI): void {
    pi.registerTool({
        name: 'write_plan',
        label: 'Write Plan',
        description:
            'Write a Markdown plan inside the planFileDir configured by Plannotator.',
        parameters: writePlanSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const config = loadPlannotatorConfig(ctx.cwd);
            const result = writePlan(
                params.path,
                ctx.cwd,
                resolvePlanFileDir(config.config),
                params.content,
                planWriteActor(ctx),
            );
            return {
                content: [
                    { type: 'text', text: result.error ?? result.message },
                ],
                details: result,
                isError: result.error !== null,
            };
        },
    });

    pi.registerTool({
        name: 'edit_plan',
        label: 'Edit Plan',
        description:
            'Edit a Markdown plan inside the planFileDir configured by Plannotator using exact replacement.',
        parameters: editPlanSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const config = loadPlannotatorConfig(ctx.cwd);
            const result = editPlan(
                params.path,
                ctx.cwd,
                resolvePlanFileDir(config.config),
                params.edits,
                planWriteActor(ctx),
            );
            return {
                content: [
                    { type: 'text', text: result.error ?? result.message },
                ],
                details: result,
                isError: result.error !== null,
            };
        },
    });
}
