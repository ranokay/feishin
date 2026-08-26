import { describe, expect, it } from 'vitest';

import type { AudioEngineEvent } from '../src/shared/signalpath/snapshot';
import type { AudioEngineEventType } from '../src/shared/signalpath/snapshot';

import {
    audioEventCategory,
    audioEventSeverity,
    filterAudioEvents,
} from '../src/shared/signalpath/event-log';

let nextId = 1;

const event = (type: AudioEngineEventType, detail?: string): AudioEngineEvent => ({
    detail: detail ?? null,
    id: nextId++,
    time: 1_700_000_000_000,
    type,
});

describe('audio event taxonomy', () => {
    it('classifies every engine event type into a category', () => {
        expect(audioEventCategory('server-route-resolved')).toBe('server');
        expect(audioEventCategory('transcode-detected')).toBe('server');
        expect(audioEventCategory('connection-lost')).toBe('connection');
        expect(audioEventCategory('track-started')).toBe('lifecycle');
        expect(audioEventCategory('track-ended')).toBe('lifecycle');
        expect(audioEventCategory('playlist-advanced')).toBe('lifecycle');
        expect(audioEventCategory('device-opened')).toBe('device');
        expect(audioEventCategory('rate-changed')).toBe('device');
        expect(audioEventCategory('filters-changed')).toBe('filters');
        expect(audioEventCategory('format-changed')).toBe('decoder');
        expect(audioEventCategory('exclusive-failed')).toBe('output');
    });

    it('assigns severities so degradations are never quieter than info', () => {
        expect(audioEventSeverity('transcode-detected')).toBe('warning');
        expect(audioEventSeverity('exclusive-failed')).toBe('error');
        expect(audioEventSeverity('connection-lost')).toBe('error');
        expect(audioEventSeverity('device-lost')).toBe('warning');
        expect(audioEventSeverity('server-route-resolved')).toBe('info');
        expect(audioEventSeverity('playlist-advanced')).toBe('debug');
    });
});

describe('filterAudioEvents', () => {
    const events = [
        event('track-started'),
        event('transcode-detected', 'mime mismatch'),
        event('exclusive-attempted'),
        event('exclusive-failed', 'hog mode denied'),
    ];

    it('returns everything unchanged for an empty filter', () => {
        expect(filterAudioEvents(events, {})).toHaveLength(4);
        expect(filterAudioEvents(events, { category: 'all', severity: 'all' })).toHaveLength(4);
    });

    it('filters by category', () => {
        const filtered = filterAudioEvents(events, { category: 'server' });
        expect(filtered.map((item) => item.type)).toEqual(['transcode-detected']);
    });

    it('filters by severity', () => {
        const filtered = filterAudioEvents(events, { severity: 'error' });
        expect(filtered.map((item) => item.type)).toEqual(['exclusive-failed']);
    });

    it('combines category and severity', () => {
        const filtered = filterAudioEvents(events, { category: 'output', severity: 'debug' });
        expect(filtered.map((item) => item.type)).toEqual(['exclusive-attempted']);
    });

    it('preserves the log order it was given', () => {
        const filtered = filterAudioEvents(events, {});
        expect(filtered.map((item) => item.id)).toEqual(events.map((item) => item.id));
    });
});
