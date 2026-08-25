import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MpvEventHandler } from '../src/main/features/core/player/mpv/ipc-client';

import {
    applyPropertyValue,
    type AudioStateConnection,
    AudioStateService,
    createObservedAudioState,
    deriveSnapshot,
    OBSERVED_AUDIO_PROPERTIES,
    parseAoLogEvent,
} from '../src/main/features/core/player/mpv/audio-state';

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
            'current-ao',
            'demuxer-cache-state',
            'gapless-audio',
            'mute',
            'playlist-pos',
            'speed',
            'volume',
        ]);
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
});
