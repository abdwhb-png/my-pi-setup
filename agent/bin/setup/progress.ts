import { clearInterval, setInterval } from 'node:timers';

const STAGES = {
    prerequisites: 'Checking host prerequisites',
    main: 'Refreshing approved main revision',
    runtimes: 'Verifying pinned runtimes',
    profile: 'Capturing the portable profile',
    archive: 'Preparing the setup archive',
    repository: 'Checking distribution repository access',
    release: 'Verifying the immutable release',
    download: 'Downloading distribution assets',
    attestations: 'Verifying asset attestations',
    extract: 'Extracting and verifying the archive',
    files: 'Checking installation integrity',
    tools: 'Discovering local development tools',
    prepare: 'Preparing the candidate installation',
    activate: 'Activating the candidate installation',
    provision: 'Provisioning the installation',
    core: 'Installing and verifying the Pi runtime',
    dependencies: 'Restoring extension dependencies',
    packages: 'Installing Pi packages',
    zerobox: 'Installing and verifying Zerobox',
    sandbox: 'Configuring sandbox tool bindings',
    verify: 'Verifying installed packages and runtimes',
    cleanup: 'Cleaning unused runtimes',
    recover: 'Restoring the previous installation',
    publish: 'Requesting private release qualification',
    memory: 'Transferring global memory',
} as const;

export interface SetupProgressEvent {
    stage: keyof typeof STAGES;
    state: 'start' | 'done' | 'failed';
    current?: number;
    total?: number;
}
export type SetupProgress = (event: SetupProgressEvent) => void;
const PREFIX = 'PI_SETUP_PROGRESS ';

export async function setupStep<T>(
    progress: SetupProgress | undefined,
    stage: SetupProgressEvent['stage'],
    work: () => T | Promise<T>,
    counts: Pick<SetupProgressEvent, 'current' | 'total'> = {},
): Promise<T> {
    progress?.({ stage, state: 'start', ...counts });
    try {
        const value = await work();
        progress?.({ stage, state: 'done', ...counts });
        return value;
    } catch (error) {
        progress?.({ stage, state: 'failed', ...counts });
        throw error;
    }
}

/** Child processes emit only semantic events; dependency streams stay captured. */
export function childSetupProgress(): SetupProgress | undefined {
    if (process.env.PI_SETUP_PROGRESS !== '1') return undefined;
    return (event) =>
        process.stderr.write(`${PREFIX}${JSON.stringify(event)}\n`);
}

function isProgressEvent(value: unknown): value is SetupProgressEvent {
    if (
        !value ||
        typeof value !== 'object' ||
        !('stage' in value) ||
        typeof value.stage !== 'string' ||
        !Object.hasOwn(STAGES, value.stage) ||
        !('state' in value) ||
        (value.state !== 'start' &&
            value.state !== 'done' &&
            value.state !== 'failed')
    )
        return false;
    for (const count of [
        'current' in value ? value.current : undefined,
        'total' in value ? value.total : undefined,
    ])
        if (
            count !== undefined &&
            (typeof count !== 'number' ||
                !Number.isSafeInteger(count) ||
                count < 0 ||
                count > 1_000_000)
        )
            return false;
    return true;
}

export function readSetupProgress(line: string, progress: SetupProgress): void {
    if (!line.startsWith(PREFIX) || line.length > 512) return;
    let value: unknown;
    try {
        value = JSON.parse(line.slice(PREFIX.length));
    } catch {
        /* Other child diagnostics are handled by the command error owner. */
        return;
    }
    if (!isProgressEvent(value)) return;
    progress({
        stage: value.stage,
        state: value.state,
        current: value.current,
        total: value.total,
    });
}

export class SetupProgressReporter {
    private readonly active: Array<{
        event: SetupProgressEvent;
        started: number;
    }> = [];
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(
        private readonly write: (text: string) => void = (text) =>
            process.stderr.write(text),
    ) {
        this.timer = setInterval(() => {
            const current = this.active.at(-1);
            if (current)
                this.write(
                    `[pi-setup] ${STAGES[current.event.stage]}: still running (${this.elapsed(current.started)})\n`,
                );
        }, 10_000);
        this.timer.unref();
    }

    private elapsed(started: number): string {
        return `${((performance.now() - started) / 1000).toFixed(1)}s`;
    }

    readonly report: SetupProgress = (event) => {
        const counts =
            event.current !== undefined && event.total !== undefined
                ? ` (${event.current}/${event.total})`
                : '';
        const label = STAGES[event.stage] + counts;
        if (event.state === 'start') {
            this.active.push({ event, started: performance.now() });
            this.write(`[pi-setup] ${label}…\n`);
            return;
        }
        const index = this.active.findLastIndex(
            ({ event: active }) => active.stage === event.stage,
        );
        const current =
            index >= 0 ? this.active.splice(index, 1)[0] : undefined;
        this.write(
            `[pi-setup] ${label}: ${event.state === 'done' ? 'done' : 'failed'}${current ? ` (${this.elapsed(current.started)})` : ''}\n`,
        );
    };

    close(): void {
        clearInterval(this.timer);
    }
}
