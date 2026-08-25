import type { Evidence } from './evidence';
import type { DecodedParams, OutputParams } from './formats';

export const AUDIO_ENGINE_EVENT_TYPES = [
    'ao-transition',
    'connection-lost',
    'device-lost',
    'device-opened',
    'device-selected',
    'exclusive-attempted',
    'exclusive-failed',
    'filters-changed',
    'format-changed',
    'gapless-changed',
    'physical-format',
    'playlist-advanced',
    'rate-changed',
    'track-ended',
    'track-started',
] as const;

export interface AudioEngineEvent {
    detail: null | string;
    id: number;
    time: number;
    type: AudioEngineEventType;
}

export type AudioEngineEventType = (typeof AUDIO_ENGINE_EVENT_TYPES)[number];

export interface AudioSnapshot {
    activeFilters: null | string[];
    aoDriver: null | string;
    audioDevice: null | string;
    cacheEofReaching: boolean | null;
    cacheIdle: boolean | null;
    cacheUnderrun: boolean | null;
    decodedParams: DecodedParams | null;
    gaplessAudio: null | string;
    muted: boolean | null;
    outputParams: null | OutputParams;
    physicalFormat: Evidence<string> | null;
    playlistPos: null | number;
    sequence: number;
    speed: null | number;
    timestamp: number;
    volume: null | number;
}
