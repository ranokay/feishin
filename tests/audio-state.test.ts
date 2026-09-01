import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MpvEventHandler } from '../src/main/features/core/player/mpv/ipc-client';
import type { StreamHeaderProbe } from '../src/shared/signalpath';

import {
    applyPropertyValue,
    type AudioStateConnection,
    AudioStateService,
    createObservedAudioState,
    deriveSnapshot,
    OBSERVED_AUDIO_PROPERTIES,
    parseAoLogEvent,
} from '../src/main/features/core/player/mpv/audio-state';
import {
    BIT_PERFECT_PROPERTY_PINS,
    isMpvPlaybackKeyQueued,
    resolveMpvPlaybackKey,
} from '../src/shared/signalpath';

interface StubConnection extends AudioStateConnection {
    emit(eventName: string, payload: Record<string, unknown>): void;
}

const createStubConnection = (): StubConnection => {
    const handlers = new Map<string, Set<MpvEventHandler>>();
    return {
        dispose: vi.fn(),
        emit(eventName, payload) {
            for (const handler of handlers.get(eventName) ?? []) {
                handler({ event: eventName, ...payload });
            }
        },
        enableLogMessages: vi.fn(async () => {}),
        observe: vi.fn(async () => {}),
        onClose: vi.fn(() => () => {}),
        onEvent(eventName, handler) {
            const set = handlers.get(eventName) ?? new Set();
            set.add(handler);
            handlers.set(eventName, set);
            return () => {
                set.delete(handler);
            };
        },
    };
};

describe('observed audio property set', () => {
    it('covers the fixed observation contract', () => {
        expect(OBSERVED_AUDIO_PROPERTIES).toEqual([
            'af',
            'audio-device',
            'audio-out-params',
            'audio-params',
            'audio-samplerate',
            'current-ao',
            'demuxer-cache-state',
            'gapless-audio',
            'mute',
            'playlist',
            'playlist-pos',
            'replaygain',
            'speed',
            'track-list',
            'volume',
        ]);
    });
});

describe('resolveMpvPlaybackKey', () => {
    it('preserves the identity of local radio sources', () => {
        const sources = [
            { kind: 'radio' as const, playbackKey: 'radio-1', url: 'https://radio/stream' },
        ];

        expect(resolveMpvPlaybackKey(sources, 'https://radio/stream', 0)).toBe('radio-1');
        expect(isMpvPlaybackKeyQueued(sources, 'radio-1')).toBe(true);
        expect(isMpvPlaybackKeyQueued(sources, 'old-library-song')).toBe(false);
    });
});

