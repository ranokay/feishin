import type { Evidence } from './evidence';
import type { DecodedParams, OutputParams } from './formats';
import type { DemuxerObservation, ServerRouteEvidence } from './server-route';

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
    'server-route-resolved',
    'track-ended',
    'track-started',
    'transcode-detected',
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
    /** Demuxer-reported source stream facts for the playing file (mpv track-list). */
    demuxer?: DemuxerObservation | null;
    gaplessAudio: null | string;
    muted: boolean | null;
    outputParams: null | OutputParams;
    physicalFormat: Evidence<string> | null;
    playlistPos: null | number;
    sequence: number;
    /** Server-route verification result; absent until the stream probe resolves. */
    serverRoute?: null | ServerRouteEvidence;
    speed: null | number;
    /** Redacted URL of the playing stream (query secrets scrubbed main-side). */
    streamUrl?: null | string;
    timestamp: number;
    volume: null | number;
}
