import type { AudioSnapshot, RetainedStrictPlaybackStopState } from '/@/shared/signalpath';

import isElectron from 'is-electron';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import { logger } from '/@/renderer/utils/logger';
import { retainStrictPlaybackStopState } from '/@/shared/signalpath';

interface AudioStateActions {
    clearStrictPlaybackStop: () => void;
    setSnapshot: (snapshot: AudioSnapshot) => void;
    syncPlaybackKey: (playbackKey: null | string) => void;
}

interface AudioStateState {
    snapshot: AudioSnapshot | null;
    strictPlaybackStop: null | RetainedStrictPlaybackStopState;
}

export const useAudioStateStore = createWithEqualityFn<AudioStateActions & AudioStateState>()(
    (set) => ({
        clearStrictPlaybackStop: () =>
            set((state) =>
                state.strictPlaybackStop === null ? state : { strictPlaybackStop: null },
            ),
        setSnapshot: (snapshot) =>
            set((state) => ({
                snapshot,
                strictPlaybackStop: retainStrictPlaybackStopState(
                    state.strictPlaybackStop,
                    snapshot,
                ),
            })),
        snapshot: null,
        strictPlaybackStop: null,
        syncPlaybackKey: (playbackKey) =>
            set((state) =>
                state.strictPlaybackStop === null ||
                state.strictPlaybackStop.playbackKey === playbackKey
                    ? state
                    : { strictPlaybackStop: null },
            ),
    }),
);

if (isElectron()) {
    window.api.audioState.onSnapshotChanged((snapshot) => {
        useAudioStateStore.getState().setSnapshot(snapshot);
    });

    // Hydrate once in case mpv started before this renderer attached.
    window.api.audioState
        .getSnapshot()
        .then((snapshot) => {
            if (snapshot) {
                useAudioStateStore.getState().setSnapshot(snapshot);
            }
        })
        .catch((error) => logger.warn('Failed to hydrate audio snapshot', { error }));
}

// sequence/timestamp advance on every broadcast; comparing only signal-bearing
// fields keeps components idle when observed values did not change.
const VOLATILE_FIELDS = new Set(['sequence', 'timestamp']);

const selectStableSnapshot = (snapshot: AudioSnapshot | null): AudioSnapshot | null => {
    if (!snapshot) {
        return null;
    }
    return Object.fromEntries(
        Object.entries(snapshot).filter(([key]) => !VOLATILE_FIELDS.has(key)),
    ) as AudioSnapshot;
};

export const useAudioSnapshot = (): AudioSnapshot | null => {
    return useAudioStateStore((state) => selectStableSnapshot(state.snapshot), shallow);
};

export const useRetainedStrictPlaybackStop = (): null | RetainedStrictPlaybackStopState => {
    return useAudioStateStore((state) => state.strictPlaybackStop);
};
