import { describe, expect, it, mock } from 'bun:test';
import { queueWhenIdle } from './queue-when-idle';

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
