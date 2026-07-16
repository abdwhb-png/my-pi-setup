import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringEnum } from '@earendil-works/pi-ai';
import {
    type ExtensionAPI,
    type ExtensionContext,
    withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const SessionPlanParams = Type.Object({
    action: StringEnum(['save', 'read', 'clear'] as const),
    content: Type.Optional(
        Type.String({ description: 'Complete Markdown plan for save' }),
    ),
});

export function getSessionPlanPath(
    sessionDirectory: string,
    sessionId: string,
): string {
    return join(sessionDirectory, 'plans', `${sessionId}.md`);
}

async function savePlan(planPath: string, content: string): Promise<void> {
    await mkdir(dirname(planPath), { recursive: true });
    const temporaryPath = `${planPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, planPath);
}

async function createPlan(planPath: string, content: string): Promise<boolean> {
    await mkdir(dirname(planPath), { recursive: true });
    try {
        await writeFile(planPath, content, { encoding: 'utf8', flag: 'wx' });
        return true;
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
        )
            return false;
        throw error;
    }
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readPlan(planPath: string): Promise<string | undefined> {
    try {
        return await readFile(planPath, 'utf8');
    } catch (error) {
        if (isMissingFileError(error)) return undefined;
        throw error;
    }
}

async function clearPlan(planPath: string): Promise<boolean> {
    try {
        await unlink(planPath);
        return true;
    } catch (error) {
        if (isMissingFileError(error)) return false;
        throw error;
    }
}

function parseSessionId(sessionFileContent: string): string | undefined {
    const headerLine = sessionFileContent.split('\n', 1)[0];
    if (!headerLine) return undefined;
    try {
        const header: unknown = JSON.parse(headerLine);
        if (!header || typeof header !== 'object') return undefined;
        if (!('type' in header) || header.type !== 'session') return undefined;
        return 'id' in header && typeof header.id === 'string'
            ? header.id
            : undefined;
    } catch {
        return undefined;
    }
}

async function inheritForkPlan(ctx: ExtensionContext): Promise<void> {
    const parentSession = ctx.sessionManager.getHeader()?.parentSession;
    if (!parentSession) return;

    const parentSessionContent = await readPlan(parentSession);
    if (parentSessionContent === undefined) return;
    const parentSessionId = parseSessionId(parentSessionContent);
    if (!parentSessionId) return;

    const sessionDirectory = ctx.sessionManager.getSessionDir();
    const parentPlanPath = getSessionPlanPath(
        sessionDirectory,
        parentSessionId,
    );
    const parentPlan = await readPlan(parentPlanPath);
    if (parentPlan === undefined) return;

    const forkPlanPath = getSessionPlanPath(
        sessionDirectory,
        ctx.sessionManager.getSessionId(),
    );
    await withFileMutationQueue(forkPlanPath, () =>
        createPlan(forkPlanPath, parentPlan),
    );
}

export default function sessionPlanExtension(pi: ExtensionAPI): void {
    pi.on('session_start', async (event, ctx) => {
        if (event.reason !== 'fork') return;
        try {
            await inheritForkPlan(ctx);
        } catch (error) {
            if (ctx.hasUI) {
                ctx.ui.notify(
                    `Could not inherit the parent session plan: ${error instanceof Error ? error.message : String(error)}`,
                    'warning',
                );
            }
        }
    });

    pi.registerTool({
        name: 'session_plan',
        label: 'Session Plan',
        description:
            'Save, read, or clear the complete Markdown plan for the active Pi session.',
        promptSnippet:
            'Persist the active planning document for this Pi session',
        promptGuidelines: [
            'Use save with the complete plan whenever the plan changes.',
        ],
        parameters: SessionPlanParams,
        executionMode: 'sequential',
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const planPath = getSessionPlanPath(
                ctx.sessionManager.getSessionDir(),
                ctx.sessionManager.getSessionId(),
            );

            if (params.action === 'read') {
                const content = await readPlan(planPath);
                if (content === undefined) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'No session plan has been saved.',
                            },
                        ],
                        details: {
                            action: 'read',
                            path: planPath,
                            exists: false,
                            bytes: 0,
                        },
                    };
                }
                return {
                    content: [{ type: 'text', text: content }],
                    details: {
                        action: 'read',
                        path: planPath,
                        exists: true,
                        bytes: Buffer.byteLength(content, 'utf8'),
                    },
                };
            }
            if (params.action === 'clear') {
                const existed = await withFileMutationQueue(planPath, () =>
                    clearPlan(planPath),
                );
                return {
                    content: [
                        {
                            type: 'text',
                            text: existed
                                ? 'Cleared the session plan.'
                                : 'No session plan was saved.',
                        },
                    ],
                    details: {
                        action: 'clear',
                        path: planPath,
                        exists: false,
                        bytes: 0,
                    },
                };
            }
            if (!params.content?.trim()) {
                throw new Error(
                    'session_plan save requires non-empty Markdown content.',
                );
            }

            await withFileMutationQueue(planPath, () =>
                savePlan(planPath, params.content!),
            );

            return {
                content: [
                    { type: 'text', text: `Saved session plan to ${planPath}` },
                ],
                details: {
                    action: 'save',
                    path: planPath,
                    exists: true,
                    bytes: Buffer.byteLength(params.content, 'utf8'),
                },
            };
        },
    });
}
