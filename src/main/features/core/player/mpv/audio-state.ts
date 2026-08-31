import type {
    AudioEngineEvent,
    AudioSnapshot,
    DecodedParams,
    Evidence,
    StrictPropertyPin,
} from '/@/shared/signalpath';
import type {
    AudioEngineFailure,
    DemuxerObservation,
    ServerRouteEvidence,
    ServerVerificationRequest,
    SourceStreamDeclaration,
    StreamHeaderProbe,
    StrictPropertyViolation,
} from '/@/shared/signalpath';

import type { MpvEventHandler } from './ipc-client';

import {
    classifyAoFailure,
    classifyEndFileError,
    evaluateServerRoute,
    findStrictPropertyViolation,
    redactStreamUrl,
    unknownFailure,
} from '/@/shared/signalpath';

export type PendingAudioEngineEvent = Omit<AudioEngineEvent, 'id' | 'time'>;

export const OBSERVED_AUDIO_PROPERTIES = [
    'af',
    'audio-device',
    'audio-out-params',
    'audio-params',
    'audio-samplerate',
    'current-ao',
    'demuxer-cache-state',
    'gapless-audio',
    'mute',
    'playlist-pos',
    'replaygain',
    'speed',
    'track-list',
    'volume',
] as const;

export interface AudioStateConnection {
    dispose(): void;
    enableLogMessages(level: string): Promise<void>;
    observe(id: number, propertyName: string): Promise<void>;
    onClose(handler: () => void): () => void;
    onEvent(eventName: string, handler: MpvEventHandler): () => void;
}

export type { ServerVerificationRequest };

export interface AudioStateServiceOptions {
    broadcast?: (snapshot: AudioSnapshot) => void;
    eventLimit?: number;
    intervalMs?: number;
    /** Process logger injection; the module itself stays import-safe outside electron. */
    log?: { debug: (message: string) => void; warn: (message: string, error?: unknown) => void };
    /** Typed engine failures (exclusive contention etc.) for immediate surfacing. */
    onEngineError?: (failure: AudioEngineFailure) => void;
    /** Injectable stream-header probe; verification stays off when absent. */
    probeStreamHeaders?: (url: string) => Promise<null | StreamHeaderProbe>;
    /** Command-owner callback. The observation connection remains read-only. */
    repairStrictProperty?: (pin: StrictPropertyPin) => Promise<void>;
    strictPropertyPins?: readonly StrictPropertyPin[];
}

export interface ObservedAudioState {
    activeFilters: null | string[];
    aoDriver: null | string;
    audioDevice: null | string;
    cacheEofReaching: boolean | null;
    cacheIdle: boolean | null;
    cacheUnderrun: boolean | null;
    decodedParams: DecodedParams | null;
    demuxer: DemuxerObservation | null;
    gaplessAudio: null | string;
    lastError: AudioEngineFailure | null;
    muted: boolean | null;
    outputParams: DecodedParams | null;
    physicalFormat: Evidence<string> | null;
    playlistPos: null | number;
    rawFilters: null | string;
    serverRoute: null | ServerRouteEvidence;
    speed: null | number;
    streamUrl: null | string;
    strictPropertyViolations: StrictPropertyViolation[];
    strictValidationError: null | string;
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
        case 'track-list':
            state.demuxer = readDemuxerObservation(value);
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
        demuxer: null,
        gaplessAudio: null,
        lastError: null,
        muted: null,
        outputParams: null,
        physicalFormat: null,
        playlistPos: null,
        rawFilters: null,
        serverRoute: null,
        speed: null,
        streamUrl: null,
        strictPropertyViolations: [],
        strictValidationError: null,
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
        demuxer: state.demuxer,
        gaplessAudio: state.gaplessAudio,
        lastError: state.lastError,
        muted: state.muted,
        outputParams: state.outputParams,
        physicalFormat: state.physicalFormat,
        playlistPos: state.playlistPos,
        sequence,
        serverRoute: state.serverRoute,
        speed: state.speed,
        streamUrl: state.streamUrl,
        strictPropertyViolations: [...state.strictPropertyViolations],
        strictValidationError: state.strictValidationError,
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
    // Generic AO-init failure (rate/format/device rejections under any driver).
    if (/failed to initialize|failed to open|could not open|device disappeared/i.test(detail)) {
        return { detail, type: 'engine-error' };
    }

