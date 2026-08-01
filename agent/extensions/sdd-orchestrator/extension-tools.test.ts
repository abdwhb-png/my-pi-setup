import { expect, mock, test } from 'bun:test';
import type {
    ManifestReviewProgressState,
    ManifestReviewProgressV1,
} from './review-progress.ts';
import { createReviewProgressStorage } from './extension-tools.ts';
import { ReviewProgressConflictError } from './store.ts';

const state: ManifestReviewProgressState = {
    acceptedTaskIds: ['task-1'],
    decision: {
        globalProfile: 'light',
        taskOverrides: {},
        parallelismEnabled: true,
        finalIntegrationReview: false,
        criticalDowngradeConfirmations: {},
        criticalDowngradeJustifications: {},
    },
};

const persisted: ManifestReviewProgressV1 = {
    version: 1,
    manifestId: 'manifest-1',
    revision: 7,
    ...state,
};

test('review progress adapter loads and saves the persisted server revision', () => {
    const loadReviewProgress = mock(() => persisted);
    const saveReviewProgress = mock(() => persisted);
    const storage = createReviewProgressStorage({
        loadReviewProgress,
        saveReviewProgress,
    });

    expect(storage.loadReviewProgress?.('manifest-1')).toEqual(persisted);
    expect(storage.saveReviewProgress?.('manifest-1', 6, state)).toEqual({
        type: 'ok',
        revision: 7,
    });
    expect(saveReviewProgress).toHaveBeenCalledWith('manifest-1', 6, state);
});

test('review progress adapter reloads the winner for the store revision-conflict message', () => {
    const current = { ...persisted, revision: 8 };
    const storage = createReviewProgressStorage({
        loadReviewProgress: () => current,
        saveReviewProgress: () => {
            throw new ReviewProgressConflictError(8, 7);
        },
    });

    expect(storage.saveReviewProgress?.('manifest-1', 7, state)).toEqual({
        type: 'conflict',
        current,
    });
});

test('review progress adapter reports the conflict when no winner can be reloaded', () => {
    const storage = createReviewProgressStorage({
        loadReviewProgress: () => null,
        saveReviewProgress: () => {
            throw new ReviewProgressConflictError(1, 0);
        },
    });

    expect(storage.saveReviewProgress?.('manifest-1', 0, state)).toEqual({
        type: 'error',
        error: 'Review progress revision conflict: expected 1, received 0.',
    });
});

test('review progress adapter does not classify a prefixed I/O error as a conflict', () => {
    const storage = createReviewProgressStorage({
        loadReviewProgress: () => persisted,
        saveReviewProgress: () => {
            throw new Error('Review progress revision conflict: disk offline');
        },
    });

    expect(storage.saveReviewProgress?.('manifest-1', 0, state)).toEqual({
        type: 'error',
        error: 'Review progress revision conflict: disk offline',
    });
});

test('review progress adapter reports non-conflict store I/O errors', () => {
    const storage = createReviewProgressStorage({
        loadReviewProgress: () => null,
        saveReviewProgress: () => {
            throw new Error('disk offline');
        },
    });

    expect(storage.saveReviewProgress?.('manifest-1', 0, state)).toEqual({
        type: 'error',
        error: 'disk offline',
    });
});
