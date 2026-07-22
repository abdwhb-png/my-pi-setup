import { describe, expect, it, mock } from 'bun:test';
import {
    createLatestIdleTaskScheduler,
    queueWhenIdle,
} from './queue-when-idle';

describe('queueWhenIdle', () => {
    it('runs a queued task only after Pi becomes idle', () => {
        const task = mock();
        const callbacks: Array<() => void> = [];
        let idle = false;

        queueWhenIdle(
            task,
            () => idle,
            (callback) => {
                callbacks.push(callback);
            },
        );

        expect(task).not.toHaveBeenCalled();
        expect(callbacks).toHaveLength(1);

        callbacks.shift()?.();
        expect(task).not.toHaveBeenCalled();
        expect(callbacks).toHaveLength(1);

        idle = true;
        callbacks.shift()?.();
        expect(task).toHaveBeenCalledTimes(1);
    });
});

describe('createLatestIdleTaskScheduler', () => {
    it('only runs the latest task queued before Pi becomes idle', () => {
        const callbacks: Array<() => void> = [];
        const firstTask = mock();
        const latestTask = mock();
        let idle = false;
        const scheduler = createLatestIdleTaskScheduler((callback) => {
            callbacks.push(callback);
        });

        scheduler.schedule(firstTask, () => idle);
        scheduler.schedule(latestTask, () => idle);

        callbacks.shift()?.();
        callbacks.shift()?.();

        expect(firstTask).not.toHaveBeenCalled();
        expect(latestTask).not.toHaveBeenCalled();

        idle = true;
        while (callbacks.length > 0) callbacks.shift()?.();

        expect(firstTask).not.toHaveBeenCalled();
        expect(latestTask).toHaveBeenCalledTimes(1);
    });

    it('invalidates a pending task', () => {
        const callbacks: Array<() => void> = [];
        const task = mock();
        const scheduler = createLatestIdleTaskScheduler((callback) => {
            callbacks.push(callback);
        });

        scheduler.schedule(task);
        scheduler.invalidate();
        while (callbacks.length > 0) callbacks.shift()?.();

        expect(task).not.toHaveBeenCalled();
    });
});
