import { describe, expect, it } from 'vitest';

import type { SourceDeclaration } from '../src/shared/signalpath/formats';
import type { AudioEngineEvent, AudioSnapshot } from '../src/shared/signalpath/snapshot';

import { buildDiagnosticsReport } from '../src/shared/signalpath/diagnostics';

const flacSource: SourceDeclaration = {
    bitDepth: 16,
    channelCount: 2,
    codec: 'flac',
    lossless: true,
    pcmOrDsd: 'pcm',
    samplingRate: 44100,
};

function baseSnapshot(overrides: Partial<AudioSnapshot> = {}): AudioSnapshot {
    return {
        activeFilters: [],
        aoDriver: 'coreaudio_exclusive',
        audioDevice: 'coreaudio/DAC',
        cacheEofReaching: false,
        cacheIdle: true,
        cacheUnderrun: null,
        decodedParams: { channels: 2, format: 's16', samplerate: 44100 },
        demuxer: { channels: 2, codec: 'flac', samplerate: 44100 },
        gaplessAudio: 'weak',
        muted: false,
        outputParams: { channels: 2, format: 's32', samplerate: 44100 },
        physicalFormat: { level: 'inferred', source: 'mpv-log', value: '44100 Hz 2ch' },
        playlistPos: 3,
        sequence: 9,
        serverRoute: {
            detail: null,
            level: 'confirmed',
            route: 'direct-stream',
            verification: 'size-match',
        },
        speed: 1,
        streamUrl:
            'https://navi.example/rest/stream.view?id=abc&v=1.13.0&c=Feishin&u=joe&t=tok123&s=salt9',
        strictPropertyViolations: [],
        strictValidationError: null,
        timestamp: 0,
        volume: 100,
        ...overrides,
    };
}

const baseInputs = (overrides?: Partial<Parameters<typeof buildDiagnosticsReport>[0]>) => ({
    events: [] as AudioEngineEvent[],
    policy: 'bit-perfect' as const,
    replayGainMode: 'no' as const,
    snapshot: baseSnapshot(),
    source: flacSource,
    ...overrides,
});

describe('buildDiagnosticsReport', () => {
    it('renders every section header even without playback state', () => {
        const report = buildDiagnosticsReport(
            baseInputs({ events: [], snapshot: null, source: null }),
        );

        for (const section of [
            '[source]',
            '[server route]',
            '[decoder]',
            '[processing]',
            '[output]',
            '[cache]',
            '[events]',
        ]) {
            expect(report).toContain(section);
        }
        expect(report).toContain('unknown');
    });

    it('includes the declared source facts and policy', () => {
        const report = buildDiagnosticsReport(baseInputs());

        expect(report).toContain('flac');
        expect(report).toContain('44100');
        expect(report).toContain('16-bit');
        expect(report).toContain('policy: bit-perfect');
    });

    it('reports the verified route with its evidence tier', () => {
        const report = buildDiagnosticsReport(baseInputs());

        expect(report).toContain('direct-stream');
        expect(report).toContain('size-match');
        expect(report).toContain('confirmed');
    });

    it('scrubs credential query parameters defensively', () => {
        const report = buildDiagnosticsReport(baseInputs());

        expect(report).not.toContain('tok123');
        expect(report).not.toContain('salt9');
        expect(report).not.toContain('u=joe');
        // Diagnostic value stays: path and safe params remain visible.
        expect(report).toContain('/rest/stream.view');
        expect(report).toContain('id=abc');
        expect(report).toContain('v=1.13.0');
    });

    it('lists mpv internals: demuxer, decoder, filters, output, device', () => {
        const report = buildDiagnosticsReport(baseInputs());

        expect(report).toContain('demuxer: flac @ 44100 Hz 2ch');
        expect(report).toContain('decoded: s16 / 44100 Hz / 2ch');
        expect(report).toContain('af: none');
        expect(report).toContain('coreaudio_exclusive');
        expect(report).toContain('out params: s32 / 44100 Hz / 2ch');
        expect(report).toContain('coreaudio/DAC');
        expect(report).toContain('physical format: 44100 Hz 2ch (inferred)');
    });

    it('lists active filters when the af chain is non-empty', () => {
        const report = buildDiagnosticsReport(
            baseInputs({ snapshot: baseSnapshot({ activeFilters: ['lavfi', 'compressor'] }) }),
        );

        expect(report).toContain('af: lavfi, compressor');
    });

    it('shows processing values that deviate from unity', () => {
        const report = buildDiagnosticsReport(
            baseInputs({
                replayGainMode: 'track',
                snapshot: baseSnapshot({ muted: true, speed: 1.5, volume: 70 }),
            }),
        );

        expect(report).toContain('volume: 70% (muted)');
        expect(report).toContain('speed: 1.5x');
        expect(report).toContain('replaygain mode: track');
    });

    it('appends a capped tail of recent events one per line', () => {
        const events: AudioEngineEvent[] = Array.from({ length: 60 }, (_, index) => ({
            detail: `marker ${index}`,
            id: index + 1,
            time: 1_700_000_000_000 + index * 1000,
            type: 'device-opened',
        }));

        const report = buildDiagnosticsReport(baseInputs({ events }));

        expect(report).toContain('last 50');
        expect(report).toContain('marker 59');
        // Oldest entries fall off the tail.
        expect(report).not.toContain('marker 0\n');
        expect(report).not.toContain('marker 9\n');
    });

    it('never includes raw query credentials from any url-shaped field', () => {
        const report = buildDiagnosticsReport(
            baseInputs({
                snapshot: baseSnapshot({
                    serverRoute: {
                        detail: 'probe failed for https://host/stream?apiKey=SECRET99',
                        level: 'unknown',
                        route: 'unverified',
                        verification: 'unverified',
                    },
                }),
            }),
        );

        expect(report).toContain('<redacted>');
        expect(report).not.toContain('SECRET99');
    });
});
