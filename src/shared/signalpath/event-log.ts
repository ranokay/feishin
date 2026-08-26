import type { AudioEngineEvent, AudioEngineEventType } from './snapshot';

export const AUDIO_EVENT_CATEGORIES = [
    'connection',
    'decoder',
    'device',
    'filters',
    'lifecycle',
    'output',
    'server',
] as const;

export type AudioEventCategory = (typeof AUDIO_EVENT_CATEGORIES)[number];

export const AUDIO_EVENT_SEVERITIES = ['debug', 'info', 'warning', 'error'] as const;

export type AudioEventSeverity = (typeof AUDIO_EVENT_SEVERITIES)[number];

// Exhaustive maps: adding an engine event type without classifying it fails the build.
const CATEGORY: Record<AudioEngineEventType, AudioEventCategory> = {
    'ao-transition': 'output',
    'connection-lost': 'connection',
    'device-lost': 'device',
    'device-opened': 'device',
    'device-selected': 'device',
    'exclusive-attempted': 'output',
    'exclusive-failed': 'output',
    'filters-changed': 'filters',
    'format-changed': 'decoder',
    'gapless-changed': 'decoder',
    'physical-format': 'device',
    'playlist-advanced': 'lifecycle',
    'rate-changed': 'device',
    'server-route-resolved': 'server',
    'track-ended': 'lifecycle',
    'track-started': 'lifecycle',
    'transcode-detected': 'server',
};

const SEVERITY: Record<AudioEngineEventType, AudioEventSeverity> = {
    'ao-transition': 'info',
    'connection-lost': 'error',
    'device-lost': 'warning',
    'device-opened': 'info',
    'device-selected': 'info',
    'exclusive-attempted': 'debug',
    'exclusive-failed': 'error',
    'filters-changed': 'info',
    'format-changed': 'info',
    'gapless-changed': 'info',
    'physical-format': 'info',
    'playlist-advanced': 'debug',
    'rate-changed': 'info',
    'server-route-resolved': 'info',
    'track-ended': 'debug',
    'track-started': 'info',
    'transcode-detected': 'warning',
};

export interface AudioEventFilter {
    category?: 'all' | AudioEventCategory;
    severity?: 'all' | AudioEventSeverity;
}

export function audioEventCategory(type: AudioEngineEventType): AudioEventCategory {
    return CATEGORY[type];
}

export function audioEventSeverity(type: AudioEngineEventType): AudioEventSeverity {
    return SEVERITY[type];
}

export function filterAudioEvents(
    events: AudioEngineEvent[],
    filter: AudioEventFilter,
): AudioEngineEvent[] {
    return events.filter(
        (event) =>
            (!filter.category ||
                filter.category === 'all' ||
                CATEGORY[event.type] === filter.category) &&
            (!filter.severity ||
                filter.severity === 'all' ||
                SEVERITY[event.type] === filter.severity),
    );
}
