import type { AudioSnapshot } from '/@/shared/signalpath';

import isElectron from 'is-electron';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import { logger } from '/@/renderer/utils/logger';

interface AudioStateActions {
    setSnapshot: (snapshot: AudioSnapshot) => void;
}

interface AudioStateState {
    snapshot: AudioSnapshot | null;
}

export const useAudioStateStore = createWithEqualityFn<AudioStateActions & AudioStateState>()(
    (set) => ({
        setSnapshot: (snapshot) => set({ snapshot }),
        snapshot: null,
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
