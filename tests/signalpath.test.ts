import { describe, expect, it } from 'vitest';

import type { SourceDeclaration } from '../src/shared/signalpath/formats';

import {
    classifyRoute,
    compareFormats,
    evaluateIntegrity,
    evidence,
    type IntegrityObservation,
    isDepthPreserved,
    isPrecisionPreserving,
    resolvePolicy,
    type RouteKind,
} from '../src/shared/signalpath';

const cleanSource: SourceDeclaration = {
    bitDepth: 16,
    channelCount: 2,
    codec: 'flac',
    deEmphasisDeclared: false,
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

describe('route classification', () => {
    it.each([
        ['coreaudio', null, 'shared'],
        ['coreaudio_exclusive', null, 'confirmed-exclusive'],
        ['avfoundation', null, 'shared'],
        ['wasapi', null, 'exclusive-capable'],
        ['pipewire', null, 'exclusive-capable'],
        ['pulse', null, 'shared'],
        ['alsa', null, 'shared'],
        ['alsa', 'alsa/default', 'shared'],
        ['alsa', 'alsa/hw:CARD=Audio,DEV=0', 'direct'],
    ] as Array<[string, null | string, RouteKind]>)(
        'classifies %s on device %s as %s',
        (route, device, expected) => {
            expect(classifyRoute(route, device)).toBe(expected);
        },
    );

    it('does not treat an unknown route as exclusive', () => {
        expect(classifyRoute('')).toBe('shared');
    });
});

describe('depth preservation', () => {
    const preservedCases: Array<[number, string]> = [
        [16, 's16'],
        [24, 's32'],
        [24, 'float'],
        [32, 's32'],
    ];
    it.each(preservedCases)(
        'treats declared %i-bit decoded as %s as preserved',
        (depth, format) => {
            expect(isDepthPreserved(depth, format)).toBe(true);
        },
    );

    const lossCases: Array<[number, string]> = [
        [24, 's16'],
        [32, 's24'],
        [32, 'float'],
    ];
    it.each(lossCases)('flags declared %i-bit decoded as %s', (depth, format) => {
        expect(isDepthPreserved(depth, format)).toBe(false);
    });

    const unknownCases: Array<[null | number, null | string]> = [
        [null, 's16'],
        [24, null],
        [24, 'fltp'],
        [24, 'mystery'],
    ];
    it.each(unknownCases)('reports unknown without a finding for %s / %s', (depth, format) => {
        expect(isDepthPreserved(depth, format)).toBeNull();
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
            replaygain: 'no',
            speed: 1,
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

    it('keeps a requested exclusive-capable route eligible instead of shared', () => {
        const verdict = evaluateIntegrity(
            baseObservation({ requestedExclusive: true, route: 'wasapi' }),
        );
        expect(verdict.status).toBe('bit-perfect-eligible');
        expect(verdict.missingEvidence).toContain('route');
    });

    it('keeps other pending evidence when a capable route is eligible', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                requestedExclusive: true,
                route: 'wasapi',
                serverRoute: 'unverified',
                serverRouteEvidenceLevel: 'inferred',
            }),
        );
        expect(verdict.status).toBe('bit-perfect-eligible');
        expect(verdict.missingEvidence).toEqual(expect.arrayContaining(['route', 'server-route']));
    });

    it('keeps pipewire pending while exclusivity is requested and unconfirmed', () => {
        const verdict = evaluateIntegrity(
            baseObservation({ requestedExclusive: true, route: 'pipewire' }),
        );
        expect(verdict.status).toBe('bit-perfect-eligible');
        expect(verdict.missingEvidence).toContain('route');
    });

    it('keeps exclusive-capable routes shared when exclusivity was not requested', () => {
        const verdict = evaluateIntegrity(
            baseObservation({ requestedExclusive: false, route: 'wasapi' }),
        );
        expect(verdict.status).toBe('unprocessed-shared');
    });

    it('keeps non-capable shared routes shared even when exclusivity was requested', () => {
        const verdict = evaluateIntegrity(
            baseObservation({ requestedExclusive: true, route: 'avfoundation' }),
        );
        expect(verdict.status).toBe('unprocessed-shared');
    });

    it('treats alsa on a raw hw device as direct but not confirmed exclusive', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                audioDevice: 'alsa/hw:CARD=Audio,DEV=0',
                requestedExclusive: true,
                route: 'alsa',
            }),
        );
        expect(verdict.status).toBe('bit-perfect-eligible');
        expect(verdict.missingEvidence).toContain('route');
    });

    it('keeps alsa on a non-hw device shared', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                audioDevice: 'alsa/default',
                requestedExclusive: true,
                route: 'alsa',
            }),
        );
        expect(verdict.status).toBe('unprocessed-shared');
    });

    it('does not confirm a direct alsa route even without an exclusive request', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                audioDevice: 'alsa/hw:CARD=Audio,DEV=0',
                requestedExclusive: false,
                route: 'alsa',
            }),
        );
        expect(verdict.status).toBe('bit-perfect-eligible');
        expect(verdict.missingEvidence).toContain('route');
    });

    it('does not label processing on an unconfirmed route as exclusive-processed', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                activeUserFilters: ['lavfi'],
                requestedExclusive: true,
                route: 'wasapi',
            }),
        );
        expect(verdict.status).toBe('processed');
    });

    it('does not label processing on a direct alsa hw route as exclusive-processed', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                activeUserFilters: ['lavfi'],
                audioDevice: 'alsa/hw:CARD=Audio,DEV=0',
                requestedExclusive: true,
                route: 'alsa',
            }),
        );
        expect(verdict.status).toBe('processed');
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

    it('flags a declared 24-bit source decoded as s16', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: { ...cleanSource, bitDepth: 24 },
            }),
        );
        expect(verdict.status).toBe('exclusive-processed');
        expect(verdict.detail.join(' ')).toContain('declared 24-bit decoded as s16');
    });

    it('keeps a declared 24-bit source decoded as s32 verified', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: { ...cleanSource, bitDepth: 24 },
                decodedParams: { channels: 2, format: 's32', samplerate: 44100 },
            }),
        );
        expect(verdict.status).toBe('bit-perfect-verified');
    });

    it('keeps a declared 24-bit source decoded as float verified', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: { ...cleanSource, bitDepth: 24 },
                decodedParams: { channels: 2, format: 'float', samplerate: 44100 },
            }),
        );
        expect(verdict.status).toBe('bit-perfect-verified');
    });

    it('flags a declared 32-bit source decoded as s24', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: { ...cleanSource, bitDepth: 32 },
                decodedParams: { channels: 2, format: 's24', samplerate: 44100 },
            }),
        );
        expect(verdict.status).toBe('exclusive-processed');
        expect(verdict.detail.join(' ')).toContain('declared 32-bit decoded as s24');
    });

    it('flags a declared 32-bit source decoded as float', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: { ...cleanSource, bitDepth: 32 },
                decodedParams: { channels: 2, format: 'float', samplerate: 44100 },
            }),
        );
        expect(verdict.status).toBe('exclusive-processed');
        expect(verdict.detail.join(' ')).toContain('declared 32-bit decoded as float');
    });

    it('does not invent a depth finding for an unknown decoded format', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: { ...cleanSource, bitDepth: 24 },
                decodedParams: { channels: 2, format: 'fltp', samplerate: 44100 },
            }),
        );
        expect(verdict.detail.join(' ')).not.toContain('declared 24-bit');
    });

    it('leaves DSD sources out of the depth check', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: {
                    ...cleanSource,
                    bitDepth: 32,
                    codec: 'dsf',
                    pcmOrDsd: 'dsd',
                    samplingRate: 2822400,
                },
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
                outputParams: { channels: 2, format: 'float', samplerate: 352800 },
            }),
        );
        expect(verdict.detail.join(' ')).not.toContain('declared 32-bit');
    });

    it('stays verified when the source declares no depth', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: { ...cleanSource, bitDepth: null },
            }),
        );
        expect(verdict.status).toBe('bit-perfect-verified');
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

    it('treats the DSD carrier-to-x8-PCM rate as declared conversion, not resampling', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: {
                    ...cleanSource,
                    codec: 'dsf',
                    pcmOrDsd: 'dsd',
                    samplingRate: 2822400,
                },
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
                outputParams: { channels: 2, format: 'float', samplerate: 352800 },
            }),
        );

        expect(verdict.detail.join(' ')).not.toContain('rate mismatch');
        expect(verdict.detail.join(' ')).not.toContain('rate change');
        expect(verdict.status).toBe('exclusive-processed');
    });

    it('shows the resampled fallback when the output cannot take the x8 PCM rate', () => {
        const verdict = evaluateIntegrity(
            baseObservation({
                declaredSource: {
                    ...cleanSource,
                    codec: 'dsf',
                    pcmOrDsd: 'dsd',
                    samplingRate: 2822400,
                },
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
                outputParams: { channels: 2, format: 'float', samplerate: 192000 },
            }),
        );

        expect(verdict.detail.join(' ')).toContain('352800 -> 192000');
        expect(verdict.status).toBe('exclusive-processed');
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
