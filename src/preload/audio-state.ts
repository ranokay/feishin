import type { AudioEngineEvent, AudioSnapshot } from '/@/shared/signalpath';

import { ipcRenderer } from 'electron';

const getSnapshot = (): Promise<AudioSnapshot | null> => {
    return ipcRenderer.invoke('player-audio-snapshot');
};

const getEvents = (): Promise<AudioEngineEvent[]> => {
    return ipcRenderer.invoke('player-audio-event-log');
};

const onSnapshotChanged = (callback: (snapshot: AudioSnapshot) => void) => {
    const listener = (_event: unknown, snapshot: AudioSnapshot) => callback(snapshot);
    ipcRenderer.on('renderer-audio-state-changed', listener);
    return () => {
        ipcRenderer.removeListener('renderer-audio-state-changed', listener);
    };
};

export const audioState = {
    getEvents,
    getSnapshot,
    onSnapshotChanged,
};

export type AudioStateApi = typeof audioState;
