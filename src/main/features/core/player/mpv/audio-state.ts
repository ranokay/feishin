import type {
    AudioEngineEvent,
    AudioSnapshot,
    DecodedParams,
    Evidence,
} from '/@/shared/signalpath';

import type { MpvEventHandler } from './ipc-client';

export type PendingAudioEngineEvent = Omit<AudioEngineEvent, 'id' | 'time'>;

export const OBSERVED_AUDIO_PROPERTIES = [
    'af',
    'audio-device',
    'audio-out-params',
    'audio-params',
    'current-ao',
    'demuxer-cache-state',
    'gapless-audio',
    'mute',
    'playlist-pos',
    'speed',
    'volume',
] as const;

export interface AudioStateConnection {
    dispose(): void;
    enableLogMessages(level: string): Promise<void>;
    observe(id: number, propertyName: string): Promise<void>;
    onClose(handler: () => void): () => void;
    onEvent(eventName: string, handler: MpvEventHandler): () => void;
}

export interface AudioStateServiceOptions {
    broadcast?: (snapshot: AudioSnapshot) => void;
    eventLimit?: number;
    intervalMs?: number;
}

export interface ObservedAudioState {
    activeFilters: null | string[];
    aoDriver: null | string;
    audioDevice: null | string;
    cacheEofReaching: boolean | null;
    cacheIdle: boolean | null;
    cacheUnderrun: boolean | null;
    decodedParams: DecodedParams | null;
    gaplessAudio: null | string;
    muted: boolean | null;
    outputParams: DecodedParams | null;
    physicalFormat: Evidence<string> | null;
    playlistPos: null | number;
    rawFilters: null | string;
    speed: null | number;
    volume: null | number;
}

export function applyPropertyValue(
    state: ObservedAudioState,
    name: string,
    value: unknown,
): PendingAudioEngineEvent[] {
    const events: PendingAudioEngineEvent[] = [];

    switch (name) {
        case 'af': {
            const filters = readFilterNames(value);
            const serialized = JSON.stringify(filters);
            if (state.rawFilters !== null && serialized !== state.rawFilters) {
                events.push({ detail: filters.join(','), type: 'filters-changed' });
            }
            state.rawFilters = serialized;
            state.activeFilters = filters;
            break;
        }
        case 'audio-device': {
            const next = typeof value === 'string' ? value : null;
            if (state.audioDevice !== null && next !== state.audioDevice) {
                events.push({ detail: next, type: 'device-selected' });
            }
            state.audioDevice = next;
            break;
        }
        case 'audio-out-params': {
            const next = readParams(value);
            events.push(...compareParamTransition('output', state.outputParams, next));
            state.outputParams = next;
            break;
        }
        case 'audio-params': {
            const next = readParams(value);
            events.push(...compareParamTransition('decoded', state.decodedParams, next));
            state.decodedParams = next;
            break;
        }
        case 'current-ao': {
            const next = typeof value === 'string' ? value : null;
            if (next !== state.aoDriver) {
                if (next === null) {
                    events.push({ detail: state.aoDriver, type: 'device-lost' });
                    state.physicalFormat = null;
                } else {
                    events.push({
                        detail: state.aoDriver === null ? next : `${state.aoDriver} -> ${next}`,
                        type: 'device-opened',
                    });
                }
                state.aoDriver = next;
            }
            break;
        }
        case 'demuxer-cache-state': {
            const node = isRecord(value) ? value : {};
            state.cacheEofReaching = readOptionalBoolean(node['eof-reaching']);
            state.cacheIdle = readOptionalBoolean(node['idle']);
            state.cacheUnderrun = readOptionalBoolean(node['underrun']);
            break;
        }
        case 'gapless-audio': {
            const next = typeof value === 'string' ? value : null;
            if (state.gaplessAudio !== null && next !== state.gaplessAudio) {
                events.push({
                    detail: `${state.gaplessAudio} -> ${next}`,
                    type: 'gapless-changed',
                });
            }
            state.gaplessAudio = next;
            break;
        }
        case 'mute':
            state.muted = typeof value === 'boolean' ? value : null;
            break;
        case 'playlist-pos': {
            const next = typeof value === 'number' ? value : null;
            if (state.playlistPos !== null && next !== state.playlistPos) {
                events.push({
                    detail: `${state.playlistPos} -> ${next}`,
                    type: 'playlist-advanced',
                });
            }
            state.playlistPos = next;
            break;
        }
        case 'speed':
            state.speed = typeof value === 'number' ? value : null;
            break;
        case 'volume':
            state.volume = typeof value === 'number' ? value : null;
            break;
        default:
            break;
    }

    return events;
}

