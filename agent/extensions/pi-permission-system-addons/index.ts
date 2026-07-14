import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadConfig, type AddonConfig } from './config.ts';
import { checkAndBlock, InMemorySessionCache } from './handler.ts';

export default function (pi: ExtensionAPI) {
    const sessionCache = new InMemorySessionCache();
    let config: AddonConfig = { inherit: {} };
    /** Yolo mode is on when --yolo flag is passed or config.yolo is true. */
    let yolo = false;

    pi.registerFlag('yolo', {
        description:
            'Auto-approve all inherited permission checks (ask → allow)',
        type: 'boolean',
    });

    function reloadConfig(cwd: string) {
        try {
            config = loadConfig(cwd);
        } catch (err) {
            config = { inherit: {} };
            console.error(
                '[pi-permission-system-addons] Config error:',
                (err as Error).message,
            );
        }
    }

    pi.on('session_start', (_event, ctx) => {
        reloadConfig(ctx.cwd);
        sessionCache.clear();
        yolo = process.argv.includes('--yolo') || config.yolo === true;
    });

    pi.on('session_shutdown', () => {
        sessionCache.clear();
    });

    pi.on('tool_call', async (event, ctx) => {
        if (!config.inherit[event.toolName]) return;

        const result = await checkAndBlock(
            event.toolName,
            event.input as Record<string, unknown>,
            config,
            ctx,
            pi.events as any,
            sessionCache,
            yolo,
        );

        if (result?.block) {
            return { block: true, reason: result.reason };
        }
    });
}