    return null;
}

const DEFAULT_EVENT_LIMIT = 500;
const DEFAULT_INTERVAL_MS = 100;
const STRICT_REPAIR_COMMAND_TIMEOUT_MS = 1000;
const STRICT_REPAIR_CONFIRMATION_MS = 100;
const STRICT_REPAIR_MAX_ATTEMPTS = 2;

/**
 * Inputs of the most recent verification request. Kept around so demuxer facts
 * landing after the header probe trigger one re-evaluation (the evaluator is
 * pure; the cached-transcode cross-check needs both sides).
 */
interface LastServerVerification {
    declaration: SourceStreamDeclaration;
    demuxerApplied: boolean;
    generation: number;
    headers: null | StreamHeaderProbe;
    /** Redacted URL of the request; restored when start-file raced the probe. */
    streamUrl: string;
}

export class AudioStateService {
    private broadcastTimer: NodeJS.Timeout | null = null;
    private readonly connection: AudioStateConnection;
    private disposers: Array<() => void> = [];
    private readonly eventLimit: number;
    private readonly events: AudioEngineEvent[] = [];
    private readonly intervalMs: number;
    private readonly invalidatedStrictProperties = new Set<string>();
    private lastSequence = 0;
    private lastVerification: LastServerVerification | null = null;
    private readonly log: {
        debug: (message: string) => void;
        warn: (message: string, error?: unknown) => void;
    };
    private nextEventId = 1;
    private readonly onBroadcast: (snapshot: AudioSnapshot) => void;
    private readonly onEngineError: ((failure: AudioEngineFailure) => void) | null;
    private readonly probeStreamHeaders:
        | ((url: string) => Promise<null | StreamHeaderProbe>)
        | null;
    private readonly repairingStrictProperties = new Set<string>();
    private readonly repairStrictProperty: ((pin: StrictPropertyPin) => Promise<void>) | null;
    private readonly state = createObservedAudioState();
    private stopped = false;
    private readonly strictPropertyPins = new Map<string, StrictPropertyPin>();
    private readonly strictRepairAttempts = new Map<string, number>();
    private readonly strictRepairTimers = new Map<string, NodeJS.Timeout>();
    private verificationGeneration = 0;

    constructor(connection: AudioStateConnection, options: AudioStateServiceOptions = {}) {
        this.connection = connection;
        this.onBroadcast = options.broadcast ?? (() => {});
        this.eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
        this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.log = options.log ?? { debug: () => {}, warn: () => {} };
        this.onEngineError = options.onEngineError ?? null;
        this.probeStreamHeaders = options.probeStreamHeaders ?? null;
        this.repairStrictProperty = options.repairStrictProperty ?? null;
        for (const pin of options.strictPropertyPins ?? []) {
            this.strictPropertyPins.set(pin.name, pin);
        }
    }