export function createObservedAudioState(): ObservedAudioState {
    return {
        activeFilters: null,
        aoDriver: null,
        audioDevice: null,
        cacheEofReaching: null,
        cacheIdle: null,
        cacheUnderrun: null,
        decodedParams: null,
        gaplessAudio: null,
        muted: null,
        outputParams: null,
        physicalFormat: null,
        playlistPos: null,
        rawFilters: null,
        speed: null,
        volume: null,
    };
}

export function deriveSnapshot(state: ObservedAudioState, sequence: number): AudioSnapshot {
    return {
        activeFilters: state.activeFilters,
        aoDriver: state.aoDriver,
        audioDevice: state.audioDevice,
        cacheEofReaching: state.cacheEofReaching,
        cacheIdle: state.cacheIdle,
        cacheUnderrun: state.cacheUnderrun,
        decodedParams: state.decodedParams,
        gaplessAudio: state.gaplessAudio,
        muted: state.muted,
        outputParams: state.outputParams,
        physicalFormat: state.physicalFormat,
        playlistPos: state.playlistPos,
        sequence,
        speed: state.speed,
        timestamp: Date.now(),
        volume: state.volume,
    };
}

export function parseAoLogEvent(prefix: string, text: string): null | PendingAudioEngineEvent {
    if (!prefix.startsWith('ao/')) {
        return null;
    }

    const detail = text.trim();

    if (/hog ?mode/i.test(detail) && /could not|denied|error|fail/i.test(detail)) {
        return { detail, type: 'exclusive-failed' };
    }
    if (/exclusive/i.test(detail) && /failed to (?:initialize|open)/i.test(detail)) {
        return { detail, type: 'exclusive-failed' };
    }
    if (
        /exclusive/i.test(detail) &&
        /acquir|attempt|enabl|redirect|request|select|trying|using/i.test(detail)
    ) {
        return { detail, type: 'exclusive-attempted' };
    }
    if (/physical format/i.test(detail)) {
        return { detail, type: 'physical-format' };
    }

    return null;
}

const DEFAULT_EVENT_LIMIT = 500;
const DEFAULT_INTERVAL_MS = 100;

export class AudioStateService {
    private broadcastTimer: NodeJS.Timeout | null = null;
    private readonly connection: AudioStateConnection;
    private disposers: Array<() => void> = [];
    private readonly eventLimit: number;
    private readonly events: AudioEngineEvent[] = [];
    private readonly intervalMs: number;
    private lastSequence = 0;
    private nextEventId = 1;
    private readonly onBroadcast: (snapshot: AudioSnapshot) => void;
    private readonly state = createObservedAudioState();
    private stopped = false;

    constructor(connection: AudioStateConnection, options: AudioStateServiceOptions = {}) {
        this.connection = connection;
        this.onBroadcast = options.broadcast ?? (() => {});
        this.eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
        this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    }

    dispose(): void {
        this.stopped = true;
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        for (const dispose of this.disposers.splice(0)) {
            dispose();
        }
        this.events.length = 0;
        this.connection.dispose();
    }

    getEvents(): AudioEngineEvent[] {
        return [...this.events];
    }

    getSnapshot(): AudioSnapshot {
        return deriveSnapshot(this.state, this.lastSequence);
    }

