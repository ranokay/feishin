import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AudioSnapshot } from '../src/shared/signalpath';

import { AudioStateService } from '../src/main/features/core/player/mpv/audio-state';
import { MpvIpcConnection } from '../src/main/features/core/player/mpv/ipc-client';
import { writeWavFixture } from './fixtures/audio-fixtures';
import { MpvTestProcess } from './harness/mpv-test-process';

const mpvAvailable = await MpvTestProcess.isAvailable();

const mpv = new MpvTestProcess({
    args: ['--ao=null', '--msg-level=all=info'],
});

let connection: MpvIpcConnection;
let service: AudioStateService;
let snapshots: AudioSnapshot[] = [];

const fixturesDir = await (await import('./fixtures/audio-fixtures')).createFixtureDirectory();

const writeSineWav = async (sampleRate: number) =>
    writeWavFixture(fixturesDir, {
        bitDepth: 16,
        channels: 2,
        durationSec: 3,
        frequencyHz: 1000,
        kind: 'sine',
        sampleRate,
    });

const waitForSnapshot = async (
    predicate: (snapshot: AudioSnapshot) => boolean,
    timeoutMs = 8000,
): Promise<AudioSnapshot> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise<AudioSnapshot>((resolve, reject) => {
        const timer = setInterval(() => {
            const match = [...snapshots].reverse().find(predicate);
            if (match) {
                clearInterval(timer);
                resolve(match);
            } else if (Date.now() > deadline) {
                clearInterval(timer);
                reject(new Error(`timed out waiting for snapshot; received ${snapshots.length}`));
            }
        }, 10);
    });
};

beforeAll(async () => {
    if (!mpvAvailable) {
        return;
    }
    await mpv.start();
    connection = await MpvIpcConnection.connect(mpv.socketPath);
    service = new AudioStateService(connection, {
        broadcast: (snapshot) => snapshots.push(snapshot),
        intervalMs: 100,
    });
    await service.start();
});

afterAll(async () => {
    service?.dispose();
    connection?.dispose();
    if (mpvAvailable) {
        await mpv.dispose();
    }
});

describe.skipIf(!mpvAvailable)('AudioStateService over real mpv playback', () => {
    it('observes initial properties on a live idle instance', async () => {
        // Initial observations arrive asynchronously over IPC; on a loaded CI
        // runner they can land after the first broadcasts, so wait for them.
        const snapshot = await waitForSnapshot(
            (candidate) => candidate.volume !== null && candidate.speed !== null,
        );

        expect(snapshot.volume).toBe(100);
        expect(snapshot.speed).toBe(1);
        expect(snapshot.gaplessAudio).toBe('weak');
        expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    });

    it('delivers decoded-param snapshots within the coalescing window during playback', async () => {
        const startedAt = Date.now();
        await mpv.request(['loadfile', await writeSineWav(44100)]);

        const confirmed = await waitForSnapshot(
            (candidate) =>
                candidate.decodedParams?.samplerate === 44100 &&
                candidate.outputParams?.samplerate === 44100 &&
                candidate.aoDriver !== null,
        );

        expect(confirmed.sequence).toBeGreaterThan(0);
        expect(confirmed.timestamp - startedAt).toBeLessThan(2000);
    });

    it('propagates a property change to a broadcast quickly during real playback', async () => {
        const startedAt = Date.now();
        await mpv.setProperty('volume', 77);
        const updated = await waitForSnapshot((candidate) => candidate.volume === 77);
        const elapsedMs = updated.timestamp - startedAt;

        expect(elapsedMs).toBeGreaterThanOrEqual(0);
        expect(elapsedMs).toBeLessThan(350);
    });

    it('keeps evidence honest on a null device', async () => {
        const snapshot = await waitForSnapshot(
            (candidate) => candidate.decodedParams?.samplerate === 44100,
        );

        expect(snapshot.physicalFormat).toBeNull();
        expect(snapshot.activeFilters).toEqual([]);
    });

    it('derives demuxer source facts from the live track-list property', async () => {
        const snapshot = await waitForSnapshot(
            (candidate) =>
                candidate.demuxer?.codec !== undefined && candidate.demuxer.codec !== null,
        );

        expect(snapshot.demuxer?.samplerate).toBeGreaterThan(0);
        expect(snapshot.demuxer?.channels).toBe(2);
    });

    it('captures a rate-change transition with clean events and no stale mixes', async () => {
        snapshots = [];
        await mpv.request(['loadfile', await writeSineWav(96000), 'replace']);

        const final = await waitForSnapshot(
            (candidate) =>
                candidate.decodedParams?.samplerate === 96000 &&
                candidate.outputParams?.samplerate === 96000,
            12000,
        );

        expect(final.activeFilters).toEqual([]);

        const events = service.getEvents();
        expect(events.some((event) => event.type === 'track-started')).toBe(true);
        const rateChangedDetails = events
            .filter((event) => event.type === 'rate-changed')
            .map((event) => event.detail ?? '');
        expect(
            rateChangedDetails.some(
                (detail) => detail.includes('44100') && detail.includes('96000'),
            ),
        ).toBe(true);

        for (const snapshot of snapshots) {
            if (
                snapshot.decodedParams?.samplerate != null &&
                snapshot.outputParams?.samplerate != null
            ) {
                expect(snapshot.outputParams.samplerate).toBe(snapshot.decodedParams.samplerate);
            }
        }

        const sequences = snapshots.map((snapshot) => snapshot.sequence);
        for (let index = 1; index < sequences.length; index += 1) {
            expect(sequences[index]).toBeGreaterThan(sequences[index - 1]);
        }
    });

    it('returns an ordered queryable event log capped below the limit', () => {
        const events = service.getEvents();

        expect(events.length).toBeGreaterThan(0);
        expect(events.length).toBeLessThanOrEqual(500);
        for (let index = 1; index < events.length; index += 1) {
            expect(events[index].id).toBeGreaterThan(events[index - 1].id);
        }
    });

    it('stops cleanly on dispose without affecting other IPC clients', async () => {
        service.dispose();
        expect(service.getEvents()).toHaveLength(0);

        const version = await mpv.getProperty('mpv-version');
        expect(String(version)).toMatch(/^mpv/);
    });
});
