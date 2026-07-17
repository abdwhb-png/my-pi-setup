/**
 * Addons for the pi-roles package/extension.
 */

import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    loadPlannotatorConfig,
    resolvePlanFileDir,
} from '@plannotator/pi-extension/config.js';
import planAutoSwitch from './plan-auto-switch.ts';
import { writePlan, editPlan } from './plan-tools.ts';
import promptRoleSwitch from './prompt-role-switch.ts';
import roleSubagents from './role-subagents.ts';

export default function aldoborreroExtensions(pi: ExtensionAPI) {
    planAutoSwitch(pi);
    promptRoleSwitch(pi);
    roleSubagents(pi);

    // ── write_plan — guarded file write inside plan directory ──

    // oxlint-disable-next-line typescript/no-explicit-any -- TypeBox schema cast required by pi tool registration
    const writePlanSchema: any = Type.Object({
        path: Type.String({
            description:
                "Path to the plan file, relative to the plan directory (e.g., 'my-plan.md' " +
                "or 'features/auth.md'). The plan directory is auto-created if needed.",
        }),
        content: Type.String({
            description: 'Markdown content to write to the file.',
        }),
    });

    pi.registerTool({
        name: 'write_plan',
        label: 'Write Plan',
        description:
            'Write content to a markdown plan file. The path is automatically ' +
            'resolved inside the configured plan directory (planFileDir from ' +
            'plannotator.json). Use this instead of `write` when creating or ' +
            'overwriting plan files.',
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- TypeBox any cast propagated from schema variable
        parameters: writePlanSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi tool params are unknown by API contract
            const p = params as { path?: string; content?: string };
            const cfg = loadPlannotatorConfig(ctx.cwd);
            const planDir = resolvePlanFileDir(cfg.config);
            const result = writePlan(
                p.path ?? '',
                ctx.cwd,
                planDir,
                p.content ?? '',
            );
            return {
                content: [
                    { type: 'text', text: result.error ?? result.message },
                ],
                details: result,
                isError: !!result.error,
            };
        },
    });

    // ── edit_plan — guarded file edit inside plan directory ──

    // oxlint-disable-next-line typescript/no-explicit-any -- TypeBox schema cast required by pi tool registration
    const editPlanSchema: any = Type.Object({
        path: Type.String({
            description:
                "Path to the plan file, relative to the plan directory (e.g., 'my-plan.md').",
        }),
        edits: Type.Array(
            Type.Object({
                oldText: Type.String({
                    description:
                        'Exact text to replace — must be unique in the file.',
                }),
                newText: Type.String({ description: 'Replacement text.' }),
            }),
        ),
    });

    pi.registerTool({
        name: 'edit_plan',
        label: 'Edit Plan',
        description:
            'Edit a markdown plan file using exact text replacement. The path is ' +
            'automatically resolved inside the configured plan directory. Use this ' +
            'instead of `edit` when modifying plan files.',
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- TypeBox any cast propagated from schema variable
        parameters: editPlanSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi tool params are unknown by API contract
            const p = params as {
                path?: string;
                edits?: Array<{ oldText: string; newText: string }>;
            };
            const cfg = loadPlannotatorConfig(ctx.cwd);
            const planDir = resolvePlanFileDir(cfg.config);
            const result = editPlan(
                p.path ?? '',
                ctx.cwd,
                planDir,
                p.edits ?? [],
            );
            return {
                content: [
                    { type: 'text', text: result.error ?? result.message },
                ],
                details: result,
                isError: !!result.error,
            };
        },
    });
}
