import { stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import type { AudioSnapshot } from '../src/shared/signalpath';
import type { DecodedParams } from '../src/shared/signalpath/formats';

import { buildSignalPathModel, declareSource, evaluateServerRoute } from '../src/shared/signalpath';
import {
    createFixtureDirectory,
    type DsfFixtureSpec,
    writeDsfFixture,
} from './fixtures/audio-fixtures';
import { MpvTestProcess } from './harness/mpv-test-process';

const mpvAvailable = await MpvTestProcess.isAvailable();

const DSD64: DsfFixtureSpec = { carrierRate: 2_822_400, channels: 2, durationSec: 0.5 };
const DSD128: DsfFixtureSpec = { carrierRate: 5_644_800, channels: 2, durationSec: 0.5 };

interface DsdPlaybackObservation {
    decoded: DecodedParams;
    demuxer: {
        channels: null | number;
        codec: null | string;
        samplerate: null | number;
    };
    endReason: unknown;
    output: DecodedParams;
}

/**
 * Navidrome/TagLib declare the DSD carrier rate; mpv's demuxer and decoder
 * expose the x8 PCM rate that dsd2pcm produces. These tests pin both the real
 * decode behavior and the labels derived from it.
 */
describe.skipIf(!mpvAvailable)('dsf playback through mpv', () => {
    it.each([DSD64, DSD128])(
        'plays a DSD fixture at the x8 PCM rate and keeps its raw route ($carrierRate Hz carrier)',
        { timeout: 30_000 },
        async (spec) => {
            const dir = await createFixtureDirectory();
            const fixturePath = await writeDsfFixture(dir, spec);
            const sizeBytes = (await stat(fixturePath)).size;

            const observation = await playDsfFixture(fixturePath);

            expect(observation.endReason).toBe('eof');
            expect(observation.decoded.channels).toBe(2);
            expect(observation.decoded.samplerate).toBe(spec.carrierRate / 8);
            expect(observation.demuxer.codec).toMatch(/^dsd/);
            expect(observation.demuxer.samplerate).toBe(spec.carrierRate / 8);

            // The carrier-vs-x8 rate pair must not read as a server transcode,
            // or Bit-Perfect would stop every DSF track with a false alarm.
            const route = evaluateServerRoute({
                demuxer: observation.demuxer,
                source: {
                    bitDepth: 1,
                    channels: 2,
                    container: 'dsf',
                    sampleRate: spec.carrierRate,
                    sizeBytes,
                },
            });
            expect(route.route).toBe('direct-stream');
            expect(route.detail).toBeNull();

            const model = buildSignalPathModel({
                policy: 'bit-perfect',
                replayGainMode: 'no',
                snapshot: snapshotFor(observation.decoded, observation.output),
                source: declareSource({
                    bitDepth: 1,
                    channels: 2,
                    container: 'dsf',
                    sampleRate: spec.carrierRate,
                }),
            });

            expect(model.processing.find((entry) => entry.kind === 'declared-decode')?.detail).toBe(
                `dsd2pcm: ${spec.carrierRate} Hz carrier -> ${spec.carrierRate / 8} Hz PCM`,
            );
            expect(model.processing.map((entry) => entry.kind)).not.toContain('resample');
            expect(model.integrity.status).not.toBe('bit-perfect-verified');
            expect(model.integrity.status).not.toBe('bit-perfect-eligible');
        },
    );

    it(
        'labels the unsupported-rate fallback when the output cannot take 352800 Hz',
        { timeout: 30_000 },
        async () => {
            const dir = await createFixtureDirectory();
            const fixturePath = await writeDsfFixture(dir, DSD64);

            const observation = await playDsfFixture(fixturePath, ['--audio-samplerate=192000']);

            expect(observation.decoded.samplerate).toBe(352_800);
            expect(observation.output.samplerate).toBe(192_000);

            const model = buildSignalPathModel({
                policy: 'bit-perfect',
                replayGainMode: 'no',
                snapshot: snapshotFor(observation.decoded, observation.output),
                source: declareSource({
                    bitDepth: 1,
                    channels: 2,
                    container: 'dsf',
                    sampleRate: 2_822_400,
                }),
            });

            expect(model.processing.map((entry) => entry.kind)).toContain('declared-decode');
            expect(model.processing.find((entry) => entry.kind === 'resample')?.detail).toBe(
                '352800 Hz -> 192000 Hz',
            );
            expect(model.integrity.status).not.toBe('bit-perfect-verified');
            expect(model.integrity.status).not.toBe('bit-perfect-eligible');
        },
    );
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function playDsfFixture(
    fixturePath: string,
    extraArgs: string[] = [],
): Promise<DsdPlaybackObservation> {
    const mpv = new MpvTestProcess({ args: ['--ao=null', '--ao-null-untimed=yes', ...extraArgs] });
    try {
        await mpv.start();
        await mpv.observe(1, 'audio-params');
        await mpv.observe(2, 'audio-out-params');
        await mpv.observe(3, 'track-list');
        await mpv.request(['loadfile', fixturePath]);

        const decodedChange = await mpv.waitFor({
            name: 'property-change',
            timeoutMs: 10_000,
            where: (payload) => payload['id'] === 1 && isRecord(payload['data']),
        });
        const outputChange = await mpv.waitFor({
            name: 'property-change',
            timeoutMs: 10_000,
            where: (payload) => payload['id'] === 2 && isRecord(payload['data']),
        });
        const trackChange = await mpv.waitFor({
            name: 'property-change',
            timeoutMs: 10_000,
            where: (payload) =>
                payload['id'] === 3 && Array.isArray(payload['data']) && payload['data'].length > 0,
        });
        const endFile = await mpv.waitFor({ name: 'end-file', timeoutMs: 10_000 });

        const track = (trackChange['data'] as Record<string, unknown>[])[0] ?? {};
        return {
            decoded: readMpvParams(decodedChange['data']),
            demuxer: {
                channels: readNumber(track['demux-channel-count']),
                codec: typeof track['codec'] === 'string' ? track['codec'] : null,
                samplerate: readNumber(track['demux-samplerate']),
            },
            endReason: endFile['reason'],
            output: readMpvParams(outputChange['data']),
        };
    } finally {
        await mpv.dispose();
    }
}

function readMpvParams(value: unknown): DecodedParams {
    const record = isRecord(value) ? value : {};
    return {
        channels: readNumber(record['channel-count']),
        format: typeof record['format'] === 'string' ? record['format'] : null,
        samplerate: readNumber(record['samplerate']),
    };
}

function readNumber(value: unknown): null | number {
    return typeof value === 'number' ? value : null;
}

function snapshotFor(decoded: DecodedParams, output: DecodedParams): AudioSnapshot {
    return {
        activeFilters: [],
        aoDriver: 'coreaudio_exclusive',
        audioDevice: 'coreaudio/DAC',
        cacheEofReaching: null,
        cacheIdle: null,
        cacheUnderrun: null,
        decodedParams: decoded,
        gaplessAudio: 'weak',
        lastEventId: 0,
        muted: false,
        outputParams: output,
        physicalFormat: null,
        playbackKey: 'dsd-fixture',
        playlistPos: 0,
        sequence: 1,
        speed: 1,
        strictPropertyViolations: [],
        strictValidationError: null,
        timestamp: 0,
        volume: 100,
    };
}