    dispose(): void {
        this.stopped = true;
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        for (const timer of this.strictRepairTimers.values()) {
            clearTimeout(timer);
        }
        this.strictRepairTimers.clear();
        this.lastVerification = null;
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

    /**
     * Verifies the server route for the playing track: probes response headers
     * and cross-checks them against the library declaration plus demuxer facts.
     * Failures degrade to absent evidence, never to a claimed verdict.
     */
    requestServerVerification(request: ServerVerificationRequest): void {
        if (this.stopped || !this.probeStreamHeaders) {
            return;
        }
        const generation = ++this.verificationGeneration;
        // Stale evidence from the previous track must not survive the new
        // request - demuxer facts included, otherwise a fast probe would pair
        // the previous track's codec/rate with this track's headers.
        this.state.serverRoute = null;
        this.state.demuxer = null;
        // Kept for the Stream Inspector, redacted: stream URLs carry credentials.
        const streamUrl = redactStreamUrl(request.url);
        this.state.streamUrl = streamUrl;
        this.scheduleBroadcast();
        const probe = this.probeStreamHeaders;

        void Promise.resolve()
            .then(() => probe(request.url))
            .then((headers) => {
                if (this.stopped || generation !== this.verificationGeneration) {
                    return;
                }
                if (headers === null) {
                    // Query string is redacted: stream URLs carry credentials.
                    this.log.debug(
                        `Stream route probe returned no usable headers for ${request.url.split('?')[0]}`,
                    );
                    return;
                }
                this.lastVerification = {
                    declaration: request.declaration,
                    // Facts already on record count as incorporated by the first evaluation.
                    demuxerApplied: this.state.demuxer !== null,
                    generation,
                    headers,
                    streamUrl,
                };
                this.applyServerVerification();
            })
            .catch((error) => {
                this.log.warn('Stream route verification failed', error);
            });
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
            this.revalidateStrictProperty(name, payload['data']);
            if (
                name === 'track-list' &&
                this.state.demuxer !== null &&
                this.lastVerification !== null &&
                !this.lastVerification.demuxerApplied
            ) {
                // Demuxer facts landed after the header probe: re-run the
                // cross-check once so cached transcodes get caught.
                this.applyServerVerification();
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
                this.record(parsed);
                return;
            }
            if (parsed.type === 'engine-error') {
                // Typed carrier: classified then recorded once, with cause.
                this.handleEngineFailure(this.classifyFailure(parsed.detail ?? ''));
                return;
            }
            if (parsed.type === 'exclusive-failed') {
                this.record(parsed);
                this.handleEngineFailure(this.classifyFailure(parsed.detail ?? ''));
                return;
            }
            this.record(parsed);
        });
        this.subscribe('audio-reconfig', () => {
            // Renegotiation invalidates the previous device negotiation evidence.
            this.state.physicalFormat = null;
            this.record({ detail: 'device renegotiation', type: 'ao-transition' });
        });
        this.subscribe('start-file', () => {
            // Stale route evidence, URLs, and errors must not bleed into the
            // new track. A newer request in flight re-populates them.
            this.state.serverRoute = null;
            this.state.streamUrl = null;
            this.state.lastError = null;
            if (this.lastVerification) {
                this.lastVerification.demuxerApplied = true;
            }
            this.record({ detail: null, type: 'track-started' });
        });
        this.subscribe('end-file', (payload) => {
            const reason = payload['reason'];
            this.record({ detail: reason == null ? null : String(reason), type: 'track-ended' });
            // A classified AO failure usually precedes an error end-file;
            // only raise the generic unknown failure when nothing is recorded.
            if (reason === 'error' && this.state.lastError === null) {
                this.handleEngineFailure(classifyEndFileError());
            }
        });

        this.disposers.push(this.connection.onClose(() => this.handleClose()));

        for (const [index, propertyName] of OBSERVED_AUDIO_PROPERTIES.entries()) {
            if (this.stopped) {
                return;
            }
            try {
                await this.connection.observe(index + 1, propertyName);
            } catch (error) {
                if (this.stopped) {
                    return;
                }
                // Older builds may lack a property. Ordinary policy can skip it;
                // strict policy must expose the missing validation evidence.
                const pin = this.strictPropertyPins.get(propertyName);
                if (pin) {
                    this.state.strictValidationError = `strict property observation unavailable: ${propertyName}`;
                    this.recordStrictObservationFailure(pin, error);
                }
            }
        }

