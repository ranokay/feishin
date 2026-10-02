import { describe, expect, it } from 'vitest';

import {
    createObservedAudioState,
    deriveSnapshot,
} from '../src/main/features/core/player/mpv/audio-state';
import { audioSnapshotsEqual } from '../src/shared/signalpath';

// Guards the equality the renderer store applies to snapshots: only observable
// changes may invalidate the selection and re-render Signal Path consumers.
describe('audioSnapshotsEqual', () => {
    it('treats broadcasts that only advance volatile fields as equal', () => {
        const state = createObservedAudioState();
        state.volume = 100;

        expect(audioSnapshotsEqual(deriveSnapshot(state, 1, 0), deriveSnapshot(state, 2, 0))).toBe(
            true,
        );
    });

    it('compares re-created array fields by content', () => {
        const state = createObservedAudioState();
        state.volume = 100;
        state.strictPropertyViolations = [{ actual: '70', expected: '100', property: 'volume' }];

        const first = deriveSnapshot(state, 1, 0);
        const second = deriveSnapshot(state, 2, 0);
        expect(first.strictPropertyViolations).not.toBe(second.strictPropertyViolations);
        expect(audioSnapshotsEqual(first, second)).toBe(true);

        state.strictPropertyViolations = [{ actual: '60', expected: '100', property: 'volume' }];
        expect(audioSnapshotsEqual(first, deriveSnapshot(state, 3, 0))).toBe(false);
    });

    it('compares unequal when an observed value or the event log advances', () => {
        const state = createObservedAudioState();
        state.volume = 100;
        const base = deriveSnapshot(state, 1, 0);

        state.volume = 99;
        expect(audioSnapshotsEqual(base, deriveSnapshot(state, 2, 0))).toBe(false);

        state.volume = 100;
        expect(audioSnapshotsEqual(base, deriveSnapshot(state, 3, 1))).toBe(false);
    });

    it('treats two absent snapshots as equal', () => {
        expect(audioSnapshotsEqual(null, null)).toBe(true);
        expect(audioSnapshotsEqual(null, deriveSnapshot(createObservedAudioState(), 1, 0))).toBe(
            false,
        );
    });
});