describe('applyPropertyValue', () => {
    it('detects device opened and lost from current-ao transitions', () => {
        const state = createObservedAudioState();

        expect(applyPropertyValue(state, 'current-ao', null)).toEqual([]);
        expect(applyPropertyValue(state, 'current-ao', 'coreaudio')).toEqual([
            { detail: 'coreaudio', type: 'device-opened' },
        ]);
        expect(applyPropertyValue(state, 'current-ao', 'wasapi')).toEqual([
            { detail: 'coreaudio -> wasapi', type: 'device-opened' },
        ]);
        expect(applyPropertyValue(state, 'current-ao', null)).toEqual([
            { detail: 'wasapi', type: 'device-lost' },
        ]);
        expect(state.aoDriver).toBeNull();
    });

    it('clears physical-format evidence when the device is lost', () => {
        const state = createObservedAudioState();
        applyPropertyValue(state, 'current-ao', 'coreaudio');
        state.physicalFormat = { level: 'inferred', source: 'mpv-log', value: '44100 Hz' };

        applyPropertyValue(state, 'current-ao', null);

        expect(state.physicalFormat).toBeNull();
    });

    it('emits rate and format changes for decoded params', () => {
        const state = createObservedAudioState();

        expect(
            applyPropertyValue(state, 'audio-params', {
                channels: 2,
                format: 's16',
                samplerate: 44100,
            }),
        ).toEqual([]);
        expect(
            applyPropertyValue(state, 'audio-params', {
                channels: 2,
                format: 's16',
                samplerate: 96000,
            }),
        ).toEqual([{ detail: 'decoded rate 44100 -> 96000', type: 'rate-changed' }]);
        expect(
            applyPropertyValue(state, 'audio-params', {
                channels: 2,
                format: 'float',
                samplerate: 96000,
            }),
        ).toEqual([{ detail: 'decoded format s16/2ch -> float/2ch', type: 'format-changed' }]);
        expect(applyPropertyValue(state, 'audio-params', null)).toEqual([
            { detail: 'decoded params unavailable', type: 'ao-transition' },
        ]);
        expect(state.decodedParams).toBeNull();
    });

    it('emits rate changes for output params with the output stage label', () => {
        const state = createObservedAudioState();

        applyPropertyValue(state, 'audio-out-params', {
            channels: 2,
            format: 's32',
            samplerate: 44100,
        });
        expect(
            applyPropertyValue(state, 'audio-out-params', {
                channels: 2,
                format: 's32',
                samplerate: 48000,
            }),
        ).toEqual([{ detail: 'output rate 44100 -> 48000', type: 'rate-changed' }]);
    });

    it('reports filter changes by filter name list', () => {
        const state = createObservedAudioState();

        expect(applyPropertyValue(state, 'af', [])).toEqual([]);
        expect(
            applyPropertyValue(state, 'af', [
                { label: '', name: 'lavfi', params: { graph: 'equalizer=f=60' } },
                { name: 'volume' },
            ]),
        ).toEqual([{ detail: 'lavfi,volume', type: 'filters-changed' }]);
        expect(state.activeFilters).toEqual(['lavfi', 'volume']);
    });

    it('tracks scalar properties without transition events on first sight', () => {
        const state = createObservedAudioState();

        expect(applyPropertyValue(state, 'volume', 30)).toEqual([]);
        expect(applyPropertyValue(state, 'mute', false)).toEqual([]);
        expect(applyPropertyValue(state, 'speed', 1)).toEqual([]);
        expect(applyPropertyValue(state, 'playlist-pos', 0)).toEqual([]);
        expect(applyPropertyValue(state, 'gapless-audio', 'weak')).toEqual([]);
        expect(applyPropertyValue(state, 'audio-device', 'auto')).toEqual([]);

        expect(state.volume).toBe(30);
        expect(state.muted).toBe(false);
        expect(state.speed).toBe(1);
        expect(state.playlistPos).toBe(0);
    });

    it('emits gapless and device selection changes after first sight', () => {
        const state = createObservedAudioState();
        applyPropertyValue(state, 'gapless-audio', 'weak');
        applyPropertyValue(state, 'audio-device', 'auto');

        expect(applyPropertyValue(state, 'gapless-audio', 'yes')).toEqual([
            { detail: 'weak -> yes', type: 'gapless-changed' },
        ]);
        expect(applyPropertyValue(state, 'audio-device', 'coreaudio/USB DAC')).toEqual([
            { detail: 'coreaudio/USB DAC', type: 'device-selected' },
        ]);
    });

    it('extracts only cache health booleans from demuxer-cache-state', () => {
        const state = createObservedAudioState();

        applyPropertyValue(state, 'demuxer-cache-state', {
            'cache-duration': 12.5,
            'eof-reaching': false,
            idle: false,
            underrun: true,
        });

        expect(state.cacheUnderrun).toBe(true);
        expect(state.cacheIdle).toBe(false);
        expect(state.cacheEofReaching).toBe(false);
    });

    it('reads the numeric channel count from the channel-count field', () => {
        const state = createObservedAudioState();

        applyPropertyValue(state, 'audio-params', {
            'channel-count': 2,
            channels: 'stereo',
            format: 'float',
            samplerate: 96000,
        });

        expect(state.decodedParams).toEqual({ channels: 2, format: 'float', samplerate: 96000 });
    });

    it('extracts demuxer source facts from the selected audio track-list entry', () => {
        const state = createObservedAudioState();

        applyPropertyValue(state, 'track-list', [
            { id: 0, type: 'video' },
            {
                codec: 'flac',
                'demux-channel-count': 2,
                'demux-samplerate': 44100,
                id: 1,
                selected: true,
                type: 'audio',
            },
        ]);

        expect(state.demuxer).toEqual({ channels: 2, codec: 'flac', samplerate: 44100 });
    });

    it('clears stale demuxer facts when the track list has no audio entries', () => {
        const state = createObservedAudioState();
        state.demuxer = { channels: 2, codec: 'flac', samplerate: 44100 };

        applyPropertyValue(state, 'track-list', []);

        expect(state.demuxer).toBeNull();
    });
});

