#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { expandHomePath } from '../extensions/_shared/home-path.ts';
import {
    applyLayoutMigration,
    planLayoutMigration,
    recoverLayoutMigration,
} from '../extensions/_shared/scripts/extension-layout-migration.ts';

try {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            'agent-dir': { type: 'string' },
            project: { type: 'string', multiple: true },
            'artifact-source': { type: 'string', multiple: true },
            apply: { type: 'boolean' },
            'pi-stopped': { type: 'boolean' },
            resume: { type: 'string' },
            rollback: { type: 'string' },
            json: { type: 'boolean' },
            help: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log(
            'Usage: bun agent/bin/migrate-extension-layout.ts [--agent-dir DIR] [--project CWD ...] [--artifact-source DIR ...] [--apply --pi-stopped] [--json]\n       bun agent/bin/migrate-extension-layout.ts (--resume JOURNAL | --rollback JOURNAL) --pi-stopped\n\nDefault: read-only preflight. Projects are explicit cwd paths. Custom source directories from project settings require operator selection of each exact root with --artifact-source. Inspect those directories before selecting them. Stop all Pi processes before applying or recovering. Output contains paths and operations, never configuration values. Backups and recovery journals are private files under the agent artifacts directory.',
        );
    } else {
        if (
            Number(Boolean(values.resume)) +
                Number(Boolean(values.rollback)) +
                Number(Boolean(values.apply)) >
            1
        )
            throw new Error(
                'Choose only one of --apply, --resume, or --rollback',
            );
        if (
            (values.apply || values.resume || values.rollback) &&
            !values['pi-stopped']
        )
            throw new Error(
                'Stop Pi, then pass --pi-stopped to apply or recover the migration',
            );
        if (values.resume || values.rollback) {
            const journal = expandHomePath(values.resume ?? values.rollback!);
            recoverLayoutMigration(
                journal,
                values.resume ? 'resume' : 'rollback',
            );
            const report = {
                status: values.resume ? 'complete' : 'rolled-back',
                journal,
            };
            console.log(
                values.json
                    ? JSON.stringify(report)
                    : `status: ${report.status}\njournal: ${JSON.stringify(journal)}`,
            );
        } else {
            const plan = planLayoutMigration({
                agentDir: expandHomePath(values['agent-dir'] ?? getAgentDir()),
                projects: (values.project ?? []).map((value) =>
                    expandHomePath(value),
                ),
                artifactSources: values['artifact-source'],
            });
            const journal = values.apply
                ? applyLayoutMigration(plan)
                : undefined;
            const report = {
                status: values.apply ? 'complete' : 'dry-run',
                changes: plan.changes.map((change) => ({
                    operation:
                        change.after === null
                            ? 'remove'
                            : change.before === null
                              ? 'create'
                              : 'update',
                    path: change.path,
                })),
                ...(journal ? { journal } : {}),
            };
            if (values.json) console.log(JSON.stringify(report, null, 2));
            else {
                console.log(
                    `status: ${report.status}\nchanges[${report.changes.length}]{operation,path}:`,
                );
                for (const change of report.changes)
                    console.log(
                        `  ${change.operation},${JSON.stringify(change.path)}`,
                    );
                if (journal) console.log(`journal: ${JSON.stringify(journal)}`);
            }
        }
    }
} catch (error) {
    console.error(
        `error: ${error instanceof Error ? error.message : 'Migration failed'}`,
    );
    process.exitCode = 1;
}
