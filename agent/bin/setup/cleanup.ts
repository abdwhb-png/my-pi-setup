import { cleanupPiRuntimeStore } from '../pi-runtime-store.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function cleanupRuntimes(root: string, dryRun = false) {
    const reports = await cleanupPiRuntimeStore(root, dryRun);
    if (existsSync(join(root, 'runtimes/zerobox'))) {
        const { cleanupZeroboxRuntimeStore } = await import('../../extensions/sandbox/runtime/distribution/stage-release.ts');
        reports.push(...await cleanupZeroboxRuntimeStore(root, dryRun));
    }
    return { dryRun, entries: reports.flatMap(report => report.entries),
        reclaimedBytes: reports.reduce((sum, report) => sum + report.reclaimedBytes, 0),
        warnings: reports.flatMap(report => report.warnings) };
}