    async start(): Promise<void> {
        this.subscribe('property-change', (payload) => {
            const name = payload['name'];
            if (typeof name !== 'string') {
                return;
            }
            for (const event of applyPropertyValue(this.state, name, payload['data'])) {
                this.record(event);
            }
            this.scheduleBroadcast();
        });
        this.subscribe('log-message', (payload) => {
            const parsed = parseAoLogEvent(
                String(payload['prefix'] ?? ''),
                String(payload['text'] ?? ''),
            );
            if (!parsed) {
                return;
            }
            if (parsed.type === 'physical-format') {
                this.state.physicalFormat = {
                    level: 'inferred',
                    source: 'mpv-log',
                    value: parsed.detail ?? '',
                };
            }
            this.record(parsed);
        });
        this.subscribe('audio-reconfig', () => {
            // Renegotiation invalidates the previous device negotiation evidence.
            this.state.physicalFormat = null;
            this.record({ detail: 'device renegotiation', type: 'ao-transition' });
        });
        this.subscribe('start-file', () => {
            this.record({ detail: null, type: 'track-started' });
        });
        this.subscribe('end-file', (payload) => {
            const reason = payload['reason'];
            this.record({ detail: reason == null ? null : String(reason), type: 'track-ended' });
        });

        for (const [index, propertyName] of OBSERVED_AUDIO_PROPERTIES.entries()) {
            try {
                await this.connection.observe(index + 1, propertyName);
            } catch {
                // Property may not exist in older mpv builds; skip it.
            }
        }

        try {
            await this.connection.enableLogMessages('v');
        } catch {
            // Verbose logs unavailable; evidence stays at the unknown tier.
        }

        this.disposers.push(this.connection.onClose(() => this.handleClose()));
    }

    private emitSnapshot(): void {
        this.lastSequence += 1;
        this.onBroadcast(deriveSnapshot(this.state, this.lastSequence));
    }

    private handleClose(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.pushEvent({ detail: null, type: 'connection-lost' });
        // Dead values must not stay queryable: reset to a clean unavailable snapshot.
        Object.assign(this.state, createObservedAudioState());
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.emitSnapshot();
    }

    private pushEvent(event: PendingAudioEngineEvent): void {
        this.events.push({ ...event, id: this.nextEventId, time: Date.now() });
        this.nextEventId += 1;
        if (this.events.length > this.eventLimit) {
            this.events.splice(0, this.events.length - this.eventLimit);
        }
    }

    private record(event: PendingAudioEngineEvent): void {
        this.pushEvent(event);
        this.scheduleBroadcast();
    }

    private scheduleBroadcast(): void {
        if (this.stopped || this.broadcastTimer) {
            return;
        }
        this.broadcastTimer = setTimeout(() => {
            this.broadcastTimer = null;
            if (!this.stopped) {
                this.emitSnapshot();
            }
        }, this.intervalMs);
    }

    private subscribe(eventName: string, handler: MpvEventHandler): void {
        this.disposers.push(this.connection.onEvent(eventName, handler));
    }
}

function compareParamTransition(
    stage: 'decoded' | 'output',
    previous: DecodedParams | null,
    next: DecodedParams | null,
): PendingAudioEngineEvent[] {
    if (!previous) {
        return [];
    }
    if (!next) {
        return [{ detail: `${stage} params unavailable`, type: 'ao-transition' }];
    }
    if (previous.samplerate !== next.samplerate) {
        return [
            {
                detail: `${stage} rate ${formatRate(previous.samplerate)} -> ${formatRate(next.samplerate)}`,
                type: 'rate-changed',
            },
        ];
    }
    if (previous.format !== next.format || previous.channels !== next.channels) {
        return [
            {
                detail: `${stage} format ${previous.format}/${previous.channels}ch -> ${next.format}/${next.channels}ch`,
                type: 'format-changed',
            },
        ];
    }
    return [];
}

function formatRate(rate: null | number): string {
    return rate === null ? 'unknown' : String(rate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readFilterNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((filter) =>
            isRecord(filter) && typeof filter['name'] === 'string'
                ? filter['name']
                : String(filter ?? ''),
        )
        .filter((name) => name.length > 0);
}

function readOptionalBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function readParams(value: unknown): DecodedParams | null {
    if (!isRecord(value)) {
        return null;
    }
    if (value['format'] === undefined && value['samplerate'] === undefined) {
        return null;
    }
    return {
        channels:
            typeof value['channel-count'] === 'number'
                ? value['channel-count']
                : typeof value['channels'] === 'number'
                  ? value['channels']
                  : null,
        format: typeof value['format'] === 'string' ? value['format'] : null,
        samplerate: typeof value['samplerate'] === 'number' ? value['samplerate'] : null,
    };
}