describe('deriveSnapshot', () => {
    it('produces an immutable JSON-safe snapshot with sequence and timestamp', () => {
        const state = createObservedAudioState();
        applyPropertyValue(state, 'current-ao', 'coreaudio');
        applyPropertyValue(state, 'audio-params', {
            channels: 2,
            format: 's16',
            samplerate: 44100,
        });
        applyPropertyValue(state, 'volume', 100);
        state.physicalFormat = { level: 'inferred', source: 'mpv-log', value: '44100 Hz 2ch' };

        const snapshot = deriveSnapshot(state, 7);

        expect(snapshot.sequence).toBe(7);
        expect(snapshot.aoDriver).toBe('coreaudio');
        expect(snapshot.decodedParams).toEqual({ channels: 2, format: 's16', samplerate: 44100 });
        expect(snapshot.volume).toBe(100);
        expect(snapshot.muted).toBeNull();
        expect(snapshot.physicalFormat).toEqual({
            level: 'inferred',
            source: 'mpv-log',
            value: '44100 Hz 2ch',
        });
        expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    });

    it('keeps unavailable fields null instead of stale during AO transitions', () => {
        const state = createObservedAudioState();
        applyPropertyValue(state, 'audio-params', {
            channels: 2,
            format: 's16',
            samplerate: 44100,
        });
        applyPropertyValue(state, 'audio-out-params', {
            channels: 2,
            format: 's32',
            samplerate: 44100,
        });
        applyPropertyValue(state, 'audio-params', null);
        applyPropertyValue(state, 'audio-out-params', null);

        const snapshot = deriveSnapshot(state, 1);

        expect(snapshot.decodedParams).toBeNull();
        expect(snapshot.outputParams).toBeNull();
    });
});

describe('parseAoLogEvent', () => {
    it('classifies macOS physical-format evidence as inferred tier input', () => {
        expect(
            parseAoLogEvent(
                'ao/coreaudio_exclusive',
                'Selected physical format: 96000 Hz float32 2ch',
            ),
        ).toEqual({
            detail: 'Selected physical format: 96000 Hz float32 2ch',
            type: 'physical-format',
        });
    });

    it('classifies exclusive hogmode contention failure', () => {
        expect(
            parseAoLogEvent(
                'ao/coreaudio_exclusive',
                'Failed to set hogmode: device is held by another process',
            ),
        ).toEqual({
            detail: 'Failed to set hogmode: device is held by another process',
            type: 'exclusive-failed',
        });
    });

    it('classifies exclusive acquisition attempts', () => {
        expect(
            parseAoLogEvent(
                'ao/coreaudio_exclusive',
                'Trying exclusive mode with physical format list',
            ),
        ).toEqual({
            detail: 'Trying exclusive mode with physical format list',
            type: 'exclusive-attempted',
        });
    });

    it('ignores non-ao prefixes and unmatched ao lines', () => {
        expect(parseAoLogEvent('cplayer', 'physical format somewhere')).toBeNull();
        expect(parseAoLogEvent('ao/null', 'Untimed mode activated')).toBeNull();
    });
});

