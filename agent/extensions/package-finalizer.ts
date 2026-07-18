import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadPackageLifecycleTrustConfig } from './_shared/package-install/config.ts';
import {
    getDefaultAgentDir,
    repairConfiguredPiPackages,
    type RepairLogger,
    type RepairSummary,
} from './_shared/package-install/finalizer.ts';
import { repairConfiguredPackageTrust } from './_shared/package-install/lifecycle-trust.ts';
import { pinToolGroupsPackageLast } from './_shared/tool-groups/package-order.ts';

function createStartupLogger(showStatus: boolean): RepairLogger {
    return {
        info(message: string) {
            if (message.includes('Built ') || message.includes('Linked ')) {
                console.log(message);
                return;
            }
            if (showStatus && message.includes('[package-lifecycle-trust]')) {
                console.log(message);
            }
        },
        warn(message: string) {
            console.warn(message);
        },
    };
}

export async function runPackageFinalizerStartup(
    cwd: string,
    agentDir = getDefaultAgentDir(),
): Promise<RepairSummary> {
    // Pin tool-groups package to last position before repairing packages.
    const pinResult = await pinToolGroupsPackageLast(cwd, agentDir);

    const result = await repairConfiguredPiPackages({
        cwd,
        agentDir,
        logger: createStartupLogger(false),
        force: false,
    });

    if (pinResult.changed) {
        const msg = `[package-finalizer] Tool-groups package order repaired. Run /reload to apply updated tool-group configuration.`;
        console.warn(msg);
        result.warnings.push(msg);
    }

    return result;
}

export async function runPackageLifecycleTrustStartup(
    cwd: string,
    agentDir = getDefaultAgentDir(),
): Promise<void> {
    const config = loadPackageLifecycleTrustConfig(cwd, agentDir);
    await repairConfiguredPackageTrust({
        cwd,
        agentDir,
        confirm: config.confirm,
        logger: createStartupLogger(config.showStatus),
    });
}

export default async function packageFinalizer(
    _pi: ExtensionAPI,
): Promise<void> {
    const cwd = process.cwd();
    await runPackageFinalizerStartup(cwd);
    await runPackageLifecycleTrustStartup(cwd);
}
