export class InMemorySessionCache {
    private approved = new Set<string>();
    private key(p: string, v: string) {
        return `${p}::${v}`;
    }
    has(p: string, v: string) {
        return this.approved.has(this.key(p, v));
    }
    add(p: string, v: string) {
        this.approved.add(this.key(p, v));
    }
    clear() {
        this.approved.clear();
    }
}

const PATH_SURFACES = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);

export function extractValue(
    surface: string,
    input: Record<string, unknown>,
): string | undefined {
    if (surface === 'bash') {
        return typeof input.command === 'string' ? input.command : undefined;
    }
    if (PATH_SURFACES.has(surface)) {
        if (typeof input.path === 'string') return input.path;
        if (typeof input.pattern === 'string') return input.pattern;
        return undefined;
    }
    return undefined;
}

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getPermissionsService } from '@gotgenes/pi-permission-system';
import type { AddonConfig } from './config.ts';

interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}

export async function checkAndBlock(
    toolName: string,
    input: Record<string, unknown>,
    config: AddonConfig,
    ctx: ExtensionContext,
    _events: EventBus,
    sessionCache: InMemorySessionCache,
    yolo?: boolean,
): Promise<{ block?: boolean; reason?: string } | undefined> {
    const targetSurface = config.inherit[toolName];
    if (!targetSurface) return undefined;

    const svc = getPermissionsService();
    if (!svc) return undefined;

    const value = extractValue(targetSurface, input);
    const checkValue = value ?? toolName;

    const result = svc.checkPermission(targetSurface, checkValue);
    if (result.state === 'allow') return undefined;
    if (result.state === 'deny') {
        return {
            block: true,
            reason:
                result.reason ??
                `Blocked by ${targetSurface} rule: "${result.matchedPattern}"`,
        };
    }

    // state === 'ask'
    if (yolo) return undefined;
    const mp = result.matchedPattern;
    if (mp && sessionCache.has(mp, checkValue)) return undefined;
    return handleAsk(
        ctx,
        toolName,
        targetSurface,
        checkValue,
        mp,
        sessionCache,
    );
}

async function handleAsk(
    ctx: ExtensionContext,
    toolName: string,
    surface: string,
    value: string,
    matchedPattern: string | null | undefined,
    sessionCache: InMemorySessionCache,
): Promise<{ block?: boolean; reason?: string } | undefined> {
    if (!ctx.hasUI) {
        return {
            block: true,
            reason: `Permission required for ${toolName}: ${value}`,
        };
    }

    const title = matchedPattern
        ? `Inherited permission check (${surface})`
        : `Permission check (${surface})`;
    const msg = `Allow '${toolName}' to run: ${value}?`;
    const options = ['Yes', 'Yes for this session', 'No', 'No, provide reason'];

    const decision = await ctx.ui.select(`${title}\n${msg}`, options);

    if (decision === 'Yes') return undefined;
    if (decision === 'Yes for this session') {
        if (matchedPattern) sessionCache.add(matchedPattern, value);
        return undefined;
    }
    if (decision === 'No, provide reason') {
        const reason = await ctx.ui.input(
            `${title}\nShare why this request was denied (optional).`,
            'Reason shown back to the agent',
        );
        const denial =
            typeof reason === 'string' && reason.trim().length > 0
                ? reason.trim()
                : 'Denied by user';
        return { block: true, reason: denial };
    }

    return { block: true, reason: 'Denied by user' };
}