describe('AudioStateService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('observes every fixed property and enables verbose log messages', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection);

        await service.start();

        expect(connection.observe).toHaveBeenCalledTimes(OBSERVED_AUDIO_PROPERTIES.length);
        expect(connection.enableLogMessages).toHaveBeenCalledWith('v');
        service.dispose();
        expect(connection.dispose).toHaveBeenCalled();
    });

    it('derives an initial snapshot from immediate current-value observations', async () => {
        const connection = createStubConnection();
        const snapshots: unknown[] = [];
        const service = new AudioStateService(connection, {
            broadcast: (snapshot) => snapshots.push(snapshot),
        });

        await service.start();
        connection.emit('property-change', { data: 45, event: 'property-change', name: 'volume' });
        await vi.advanceTimersByTimeAsync(150);

        expect(snapshots).toHaveLength(1);
        expect((snapshots[0] as { volume: null | number }).volume).toBe(45);
        service.dispose();
    });

    it('coalesces rapid property changes into a single broadcast within the interval', async () => {
        const connection = createStubConnection();
        const broadcast = vi.fn();
        const service = new AudioStateService(connection, { broadcast, intervalMs: 100 });

        await service.start();
        for (const volume of [10, 20, 30, 40]) {
            connection.emit('property-change', {
                data: volume,
                event: 'property-change',
                name: 'volume',
            });
        }
        await vi.advanceTimersByTimeAsync(99);
        expect(broadcast).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(broadcast).toHaveBeenCalledTimes(1);
        expect((broadcast.mock.calls[0][0] as { volume: null | number }).volume).toBe(40);
        service.dispose();
    });

    it('skips broadcasts when nothing changed between windows', async () => {
        const connection = createStubConnection();
        const broadcast = vi.fn();
        const service = new AudioStateService(connection, { broadcast, intervalMs: 20 });

        await service.start();
        connection.emit('property-change', { data: 50, event: 'property-change', name: 'volume' });
        await vi.advanceTimersByTimeAsync(25);
        await vi.advanceTimersByTimeAsync(25);

        expect(broadcast).toHaveBeenCalledTimes(1);
        service.dispose();
    });

    it('caps the event log ring at the configured limit keeping newest entries', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, { eventLimit: 5 });

        await service.start();
        for (let pos = 0; pos <= 8; pos += 1) {
            connection.emit('property-change', {
                data: pos,
                event: 'property-change',
                name: 'playlist-pos',
            });
        }

        const events = service.getEvents();
        expect(events).toHaveLength(5);
        expect(events.map((event) => event.type)).toEqual([
            'playlist-advanced',
            'playlist-advanced',
            'playlist-advanced',
            'playlist-advanced',
            'playlist-advanced',
        ]);
        expect(events[events.length - 1].detail).toContain('7 -> 8');
        expect(events[0].id).toBeLessThan(events[events.length - 1].id);
        service.dispose();
    });

    it('records track lifecycle and audio-reconfig events from mpv events', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection);

        await service.start();
        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 1 });
        connection.emit('audio-reconfig', { event: 'audio-reconfig' });
        connection.emit('end-file', { event: 'end-file', reason: 'eof' });

        const types = service.getEvents().map((event) => event.type);
        expect(types).toEqual(['track-started', 'ao-transition', 'track-ended']);
        expect(service.getEvents()[2].detail).toBe('eof');
        service.dispose();
    });

    it('clears stale physical-format evidence when the AO renegotiates within a driver', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection);

        await service.start();
        connection.emit('log-message', {
            event: 'log-message',
            prefix: 'ao/coreaudio_exclusive',
            text: 'Selected physical format: 44100 Hz float32 2ch',
        });
        expect(service.getSnapshot().physicalFormat).not.toBeNull();

        connection.emit('audio-reconfig', { event: 'audio-reconfig' });

        expect(service.getSnapshot().physicalFormat).toBeNull();
        service.dispose();
    });

    it('records connection loss, clears stale values, and stops broadcasting', async () => {
        const connection = createStubConnection();
        const closeHandlers: Array<() => void> = [];
        connection.onClose = (handler) => {
            closeHandlers.push(handler);
            return () => {};
        };
        const broadcast = vi.fn();
        const service = new AudioStateService(connection, { broadcast, intervalMs: 10 });

        await service.start();
        connection.emit('property-change', { data: 33, event: 'property-change', name: 'volume' });
        connection.emit('property-change', {
            data: 'coreaudio',
            event: 'property-change',
            name: 'current-ao',
        });
        await vi.advanceTimersByTimeAsync(20);
        for (const fireClose of closeHandlers) {
            fireClose();
        }

        const events = service.getEvents();
        expect(events[events.length - 1].type).toBe('connection-lost');
        expect(broadcast).toHaveBeenCalledTimes(2);

        const finalSnapshot = broadcast.mock.calls[1][0] as { aoDriver: unknown; volume: unknown };
        expect(finalSnapshot.aoDriver).toBeNull();
        expect(finalSnapshot.volume).toBeNull();

        connection.emit('property-change', { data: 11, event: 'property-change', name: 'volume' });
        await vi.advanceTimersByTimeAsync(50);
        expect(broadcast).toHaveBeenCalledTimes(2);
    });

    it('invalidates strict validation when the observation connection is lost', async () => {
        const connection = createStubConnection();
        const closeHandlers: Array<() => void> = [];
        connection.onClose = (handler) => {
            closeHandlers.push(handler);
            return () => {};
        };
        const service = new AudioStateService(connection, {
            repairStrictProperty: async () => {},
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();
        for (const fireClose of closeHandlers) {
            fireClose();
        }

        expect(service.getSnapshot().strictValidationError).toBe(
            'strict property observability lost',
        );
        expect(
            service
                .getEvents()
                .slice(-2)
                .map((event) => event.type),
        ).toEqual(['connection-lost', 'strict-invalidated']);
    });

    it('handles strict connection loss while observers are still starting', async () => {
        const connection = createStubConnection();
        const closeHandlers: Array<() => void> = [];
        connection.onClose = (handler) => {
            closeHandlers.push(handler);
            return () => {};
        };
        connection.observe = vi.fn(async () => {
            for (const fireClose of closeHandlers) {
                fireClose();
            }
            throw new Error('connection closed');
        });
        const service = new AudioStateService(connection, {
            repairStrictProperty: async () => {},
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();

        expect(connection.observe).toHaveBeenCalledTimes(1);
        expect(service.getSnapshot().strictValidationError).toBe(
            'strict property observability lost',
        );
        expect(service.getEvents().at(-1)?.type).toBe('strict-invalidated');
    });

    it('continues observing when individual observe calls fail', async () => {
        const connection = createStubConnection();
        connection.observe = vi.fn(async (id: number) => {
            if (id === 1) {
                throw new Error('unsupported');
            }
        });
        const service = new AudioStateService(connection);

        await service.start();

        expect(connection.observe).toHaveBeenCalledTimes(OBSERVED_AUDIO_PROPERTIES.length);
        service.dispose();
    });

    it('invalidates strict validation when a pinned property cannot be observed', async () => {
        const connection = createStubConnection();
        connection.observe = vi.fn(async (_id: number, propertyName: string) => {
            if (propertyName === 'replaygain') {
                throw new Error('property unavailable');
            }
        });
        const service = new AudioStateService(connection, {
            repairStrictProperty: async () => {},
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();

        expect(service.getSnapshot().strictValidationError).toBe(
            'strict property observation unavailable: replaygain',
        );
        expect(service.getEvents().at(-1)).toMatchObject({
            detail: 'replaygain: observation unavailable',
            type: 'strict-invalidated',
        });
        service.dispose();
    });

    it('reports strict drift immediately and asks the command owner to repair it', async () => {
        const connection = createStubConnection();
        const repairStrictProperty = vi.fn(async () => {});
        const broadcast = vi.fn();
        const service = new AudioStateService(connection, {
            broadcast,
            repairStrictProperty,
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();
        connection.emit('property-change', {
            data: 1.25,
            event: 'property-change',
            name: 'speed',
        });

        expect(service.getSnapshot().strictPropertyViolations).toEqual([
            { actual: '1.25', expected: '1', property: 'speed' },
        ]);
        expect(broadcast).toHaveBeenCalledTimes(1);
        expect(repairStrictProperty).toHaveBeenCalledWith({ name: 'speed', value: 1 });

        connection.emit('property-change', {
            data: 1,
            event: 'property-change',
            name: 'speed',
        });
        expect(service.getSnapshot().strictPropertyViolations).toEqual([]);
        service.dispose();
    });

    it('records strict invalidation when a drift repair fails', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            repairStrictProperty: async () => {
                throw new Error('property is read-only');
            },
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();
        connection.emit('property-change', {
            data: 'yes',
            event: 'property-change',
            name: 'gapless-audio',
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(service.getEvents().at(-1)).toMatchObject({
            detail: 'gapless-audio: expected weak, got yes',
            type: 'strict-invalidated',
        });
        expect(service.getSnapshot().strictPropertyViolations).toHaveLength(1);
        service.dispose();
    });

    it('does not invalidate when correction is observed before a repair rejects', async () => {
        const connection = createStubConnection();
        let rejectRepair: (error: Error) => void = () => {};
        const service = new AudioStateService(connection, {
            repairStrictProperty: () =>
                new Promise<void>((_resolve, reject) => {
                    rejectRepair = reject;
                }),
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();
        connection.emit('property-change', { data: 1.25, name: 'speed' });
        connection.emit('property-change', { data: 1, name: 'speed' });
        rejectRepair(new Error('late command failure'));
        await vi.advanceTimersByTimeAsync(0);

        expect(service.getSnapshot().strictPropertyViolations).toEqual([]);
        expect(service.getEvents().some((event) => event.type === 'strict-invalidated')).toBe(
            false,
        );
        service.dispose();
    });

    it('retries the latest drift observed while a repair is in flight', async () => {
        const connection = createStubConnection();
        let finishFirstRepair: () => void = () => {};
        const repairStrictProperty = vi
            .fn<() => Promise<void>>()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        finishFirstRepair = resolve;
                    }),
            )
            .mockResolvedValue(undefined);
        const service = new AudioStateService(connection, {
            repairStrictProperty,
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();
        connection.emit('property-change', { data: 1.25, name: 'speed' });
        connection.emit('property-change', { data: 1.5, name: 'speed' });
        finishFirstRepair();
        await vi.advanceTimersByTimeAsync(100);

        expect(repairStrictProperty).toHaveBeenCalledTimes(2);
        expect(service.getSnapshot().strictPropertyViolations).toEqual([
            { actual: '1.5', expected: '1', property: 'speed' },
        ]);

        connection.emit('property-change', { data: 1, name: 'speed' });
        await vi.advanceTimersByTimeAsync(100);
        expect(service.getEvents().some((event) => event.type === 'strict-invalidated')).toBe(
            false,
        );
        service.dispose();
    });

    it('invalidates drift that remains after bounded successful repair commands', async () => {
        const connection = createStubConnection();
        const repairStrictProperty = vi.fn(async () => {});
        const service = new AudioStateService(connection, {
            repairStrictProperty,
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();
        connection.emit('property-change', { data: 48000, name: 'audio-samplerate' });
        await vi.advanceTimersByTimeAsync(200);

        expect(repairStrictProperty).toHaveBeenCalledTimes(2);
        expect(service.getEvents().at(-1)).toMatchObject({
            detail: 'audio-samplerate: expected 0, got 48000',
            type: 'strict-invalidated',
        });
        service.dispose();
    });

    it('invalidates a strict repair command that never settles', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            repairStrictProperty: () => new Promise<void>(() => {}),
            strictPropertyPins: BIT_PERFECT_PROPERTY_PINS,
        });

        await service.start();
        connection.emit('property-change', { data: 90, name: 'volume' });
        await vi.advanceTimersByTimeAsync(1000);

        expect(service.getEvents().at(-1)).toMatchObject({
            detail: 'volume: expected 100, got 90',
            type: 'strict-invalidated',
        });
        service.dispose();
    });

    it('does not enforce properties when no strict policy is configured', async () => {
        const connection = createStubConnection();
        const repairStrictProperty = vi.fn(async () => {});
        const service = new AudioStateService(connection, { repairStrictProperty });

        await service.start();
        connection.emit('property-change', {
            data: 1.5,
            event: 'property-change',
            name: 'speed',
        });

        expect(repairStrictProperty).not.toHaveBeenCalled();
        expect(service.getSnapshot().strictPropertyViolations).toEqual([]);
        expect(service.getEvents().some((event) => event.type === 'strict-invalidated')).toBe(
            false,
        );
        service.dispose();
    });
});

describe('AudioStateService server-route verification', () => {
    const FLAC_DECLARATION = {
        bitDepth: 16,
        channels: 2,
        container: 'flac',
        sampleRate: 44100,
        sizeBytes: 30_000_000,
    };
    const RAW_PROBE: StreamHeaderProbe = {
        acceptRanges: 'bytes',
        contentLength: 30_000_000,
        contentType: 'audio/flac',
    };

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const flushMicrotasks = async () => {
        await vi.advanceTimersByTimeAsync(0);
    };

    it('records confirmed direct-stream evidence and an event when the probe matches', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            probeStreamHeaders: async () => RAW_PROBE,
        });
        await service.start();

        service.requestServerVerification({
            declaration: FLAC_DECLARATION,
            url: 'https://x/stream',
        });
        await flushMicrotasks();

        const snapshot = service.getSnapshot();
        expect(snapshot.serverRoute).toMatchObject({
            level: 'confirmed',
            route: 'direct-stream',
            verification: 'size-match',
        });
        expect(service.getEvents().at(-1)?.type).toBe('server-route-resolved');
        service.dispose();
    });

    it('raises a transcode-detected event when the route contradicts the library', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            probeStreamHeaders: async () => ({
                acceptRanges: null,
                contentLength: null,
                contentType: 'audio/mpeg',
            }),
        });
        await service.start();

        service.requestServerVerification({
            declaration: FLAC_DECLARATION,
            url: 'https://x/stream',
        });
        await flushMicrotasks();

        const snapshot = service.getSnapshot();
        expect(snapshot.serverRoute?.route).toBe('transcoded');
        const lastEvent = service.getEvents().at(-1);
        expect(lastEvent?.type).toBe('transcode-detected');
        expect(lastEvent?.detail).toContain('audio/mpeg');
        service.dispose();
    });

    it('finalizes immediately on headers, then re-checks when demuxer facts arrive', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            probeStreamHeaders: async () => RAW_PROBE,
        });
        await service.start();

        service.requestServerVerification({
            declaration: FLAC_DECLARATION,
            url: 'https://x/stream',
        });
        await flushMicrotasks();
        // Headers alone already produce a verdict without waiting for mpv.
        expect(service.getSnapshot().serverRoute?.verification).toBe('size-match');

        connection.emit('property-change', {
            data: [
                {
                    codec: 'opus',
                    'demux-channel-count': 2,
                    'demux-samplerate': 44100,
                    id: 1,
                    type: 'audio',
                },
            ],
            event: 'property-change',
            name: 'track-list',
        });

        // The cached-transcode cross-check flips the verdict once demuxer facts land.
        const snapshot = service.getSnapshot();
        expect(snapshot.serverRoute?.route).toBe('transcoded');
        const types = service.getEvents().map((event) => event.type);
        expect(types).toContain('server-route-resolved');
        expect(types.at(-1)).toBe('transcode-detected');
        service.dispose();
    });

    it('does not re-evaluate twice for repeated track-list updates', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            probeStreamHeaders: async () => RAW_PROBE,
        });
        await service.start();

        service.requestServerVerification({
            declaration: FLAC_DECLARATION,
            url: 'https://x/stream',
        });
        await flushMicrotasks();
        connection.emit('property-change', {
            data: [
                {
                    codec: 'flac',
                    'demux-channel-count': 2,
                    'demux-samplerate': 44100,
                    id: 1,
                    type: 'audio',
                },
            ],
            event: 'property-change',
            name: 'track-list',
        });
        connection.emit('property-change', {
            data: [
                {
                    codec: 'flac',
                    'demux-channel-count': 2,
                    'demux-samplerate': 44100,
                    id: 1,
                    type: 'audio',
                },
            ],
            event: 'property-change',
            name: 'track-list',
        });

        const resolvedEvents = service
            .getEvents()
            .filter((event) => event.type === 'server-route-resolved');
        expect(resolvedEvents).toHaveLength(1);
        service.dispose();
    });

    it('discards a stale in-flight result once a newer request supersedes it', async () => {
        const connection = createStubConnection();
        let resolveFirst: ((probe: null | StreamHeaderProbe) => void) | undefined;
        const service = new AudioStateService(connection, {
            probeStreamHeaders: () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                }),
        });
        await service.start();

        service.requestServerVerification({
            declaration: FLAC_DECLARATION,
            url: 'https://x/first',
        });
        service.requestServerVerification({
            declaration: { ...FLAC_DECLARATION, container: 'mp3' },
            url: 'https://x/second',
        });
        resolveFirst?.(RAW_PROBE);
        await flushMicrotasks();

        // First request is stale; its raw-flac verdict must not land. The mp3
        // source cannot be verified by those headers either, so nothing records.
        expect(service.getSnapshot().serverRoute ?? null).toBeNull();
        service.dispose();
    });

    it('discards an in-flight result after playback advances to another track', async () => {
        const connection = createStubConnection();
        let resolveProbe: ((probe: null | StreamHeaderProbe) => void) | undefined;
        const service = new AudioStateService(connection, {
            probeStreamHeaders: () =>
                new Promise((resolve) => {
                    resolveProbe = resolve;
                }),
            resolvePlaybackKey: (_path, position) => ['song-1', 'song-2'][position] ?? null,
        });
        await service.start();
        connection.emit('property-change', {
            data: [
                { filename: 'https://x/first', id: 10 },
                { filename: 'https://x/second', id: 11 },
            ],
            event: 'property-change',
            name: 'playlist',
        });
        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 10 });

        service.requestServerVerification(
            { declaration: FLAC_DECLARATION, url: 'https://x/first' },
            'song-1',
        );
        await flushMicrotasks();
        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 11 });
        resolveProbe?.({
            acceptRanges: null,
            contentLength: null,
            contentType: 'audio/mpeg',
        });
        await flushMicrotasks();

        expect(service.getSnapshot()).toMatchObject({
            playbackKey: 'song-2',
            serverRoute: null,
            streamUrl: null,
        });
        expect(service.getEvents().some((event) => event.type === 'transcode-detected')).toBe(
            false,
        );
        service.dispose();
    });

    it('applies an early probe result once its track starts', async () => {
        const connection = createStubConnection();
        let resolveProbe: ((probe: null | StreamHeaderProbe) => void) | undefined;
        const service = new AudioStateService(connection, {
            probeStreamHeaders: () =>
                new Promise((resolve) => {
                    resolveProbe = resolve;
                }),
            resolvePlaybackKey: (_path, position) => ['song-1', 'song-2'][position] ?? null,
        });
        await service.start();
        connection.emit('property-change', {
            data: [
                { filename: 'https://x/first', id: 10 },
                { filename: 'https://x/second', id: 11 },
            ],
            event: 'property-change',
            name: 'playlist',
        });
        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 10 });

        service.requestServerVerification(
            { declaration: FLAC_DECLARATION, url: 'https://x/second' },
            'song-2',
        );
        await flushMicrotasks();
        resolveProbe?.({
            acceptRanges: null,
            contentLength: null,
            contentType: 'audio/mpeg',
        });
        await flushMicrotasks();
        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 11 });

        expect(service.getSnapshot()).toMatchObject({
            playbackKey: 'song-2',
            serverRoute: expect.objectContaining({ route: 'transcoded' }),
        });
        service.dispose();
    });

    it('degrades to unverified absence when the probe fails', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            probeStreamHeaders: async () => null,
        });
        await service.start();

        service.requestServerVerification({
            declaration: FLAC_DECLARATION,
            url: 'https://x/stream',
        });
        await flushMicrotasks();

        expect(service.getSnapshot().serverRoute ?? null).toBeNull();
        expect(service.getEvents()).toHaveLength(0);
        service.dispose();
    });

    it('clears stale evidence when a new track starts and nothing else is pending', async () => {
        const connection = createStubConnection();
        const service = new AudioStateService(connection, {
            probeStreamHeaders: async () => RAW_PROBE,
        });
        await service.start();

        service.requestServerVerification({
            declaration: FLAC_DECLARATION,
            url: 'https://x/stream',
        });
        await flushMicrotasks();
        expect(service.getSnapshot().serverRoute?.route).toBe('direct-stream');

        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 2 });
        expect(service.getSnapshot().serverRoute ?? null).toBeNull();
        service.dispose();
    });

    it('classifies hog-mode contention into a typed error and notifies', async () => {
        const connection = createStubConnection();
        const broadcast = vi.fn();
        const onEngineError = vi.fn();
        const service = new AudioStateService(connection, {
            broadcast,
            onEngineError,
            resolvePlaybackKey: (_path, position) => ['song-1', 'song-2'][position] ?? null,
        });
        await service.start();

        connection.emit('property-change', {
            data: [
                { filename: 'https://x/first', id: 10 },
                { filename: 'https://x/second', id: 11 },
            ],
            event: 'property-change',
            name: 'playlist',
        });
        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 10 });
        connection.emit('log-message', {
            event: 'log-message',
            prefix: 'ao/coreaudio',
            text: 'failed to set hogmode: -536870196',
        });

        const snapshot = service.getSnapshot();
        expect(snapshot.lastError?.cause).toBe('exclusive-contention');
        expect(snapshot.lastError?.standardWouldHelp).toBe(true);
        const errorEvent = service.getEvents().find((event) => event.type === 'engine-error');
        expect(errorEvent?.detail).toContain('exclusive-contention');
        expect(onEngineError).toHaveBeenCalledWith(
            expect.objectContaining({ cause: 'exclusive-contention' }),
            'song-1',
        );
        expect(broadcast).toHaveBeenCalledWith(
            expect.objectContaining({
                lastError: expect.objectContaining({ cause: 'exclusive-contention' }),
                playbackKey: 'song-1',
            }),
        );

        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 11 });
        expect(service.getSnapshot().playbackKey).toBe('song-2');
        service.dispose();
    });

    it('records an unknown-cause typed error when playback ends with an error', async () => {
        const connection = createStubConnection();
        const onEngineError = vi.fn();
        const service = new AudioStateService(connection, { onEngineError });
        await service.start();

        connection.emit('end-file', { event: 'end-file', reason: 'error' });

        expect(service.getSnapshot().lastError?.cause).toBe('unknown');
        expect(onEngineError).toHaveBeenCalledTimes(1);

        // A fresh track start clears the stale failure.
        connection.emit('start-file', { event: 'start-file', playlist_entry_id: 2 });
        expect(service.getSnapshot().lastError ?? null).toBeNull();
        service.dispose();
    });

    it('types generic AO-init failures even without exclusive keywords', async () => {
        const connection = createStubConnection();
        const onEngineError = vi.fn();
        const service = new AudioStateService(connection, { onEngineError });
        await service.start();

        connection.emit('log-message', {
            event: 'log-message',
            prefix: 'ao/coreaudio',
            text: 'failed to initialize AO: sample rate 176400 not supported by device',
        });

        expect(service.getSnapshot().lastError?.cause).toBe('unsupported-rate');
        service.dispose();
    });
});