        if (this.stopped) {
            return;
        }
        try {
            await this.connection.enableLogMessages('v');
        } catch {
            // Verbose logs unavailable; evidence stays at the unknown tier.
        }
    }

    private applyServerVerification(): void {
        const verification = this.lastVerification;
        if (!verification || verification.headers === null) {
            return;
        }
        if (this.stopped || verification.generation !== this.verificationGeneration) {
            return;
        }
        const evidence = evaluateServerRoute({
            demuxer: this.state.demuxer,
            headers: verification.headers,
            source: verification.declaration,
        });
        verification.demuxerApplied = this.state.demuxer !== null;
        this.state.streamUrl = verification.streamUrl;
        const previous = this.state.serverRoute;
        this.state.serverRoute = evidence;
        if (
            previous &&
            previous.route === evidence.route &&
            previous.verification === evidence.verification &&
            previous.detail === evidence.detail
        ) {
            // Re-check concluded identically: not an occurrence worth logging.
            return;
        }
        if (evidence.route === 'transcoded') {
            this.log.warn(`Transcoded stream detected: ${evidence.detail ?? 'unknown mismatch'}`);
            this.record({ detail: evidence.detail, type: 'transcode-detected' });
            return;
        }
        this.record({
            detail:
                evidence.route === 'unverified'
                    ? null
                    : `${evidence.route} (${evidence.verification})`,
            type: 'server-route-resolved',
        });
    }

    private classifyFailure(detail: string): AudioEngineFailure {
        return classifyAoFailure(detail) ?? unknownFailure(detail);
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
        this.lastVerification = null;
        this.pushEvent({ detail: null, type: 'connection-lost' });
        // Dead values must not stay queryable: reset to a clean unavailable snapshot.
        Object.assign(this.state, createObservedAudioState());
        if (this.strictPropertyPins.size > 0) {
            const detail = 'strict property observability lost';
            this.state.strictValidationError = detail;
            this.pushEvent({ detail, type: 'strict-invalidated' });
            this.log.warn(detail);
        }
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        this.emitSnapshot();
    }

    private handleEngineFailure(failure: AudioEngineFailure): void {
        this.state.lastError = failure;
        this.log.warn(`Audio engine error (${failure.cause}): ${failure.explanation}`);
        this.record({
            detail: `${failure.cause}: ${failure.explanation}`,
            type: 'engine-error',
        });
        this.onEngineError?.(failure);
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

    private recordStrictInvalidation(
        pin: StrictPropertyPin,
        violation: StrictPropertyViolation,
        error?: unknown,
    ): void {
        if (this.invalidatedStrictProperties.has(pin.name)) {
            return;
        }
        this.invalidatedStrictProperties.add(pin.name);
        const detail = `${pin.name}: expected ${violation.expected}, got ${violation.actual}`;
        this.log.warn(`Strict playback property invalidated (${detail})`, error);
        this.record({ detail, type: 'strict-invalidated' });
    }

    private recordStrictObservationFailure(pin: StrictPropertyPin, error: unknown): void {
        if (this.invalidatedStrictProperties.has(pin.name)) {
            return;
        }
        this.invalidatedStrictProperties.add(pin.name);
        const detail = `${pin.name}: observation unavailable`;
        this.log.warn(`Strict playback property invalidated (${detail})`, error);
        this.record({ detail, type: 'strict-invalidated' });
    }

    private requestStrictRepair(pin: StrictPropertyPin): void {
        if (this.repairingStrictProperties.has(pin.name)) {
            return;
        }
        this.repairingStrictProperties.add(pin.name);
        this.strictRepairAttempts.set(pin.name, (this.strictRepairAttempts.get(pin.name) ?? 0) + 1);
        const repair = this.repairStrictProperty;
        let repairResult: Promise<void>;
        try {
            repairResult = repair
                ? repair(pin)
                : Promise.reject(new Error('no command owner available'));
        } catch (error) {
            repairResult = Promise.reject(error);
        }
        const timeoutResult = new Promise<void>((_resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('strict property repair timed out'));
            }, STRICT_REPAIR_COMMAND_TIMEOUT_MS);
            this.strictRepairTimers.set(pin.name, timer);
        });
        void Promise.race([repairResult, timeoutResult])
            .then(() => {
                const commandTimer = this.strictRepairTimers.get(pin.name);
                if (commandTimer) {
                    clearTimeout(commandTimer);
                    this.strictRepairTimers.delete(pin.name);
                }
                if (this.stopped || !this.repairingStrictProperties.has(pin.name)) {
                    return;
                }
                const timer = setTimeout(() => {
                    this.strictRepairTimers.delete(pin.name);
                    this.repairingStrictProperties.delete(pin.name);
                    if (this.stopped) {
                        return;
                    }
                    const violation = this.state.strictPropertyViolations.find(
                        (candidate) => candidate.property === pin.name,
                    );
                    if (!violation) {
                        this.strictRepairAttempts.delete(pin.name);
                        return;
                    }
                    if (
                        (this.strictRepairAttempts.get(pin.name) ?? 0) < STRICT_REPAIR_MAX_ATTEMPTS
                    ) {
                        this.requestStrictRepair(pin);
                        return;
                    }
                    this.recordStrictInvalidation(pin, violation);
                }, STRICT_REPAIR_CONFIRMATION_MS);
                this.strictRepairTimers.set(pin.name, timer);
            })
            .catch((error) => {
                const timer = this.strictRepairTimers.get(pin.name);
                if (timer) {
                    clearTimeout(timer);
                    this.strictRepairTimers.delete(pin.name);
                }
                this.repairingStrictProperties.delete(pin.name);
                if (this.stopped) {
                    return;
                }
                const violation = this.state.strictPropertyViolations.find(
                    (candidate) => candidate.property === pin.name,
                );
                if (violation) {
                    this.recordStrictInvalidation(pin, violation, error);
                } else {
                    this.strictRepairAttempts.delete(pin.name);
                }
            });
    }

    private revalidateStrictProperty(name: string, value: unknown): void {
        const pin = this.strictPropertyPins.get(name);
        if (!pin) {
            return;
        }
        const violation = findStrictPropertyViolation(pin, value);
        const existingIndex = this.state.strictPropertyViolations.findIndex(
            (candidate) => candidate.property === pin.name,
        );
        if (!violation) {
            if (existingIndex >= 0) {
                this.state.strictPropertyViolations.splice(existingIndex, 1);
                this.scheduleBroadcast();
            }
            this.invalidatedStrictProperties.delete(pin.name);
            if (!this.repairingStrictProperties.has(pin.name)) {
                this.strictRepairAttempts.delete(pin.name);
            }
            return;
        }

        const changed =
            existingIndex < 0 ||
            this.state.strictPropertyViolations[existingIndex].actual !== violation.actual;
        if (existingIndex >= 0) {
            this.state.strictPropertyViolations[existingIndex] = violation;
        } else {
            this.state.strictPropertyViolations.push(violation);
        }
        if (changed) {
            // A transient drift must reach the integrity reducer even when repair
            // completes inside the normal 100 ms coalescing window.
            this.emitSnapshot();
        }

        this.requestStrictRepair(pin);
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

function readDemuxerObservation(value: unknown): DemuxerObservation | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const audioTracks = value.filter(
        (track): track is Record<string, unknown> => isRecord(track) && track['type'] === 'audio',
    );
    if (audioTracks.length === 0) {
        return null;
    }
    const selected = audioTracks.find((track) => track['selected'] === true) ?? audioTracks[0];
    return {
        channels:
            typeof selected['demux-channel-count'] === 'number'
                ? selected['demux-channel-count']
                : null,
        codec: typeof selected['codec'] === 'string' ? selected['codec'] : null,
        samplerate:
            typeof selected['demux-samplerate'] === 'number' ? selected['demux-samplerate'] : null,
    };
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
