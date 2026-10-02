import type { AudioSnapshot, RetainedStrictPlaybackStopState } from '/@/shared/signalpath';

import isElectron from 'is-electron';
import { createWithEqualityFn } from 'zustand/traditional';

import { logger } from '/@/renderer/utils/logger';
import { audioSnapshotsEqual, retainStrictPlaybackStopState } from '/@/shared/signalpath';

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

export const useAudioSnapshot = (): AudioSnapshot | null => {
    return useAudioStateStore((state) => state.snapshot, audioSnapshotsEqual);
};

export const useRetainedStrictPlaybackStop = (): null | RetainedStrictPlaybackStopState => {
    return useAudioStateStore((state) => state.strictPlaybackStop);
};
