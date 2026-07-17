import {
    getAgentDir,
    type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {
    loadConfig,
    readUpstreamYoloMode,
    type AddonConfig,
    writeUpstreamYoloMode,
} from './config.ts';
import { checkAndBlock, InMemorySessionCache } from './handler.ts';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
    const sessionCache = new InMemorySessionCache();
    let config: AddonConfig = { inherit: {} };
    /** Yolo mode follows --yolo or upstream pi-permission-system yoloMode. */
    let yolo = false;

    pi.registerFlag('yolo', {
        description:
            'Auto-approve all inherited permission checks (ask → allow)',
        type: 'boolean',
    });

    pi.registerCommand('yolo', {
        description:
            'Enable or disable permission-system yolo mode. Usage: /yolo [on|off|toggle|status]',
        getArgumentCompletions: (prefix: string) => {
            const normalized = prefix.trim().toLowerCase();
            if (normalized.includes(' ')) return null;
            const options = ['on', 'off', 'toggle', 'status'];
            const matches = options.filter((option) =>
                option.startsWith(normalized),
            );
            return matches.length
                ? matches.map((value) => ({ value, label: value }))
                : null;
        },
        handler: async (args, ctx) => {
            const action = args.trim().toLowerCase() || 'toggle';
            const agentDir = getAgentDir();
            let current: boolean;

            try {
                current = readUpstreamYoloMode(agentDir);
            } catch (error) {
                ctx.ui.notify(errorMessage(error), 'error');
                return;
            }

            if (action === 'status') {
                ctx.ui.notify(`YOLO mode: ${current ? 'ON' : 'OFF'}`, 'info');
                return;
            }

            if (!['on', 'off', 'toggle'].includes(action)) {
                ctx.ui.notify('Usage: /yolo [on|off|toggle|status]', 'warning');
                return;
            }

            const next =
                action === 'on' ? true : action === 'off' ? false : !current;

            try {
                writeUpstreamYoloMode(agentDir, next);
            } catch (error) {
                ctx.ui.notify(errorMessage(error), 'error');
                return;
            }

            yolo = next;
            ctx.ui.notify(
                `YOLO mode: ${next ? 'ON' : 'OFF'}. Reloading...`,
                'info',
            );
            await ctx.reload();
            return;
        },
    });

    function reloadConfig(cwd: string) {
        try {
            config = loadConfig(cwd);
        } catch (err) {
            config = { inherit: {} };
            console.error(
                '[pi-permission-system-addons] Config error:',
                errorMessage(err),
            );
        }
    }

    pi.on('session_start', (_event, ctx) => {
        reloadConfig(ctx.cwd);
        sessionCache.clear();
        try {
            yolo =
                process.argv.includes('--yolo') ||
                readUpstreamYoloMode(getAgentDir());
        } catch (error) {
            yolo = process.argv.includes('--yolo');
            console.error(
                '[pi-permission-system-addons] Config error:',
                errorMessage(error),
            );
        }
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
