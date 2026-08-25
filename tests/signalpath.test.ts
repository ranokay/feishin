import { describe, expect, it } from 'vitest';

import type { SourceDeclaration } from '../src/shared/signalpath/formats';

import {
    compareFormats,
    evaluateIntegrity,
    evidence,
    type IntegrityObservation,
    isPrecisionPreserving,
    resolvePolicy,
} from '../src/shared/signalpath';

const cleanSource: SourceDeclaration = {
    bitDepth: 16,
    channelCount: 2,
    codec: 'flac',
    lossless: true,
    pcmOrDsd: 'pcm',
    samplingRate: 44100,
};

function baseObservation(overrides: Partial<IntegrityObservation> = {}): IntegrityObservation {
    return {
        activeUserFilters: [],
        declaredSource: cleanSource,
        decodedParams: { channels: 2, format: 's16', samplerate: 44100 },
        filterEvidenceLevel: 'confirmed',
        outputParams: { channels: 2, format: 's32', samplerate: 44100 },
        route: 'coreaudio_exclusive',
        routeEvidenceLevel: 'confirmed',
        serverRoute: 'direct-stream',
        serverRouteEvidenceLevel: 'confirmed',
        ...overrides,
    };
}

describe('format precision', () => {
    it.each([
        ['s16', 's32'],
        ['s16', 'float'],
        ['s24', 'float'],
        ['s24', 's32'],
        ['float', 'double'],
    ])('treats %s -> %s as precision-preserving widening', (from, to) => {
        expect(isPrecisionPreserving(from, to)).toBe(true);
    });

    it.each([
        ['s32', 'float'],
        ['s32', 's24'],
        ['float', 's16'],
        ['double', 'float'],
    ])('treats %s -> %s as precision-altering narrowing', (from, to) => {
        expect(isPrecisionPreserving(from, to)).toBe(false);
        expect(compareFormats('s32', 'float')).toBe('narrowing');
    });

    it('reports incomparable for unknown formats', () => {
        expect(compareFormats('fltp', 's16')).toBe('incomparable');
        expect(isPrecisionPreserving('mystery', 's32')).toBe(false);
    });
});

describe('resolvePolicy', () => {
    const standardInputs = {
        audioFadeEnabled: false,
        compressorEnabled: false,
        equalizerEnabled: false,
        forcedSampleRateHz: null,
        platform: 'darwin' as const,
        policy: 'standard' as const,
        replayGainMode: 'no' as const,
        speed: 1,
    };

    it('changes nothing for standard policy', () => {
        const config = resolvePolicy(standardInputs);
        expect(config.startupArgs).toEqual([]);
        expect(config.requestedExclusive).toBe(false);
        expect(Object.keys(config.runtimeProperties)).toHaveLength(0);
    });

    it('pins coreaudio and requests exclusive for exclusive policy on macOS', () => {
        const config = resolvePolicy({ ...standardInputs, policy: 'exclusive' });
        expect(config.startupArgs).toEqual(['--ao=coreaudio', '--audio-exclusive=yes']);
        expect(config.requestedExclusive).toBe(true);
    });

    it('does not pin an AO on linux where the device decides the driver', () => {
        const config = resolvePolicy({ ...standardInputs, platform: 'linux', policy: 'exclusive' });
        expect(config.startupArgs).toEqual(['--audio-exclusive=yes']);
    });

    it('applies all strict pins for bit-perfect policy', () => {
        const config = resolvePolicy({ ...standardInputs, policy: 'bit-perfect' });
        expect(config.runtimeProperties).toMatchObject({
            'gapless-audio': 'weak',
            mute: false,
            replaygain: 'no',
            speed: 1,
            volume: 100,
        });
        expect(config.startupArgs).toContain('--ao=coreaudio');
    });

    it('records conflicts instead of silently ignoring user features under bit-perfect', () => {
        const config = resolvePolicy({
            ...standardInputs,
            audioFadeEnabled: true,
            compressorEnabled: true,
            equalizerEnabled: true,
            forcedSampleRateHz: 48000,
            policy: 'bit-perfect',
            replayGainMode: 'track',
            speed: 1.5,
        });
        const features = config.conflicts.map((conflict) => conflict.feature);
        expect(features).toContain('dsp');
        expect(features).toContain('replaygain');
        expect(features).toContain('fades');
        expect(features).toContain('forced-sample-rate');
        expect(features).toContain('speed');
    });
});

describe('evaluateIntegrity', () => {
    it('verifies a fully confirmed strict chain', () => {
        const verdict = evaluateIntegrity(baseObservation());
        expect(verdict.status).toBe('bit-perfect-verified');
    });

    it('caps at eligible when any critical fact is not confirmed', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                serverRoute: 'unverified',
                serverRouteEvidenceLevel: 'inferred',
            }),
        );
        expect(verdict.status).toBe('bit-perfect-eligible');
        expect(verdict.missingEvidence).toContain('server-route');
    });

    it('marks exclusive + EQ as processed-exclusive, not bit-perfect', () => {
        const verdict = evaluateIntegrity(baseObservation({ activeUserFilters: ['lavfi'] }));
        expect(verdict.status).toBe('exclusive-processed');
        expect(verdict.detail[0]).toContain('lavfi');
    });

    it('marks shared-route clean output as unprocessed-shared', () => {
        const verdict = evaluateIntegrity(
            baseObservation({ route: 'avfoundation', routeEvidenceLevel: 'confirmed' }),
        );
        expect(verdict.status).toBe('unprocessed-shared');
    });

    it('reports transcoded regardless of everything else', () => {
        const verdict = evaluateIntegrity(baseObservation({ serverRoute: 'transcoded' }));
        expect(verdict.status).toBe('transcoded');
    });

    it('reports lossy sources', () => {
        const verdict = evaluateIntegrity(
            baseObservation({ declaredSource: { ...cleanSource, codec: 'mp3', lossless: false } }),
        );
        expect(verdict.status).toBe('lossy-source');
    });

    it('detects resampling between decoder and output', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                outputParams: { channels: 2, format: 's32', samplerate: 48000 },
            }),
        );
        expect(verdict.status).toBe('resampled');
        expect(verdict.detail.join(' ')).toContain('44100 -> 48000');
    });

    it('flags precision-altering conversion as processed', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                decodedParams: { channels: 2, format: 's32', samplerate: 44100 },
                outputParams: { channels: 2, format: 'float', samplerate: 44100 },
            }),
        );
        expect(['exclusive-processed', 'processed']).toContain(verdict.status);
        expect(verdict.detail.join(' ')).toContain('s32 -> float');
    });

    it('caps DSD-derived playback below bit-perfect', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: {
                    ...cleanSource,
                    codec: 'dsf',
                    pcmOrDsd: 'dsd',
                    samplingRate: 2822400,
                },
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
            }),
        );
        expect(['exclusive-processed', 'processed']).toContain(verdict.status);
        expect(verdict.detail.join(' ')).toContain('DSD converted to PCM');
    });

    it('returns unknown when output evidence is absent', () => {
        const verdict = evaluateIntegrity(baseObservation({ outputParams: null }));
        expect(verdict.status).toBe('unknown');
        expect(verdict.missingEvidence).toContain('output');
    });

    it('wraps evidence values with levels and detects unknowns', () => {
        const confirmed = evidence(42, 'confirmed', 'test');
        const unknownItem = evidence<string | undefined>(undefined, 'unknown', 'test');
        expect(confirmed.level).toBe('confirmed');
        expect(unknownItem.level).toBe('unknown');
    });
});
