import type { PhysicalFormatEntry } from './device-capabilities';
import type { AudioEngineFailure } from './engine-errors';
import type { Evidence } from './evidence';
import type { DecodedParams, OutputParams } from './formats';
import type { DemuxerObservation, ServerRouteEvidence } from './server-route';
import type { StrictPropertyViolation } from './strict-properties';

export const AUDIO_ENGINE_EVENT_TYPES = [
    'ao-transition',
    'connection-lost',
    'device-lost',
    'device-opened',
    'device-selected',
    'device-transition',
    'engine-error',
    'exclusive-attempted',
    'exclusive-failed',
    'filters-changed',
    'format-changed',
    'gapless-changed',
    'physical-format',
    'playlist-advanced',
    'rate-changed',
    'server-route-resolved',
    'strict-invalidated',
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
    /** coreaudio_exclusive physical-format list from v-level logs; inferred tier. */
    availablePhysicalFormats?: Evidence<PhysicalFormatEntry[]> | null;
    cacheEofReaching: boolean | null;
    cacheIdle: boolean | null;
    cacheUnderrun: boolean | null;
    decodedParams: DecodedParams | null;
    /** Demuxer-reported source stream facts for the playing file (mpv track-list). */
    demuxer?: DemuxerObservation | null;
    gaplessAudio: null | string;
    /** Most recent typed engine failure; cleared when the next track starts. */
    lastError?: AudioEngineFailure | null;
    /**
     * Monotonic id of the newest recorded engine event, 0 before the first
     * record. Clearing the log does not reset it, so consumers still see new
     * records as advances.
     */
    lastEventId: number;
    muted: boolean | null;
    outputParams: null | OutputParams;
    physicalFormat: Evidence<string> | null;
    /** Renderer queue identity captured by mpv for the file that produced this snapshot. */
    playbackKey: null | string;
    playlistPos: null | number;
    sequence: number;
    /** Server-route verification result; absent until the stream probe resolves. */
    serverRoute?: null | ServerRouteEvidence;
    speed: null | number;
    /** Redacted URL of the playing stream (query secrets scrubbed main-side). */
    streamUrl?: null | string;
    /** Strict pins currently contradicted by an observed mpv property value. */
    strictPropertyViolations: StrictPropertyViolation[];
    /** Why strict property validation is unavailable, when observation failed. */
    strictValidationError: null | string;
    timestamp: number;
    volume: null | number;
}

// sequence/timestamp advance on every broadcast; they signal transport, not
// audio state, so they are not part of snapshot identity.
const VOLATILE_SNAPSHOT_FIELDS = new Set(['sequence', 'timestamp']);

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * Structural equality for audio snapshots. deriveSnapshot re-creates array and
 * evidence objects on every broadcast, so a shallow comparison would report a
 * change while nothing observable changed and re-render Signal Path consumers
 * on the coalescing timer.
 */
export function audioSnapshotsEqual(a: AudioSnapshot | null, b: AudioSnapshot | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return recordsEqual(a, b, VOLATILE_SNAPSHOT_FIELDS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsEqual(a: object, b: object, ignoredKeys: ReadonlySet<string>): boolean {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord).filter((key) => !ignoredKeys.has(key));
    const bKeys = Object.keys(bRecord).filter((key) => !ignoredKeys.has(key));
    return (
        aKeys.length === bKeys.length &&
        aKeys.every((key) => valuesEqual(aRecord[key], bRecord[key]))
    );
}

function valuesEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
        return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return (
            Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((item, index) => valuesEqual(item, b[index]))
        );
    }
    if (isRecord(a) || isRecord(b)) {
        return isRecord(a) && isRecord(b) && recordsEqual(a, b, EMPTY_KEYS);
    }
    return false;
}
