import { expect, spyOn, test } from 'bun:test';
import * as timers from 'node:timers';
import { runAsync } from './files.ts';
import {
    readSetupProgress,
    SetupProgressReporter,
    setupStep,
    type SetupProgressEvent,
} from './progress.ts';

test('progress remains observable during waits and stops its heartbeat after completion', () => {
    const timer = timers.setInterval(() => {}, 2_147_483_647);
    let tick = () => {};
    // The reporter uses the Node callback overload and receives a real Node timer.
    const schedule = spyOn(timers, 'setInterval').mockImplementation(((
        handler: () => void,
    ) => {
        tick = () => {
            if (typeof handler === 'function') handler();
        };
        return timer;
    }) as typeof timers.setInterval);
    const unschedule = spyOn(timers, 'clearInterval');
    let output = '';
    const reporter = new SetupProgressReporter((text) => {
        output += text;
    });
    try {
        const report = reporter.report;
        report({ stage: 'download', state: 'start' });
        expect(schedule).toHaveBeenCalledWith(expect.any(Function), 10_000);
        tick();
        expect(output).toContain('still running');
        report({ stage: 'download', state: 'done' });
        const completed = output;
        tick();
        expect(output).toBe(completed);
        reporter.close();
        expect(unschedule).toHaveBeenCalledWith(timer);
    } finally {
        reporter.close();
        schedule.mockRestore();
        unschedule.mockRestore();
        timers.clearInterval(timer);
    }
});

test('a failed stage never reports successful completion', async () => {
    const events: SetupProgressEvent[] = [];
    await expect(
        setupStep(
            (event) => events.push(event),
            'provision',
            async () => {
                throw new Error('fixture failure');
            },
        ),
    ).rejects.toThrow('fixture failure');
    expect(events.map((event) => event.state)).toEqual(['start', 'failed']);
});

test('progress display failures fail the command instead of being treated as dependency noise', async () => {
    const line = 'PI_SETUP_PROGRESS {"stage":"download","state":"start"}';
    expect(() =>
        readSetupProgress(line, () => {
            throw new Error('fixture display failure');
        }),
    ).toThrow('fixture display failure');
    await expect(
        runAsync(
            process.execPath,
            [
                '-e',
                `console.error(${JSON.stringify(line)}); await Bun.sleep(100);`,
            ],
            undefined,
            process.env,
            () => {
                throw new Error('fixture display failure');
            },
        ),
    ).rejects.toThrow('fixture display failure');
});

test('only bounded known child progress events reach the display', () => {
    const events: SetupProgressEvent[] = [];
    for (const line of [
        'private dependency diagnostic',
        'PI_SETUP_PROGRESS {broken',
        'PI_SETUP_PROGRESS {"stage":"constructor","state":"start"}',
        'PI_SETUP_PROGRESS {"stage":"download","state":"unknown"}',
        'PI_SETUP_PROGRESS {"stage":"download","state":"start","total":999999999}',
    ])
        readSetupProgress(line, (event) => events.push(event));
    expect(events).toEqual([]);
    readSetupProgress(
        'PI_SETUP_PROGRESS {"stage":"packages","state":"start","current":2,"total":3}',
        (event) => events.push(event),
    );
    expect(events).toEqual([
        { stage: 'packages', state: 'start', current: 2, total: 3 },
    ]);
});

test('asynchronous commands forward semantic progress while keeping dependency diagnostics private', async () => {
    const events: SetupProgressEvent[] = [];
    const output = await runAsync(
        process.execPath,
        [
            '-e',
            'console.error("private dependency output"); console.error("PI_SETUP_PROGRESS " + JSON.stringify({stage:"packages",state:"start",current:1,total:2})); console.log("result");',
        ],
        undefined,
        process.env,
        (event) => events.push(event),
    );
    expect(output).toBe('result');
    expect(events).toEqual([
        { stage: 'packages', state: 'start', current: 1, total: 2 },
    ]);
    await expect(
        runAsync(process.execPath, [
            '-e',
            'console.error("Before Bearer fixture-private-key after"); process.exit(3)',
        ]),
    ).rejects.toThrow('after');
    try {
        await runAsync(process.execPath, [
            '-e',
            'console.error("Bearer fixture-private-key"); process.exit(3)',
        ]);
    } catch (error) {
        expect(String(error)).not.toContain('fixture-private-key');
    }
});
