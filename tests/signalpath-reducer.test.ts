import { describe, expect, it } from 'vitest';

import type { AudioSnapshot } from '../src/shared/signalpath';
import type { SourceDeclaration } from '../src/shared/signalpath/formats';

import {
    buildSignalPathModel,
    declareSource,
    type ProcessingKind,
} from '../src/shared/signalpath/reducer';

const flacSource: SourceDeclaration = {
    bitDepth: 16,
    channelCount: 2,
    codec: 'flac',
    deEmphasisDeclared: false,
    lossless: true,
    pcmOrDsd: 'pcm',
    samplingRate: 44100,
};

function baseSnapshot(overrides: Partial<AudioSnapshot> = {}): AudioSnapshot {
    return {
        activeFilters: [],
        aoDriver: 'coreaudio_exclusive',
        audioDevice: 'coreaudio/DAC',
        cacheEofReaching: null,
        cacheIdle: null,
        cacheUnderrun: null,
        decodedParams: { channels: 2, format: 's16', samplerate: 44100 },
        gaplessAudio: 'weak',
        lastEventId: 0,
        muted: false,
        outputParams: { channels: 2, format: 's32', samplerate: 44100 },
        physicalFormat: null,
        playbackKey: 'song-1',
        playlistPos: 0,
        sequence: 1,
        speed: 1,
        strictPropertyViolations: [],
        strictValidationError: null,
        timestamp: 0,
        volume: 100,
        ...overrides,
    };
}

const baseInputs = {
    policy: 'bit-perfect' as const,
    replayGainMode: 'no' as const,
    snapshot: baseSnapshot(),
    source: flacSource,
};

function processingKinds(model: ReturnType<typeof buildSignalPathModel>): ProcessingKind[] {
    return model.processing.map((entry) => entry.kind);
}

describe('declareSource', () => {
    it('maps song fields onto a source declaration', () => {
        const declaration = declareSource({
            bitDepth: 24,
            channels: 2,
            container: 'flac',
            sampleRate: 96000,
        });
        expect(declaration).toEqual({
            bitDepth: 24,
            channelCount: 2,
            codec: 'flac',
            deEmphasisDeclared: false,
            lossless: true,
            pcmOrDsd: 'pcm',
            samplingRate: 96000,
        });
    });

    it('declares CD emphasis only from truthy emphasis tags', () => {
        expect(
            declareSource({
                bitDepth: 16,
                channels: 2,
                container: 'flac',
                sampleRate: 44100,
                tags: { PREEMPHASIS: ['1'] },
            })?.deEmphasisDeclared,
        ).toBe(true);
        expect(
            declareSource({
                bitDepth: 16,
                channels: 2,
                container: 'flac',
                sampleRate: 44100,
                tags: { artist: ['someone'] },
            })?.deEmphasisDeclared,
        ).toBe(false);
        expect(
            declareSource({
                bitDepth: 16,
                channels: 2,
                container: 'flac',
                sampleRate: 44100,
            })?.deEmphasisDeclared,
        ).toBe(false);
    });

    it('classifies lossy containers and dsd codecs', () => {
        expect(
            declareSource({ bitDepth: null, channels: 2, container: 'mp3', sampleRate: 44100 })
                ?.lossless,
        ).toBe(false);
        expect(
            declareSource({ bitDepth: null, channels: 2, container: 'dsf', sampleRate: null })
                ?.pcmOrDsd,
        ).toBe('dsd');
        expect(
            declareSource({ bitDepth: null, channels: 2, container: 'x-dsf', sampleRate: null })
                ?.pcmOrDsd,
        ).toBe('dsd');
        expect(
            declareSource({ bitDepth: null, channels: null, container: null, sampleRate: null }),
        ).toBeNull();
    });

    it('never labels unknown containers as definitively lossy', () => {
        // Ambiguous containers (ALAC-in-m4a) and mime-style subtypes must not
        // produce a false lossy-source verdict.
        expect(
            declareSource({ bitDepth: null, channels: 2, container: 'm4a', sampleRate: 44100 })
                ?.lossless,
        ).toBeNull();
        expect(
            declareSource({
                bitDepth: 16,
                channels: 2,
                container: 'x-flac',
                sampleRate: 44100,
            })?.lossless,
        ).toBe(true);
    });
});

describe('buildSignalPathModel', () => {
    it('reports unknown everywhere without a snapshot', () => {
        const model = buildSignalPathModel({ ...baseInputs, snapshot: null });

        expect(model.integrity.status).toBe('unknown');
        expect(model.decoder.level).toBe('unknown');
        expect(model.output.level).toBe('unknown');
        expect(model.device.level).toBe('unknown');
        expect(model.processingEvidence).toBe('unknown');
    });

    it('treats an unobserved af chain as unknown, never as clean', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ activeFilters: null }),
        });

        expect(model.processing).toEqual([]);
        // DSP: None must not carry a confirmed dot until the chain was observed.
        expect(model.processingEvidence).toBe('unknown');
        expect(model.integrity.missingEvidence).toContain('filters');
    });

    it('shows a clean exclusive chain as eligible with DSP None', () => {
        const model = buildSignalPathModel(baseInputs);

        // Server verification does not exist yet, so verified is unreachable.
        expect(model.integrity.status).toBe('bit-perfect-eligible');
        expect(model.processing).toEqual([]);
        expect(model.server.level).toBe('unknown');
    });

    it('never reports verified while server route is unverified', () => {
        const model = buildSignalPathModel(baseInputs);

        expect(['bit-perfect-verified']).not.toContain(model.integrity.status);
        expect(model.integrity.missingEvidence.length > 0).toBe(true);
    });

    it('reaches bit-perfect-verified when a confirmed size-match completes the chain', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                serverRoute: {
                    detail: null,
                    level: 'confirmed',
                    route: 'direct-stream',
                    verification: 'size-match',
                },
            }),
        });

        expect(model.server.value).toBe('direct-stream');
        expect(model.server.level).toBe('confirmed');
        expect(model.integrity.status).toBe('bit-perfect-verified');
        expect(model.integrity.missingEvidence).toEqual([]);
    });

    it('short-circuits to transcoded when the server route contradicts the library', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                serverRoute: {
                    detail: 'stream decodes as opus but library declares .flac',
                    level: 'confirmed',
                    route: 'transcoded',
                    verification: 'unverified',
                },
            }),
        });

        expect(model.integrity.status).toBe('transcoded');
        expect(model.server.detail).toContain('opus');
    });

    it('caps inferred-tier route evidence at eligible pending confirmation', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                serverRoute: {
                    detail: null,
                    level: 'inferred',
                    route: 'direct-stream',
                    verification: 'header-match',
                },
            }),
        });

        expect(model.integrity.status).toBe('bit-perfect-eligible');
        expect(model.integrity.missingEvidence).toContain('server-route');
    });

    it('lists software gain when volume is below unity', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ volume: 70 }),
        });

        expect(processingKinds(model)).toContain('gain');
        expect(model.processing.find((entry) => entry.kind === 'gain')?.level).toBe('confirmed');
        expect(model.integrity.status).toBe('exclusive-processed');
    });

    it('lists muted as gain processing', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ muted: true }),
        });

        expect(processingKinds(model)).toContain('gain');
        expect(model.integrity.status).toBe('exclusive-processed');
    });

    it('shows observed device volume without counting it as processing', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ aoVolume: 35 }),
        });

        // ao-volume may be a hardware control, so it never downgrades the verdict.
        expect(processingKinds(model)).not.toContain('gain');
        expect(model.deviceVolume).toEqual({ detail: null, level: 'confirmed', value: '35%' });
        expect(model.integrity.status).toBe('bit-perfect-eligible');
    });

    it('shows no device volume while ao-volume was not observed', () => {
        const model = buildSignalPathModel(baseInputs);

        expect(model.deviceVolume).toBeNull();
    });

    it('ignores a zero volume-gain', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ volumeGain: 0 }),
        });

        expect(processingKinds(model)).not.toContain('gain');
        expect(model.integrity.status).toBe('bit-perfect-eligible');
    });

    it('lists a non-unity volume-gain as confirmed software gain', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ volumeGain: -6 }),
        });

        const gain = model.processing.find((entry) => entry.kind === 'gain');
        expect(gain?.detail).toBe('-6 dB');
        expect(gain?.level).toBe('confirmed');
        expect(model.integrity.status).toBe('exclusive-processed');
    });

    it('never verifies bit-perfect while volume-gain alters samples', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                serverRoute: {
                    detail: null,
                    level: 'confirmed',
                    route: 'direct-stream',
                    verification: 'size-match',
                },
                volumeGain: 3,
            }),
        });

        expect(model.integrity.status).toBe('exclusive-processed');
    });

    it('lists replaygain as requested-tier processing', () => {
        const model = buildSignalPathModel({ ...baseInputs, replayGainMode: 'track' });

        const rg = model.processing.find((entry) => entry.kind === 'replaygain');
        expect(rg?.level).toBe('requested');
        expect(model.integrity.status).toBe('exclusive-processed');
    });

    it('lists observed user filters as confirmed processing', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ activeFilters: ['lavfi'] }),
        });

        const filter = model.processing.find((entry) => entry.kind === 'filter');
        expect(filter?.detail).toContain('lavfi');
        expect(filter?.level).toBe('confirmed');
    });

    it('shows an enabled source decode as requested until it is observed', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            sourceDecode: { deEmphasis: false, hdcd: true },
        });

        const entry = model.processing.find((candidate) => candidate.kind === 'declared-decode');
        expect(entry?.detail).toContain('hdcd');
        expect(entry?.level).toBe('requested');
    });

    it('confirms an observed source decode and never duplicates it as a generic filter', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ activeFilters: ['lavfi:hdcd'] }),
            sourceDecode: { deEmphasis: false, hdcd: true },
        });

        const entries = model.processing.filter((entry) => entry.kind === 'declared-decode');
        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('confirmed');
        expect(model.processing.filter((entry) => entry.kind === 'filter')).toHaveLength(0);
        // An active decode is never a bit-perfect chain.
        expect(model.integrity.status).toBe('exclusive-processed');
    });

    it('classifies an externally configured hdcd filter even with the option off', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ activeFilters: ['lavfi:hdcd'] }),
        });

        const entry = model.processing.find((candidate) => candidate.kind === 'declared-decode');
        expect(entry?.detail).toContain('hdcd');
        expect(entry?.level).toBe('confirmed');
    });

    it('shows source-declared de-emphasis as not applied while disabled', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            source: { ...flacSource, deEmphasisDeclared: true },
        });

        const entry = model.processing.find((candidate) => candidate.kind === 'declared-decode');
        expect(entry?.detail).toContain('not applied');
        expect(entry?.level).toBe('inferred');
    });

    it('confirms applied de-emphasis without a not-applied duplicate', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ activeFilters: ['lavfi:aemphasis=type=cd'] }),
            source: { ...flacSource, deEmphasisDeclared: true },
            sourceDecode: { deEmphasis: true, hdcd: false },
        });

        const entries = model.processing.filter((entry) => entry.kind === 'declared-decode');
        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('confirmed');
        expect(entries[0].detail).not.toContain('not applied');
    });

    it('keeps non-CD aemphasis curves as generic filters', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ activeFilters: ['lavfi:aemphasis=type=col'] }),
        });

        expect(model.processing.filter((entry) => entry.kind === 'declared-decode')).toHaveLength(
            0,
        );
        const filter = model.processing.find((entry) => entry.kind === 'filter');
        expect(filter?.detail).toContain('aemphasis');
    });

    it('never claims bit-perfect while an opted decode is missing from the chain', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                serverRoute: {
                    detail: null,
                    level: 'confirmed',
                    route: 'direct-stream',
                    verification: 'size-match',
                },
            }),
            sourceDecode: { deEmphasis: false, hdcd: true },
        });

        expect(model.integrity.status).not.toBe('bit-perfect-verified');
        expect(model.integrity.status).not.toBe('bit-perfect-eligible');
        expect(model.integrity.missingEvidence).toContain('source-decode');
    });

    it('flags an output format too narrow for the hdcd expansion', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                activeFilters: ['lavfi:hdcd'],
                outputParams: { channels: 2, format: 's16', samplerate: 44100 },
            }),
            sourceDecode: { deEmphasis: false, hdcd: true },
        });

        const truncation = model.processing.find((entry) => entry.kind === 'format-conversion');
        expect(truncation?.detail).toContain('20-bit');
        expect(truncation?.detail).toContain('s16');
        expect(model.integrity.status).toBe('exclusive-processed');
    });

    it('accepts a 20-bit-safe output for the hdcd expansion', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ activeFilters: ['lavfi:hdcd'] }),
            sourceDecode: { deEmphasis: false, hdcd: true },
        });

        expect(model.processing.filter((entry) => entry.kind === 'format-conversion')).toHaveLength(
            0,
        );
    });

    it('lists tempo processing when speed differs from 1', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ speed: 1.5 }),
        });

        expect(processingKinds(model)).toContain('tempo');
    });

    it('flags narrowing conversion but not widening', () => {
        const narrowing = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                decodedParams: { channels: 2, format: 's32', samplerate: 44100 },
                outputParams: { channels: 2, format: 'float', samplerate: 44100 },
            }),
        });
        expect(processingKinds(narrowing)).toContain('format-conversion');

        const widening = buildSignalPathModel(baseInputs);
        expect(processingKinds(widening)).not.toContain('format-conversion');
    });

    it('flags channel-count changes', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                outputParams: { channels: 6, format: 's32', samplerate: 44100 },
            }),
        });

        expect(processingKinds(model)).toContain('channel-map');
    });

    it('flags decoder-to-output resampling', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                outputParams: { channels: 2, format: 's32', samplerate: 48000 },
            }),
        });

        expect(model.integrity.status).toBe('resampled');
        expect(processingKinds(model)).toContain('resample');
    });

    it('marks dsd sources as declared-decode processing', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
            }),
            source: { ...flacSource, codec: 'dsf', pcmOrDsd: 'dsd', samplingRate: 2822400 },
        });

        const dsd = model.processing.find((entry) => entry.kind === 'declared-decode');
        expect(dsd?.level).toBe('inferred');
        expect(['exclusive-processed', 'processed']).toContain(model.integrity.status);
    });

    it('labels the DSD conversion with the carrier and x8 PCM rates', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
                outputParams: { channels: 2, format: 'float', samplerate: 352800 },
            }),
            source: { ...flacSource, codec: 'dsf', pcmOrDsd: 'dsd', samplingRate: 2822400 },
        });

        const dsd = model.processing.find((entry) => entry.kind === 'declared-decode');
        expect(dsd?.detail).toBe('dsd2pcm: 2822400 Hz carrier -> 352800 Hz PCM');
        expect(['exclusive-processed', 'processed']).toContain(model.integrity.status);
    });

    it('labels a DSD source declared at the x8 PCM rate without inventing a carrier', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
                outputParams: { channels: 2, format: 'float', samplerate: 352800 },
            }),
            source: { ...flacSource, codec: 'dsf', pcmOrDsd: 'dsd', samplingRate: 352800 },
        });

        const dsd = model.processing.find((entry) => entry.kind === 'declared-decode');
        expect(dsd?.detail).toBe('dsd2pcm: 352800 Hz PCM');
    });

    it('does not claim a carrier qualifier when the decode rate is unknown', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ decodedParams: null }),
            source: { ...flacSource, codec: 'dsf', pcmOrDsd: 'dsd', samplingRate: 352800 },
        });

        const dsd = model.processing.find((entry) => entry.kind === 'declared-decode');
        expect(dsd?.detail).toBe('dsd2pcm: 352800 Hz');
    });

    it('labels the resampled output fallback alongside the DSD conversion', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
                outputParams: { channels: 2, format: 'float', samplerate: 192000 },
            }),
            source: { ...flacSource, codec: 'dsf', pcmOrDsd: 'dsd', samplingRate: 2822400 },
        });

        expect(processingKinds(model)).toContain('declared-decode');
        expect(processingKinds(model)).toContain('resample');
        expect(model.processing.find((entry) => entry.kind === 'resample')?.detail).toBe(
            '352800 Hz -> 192000 Hz',
        );
        expect(model.integrity.status).not.toBe('bit-perfect-verified');
        expect(model.integrity.status).not.toBe('bit-perfect-eligible');
    });

    it('caps shared routes at unprocessed-shared', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ aoDriver: 'avfoundation' }),
        });

        expect(model.integrity.status).toBe('unprocessed-shared');
        expect(model.output.value).toContain('avfoundation');
        expect(model.requestedExclusive).toBe(true);
    });

    it('classifies a raw alsa hw device as direct but pending confirmation', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                aoDriver: 'alsa',
                audioDevice: 'alsa/hw:CARD=Audio,DEV=0',
            }),
        });

        expect(model.integrity.status).toBe('bit-perfect-eligible');
        expect(model.integrity.missingEvidence).toContain('route');
        expect(model.device.value).toBe('alsa/hw:CARD=Audio,DEV=0');
    });

    it('keeps a non-hw alsa device shared', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ aoDriver: 'alsa', audioDevice: 'alsa/default' }),
        });

        expect(model.integrity.status).toBe('unprocessed-shared');
    });

    it('keeps a requested wasapi route eligible instead of shared', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ aoDriver: 'wasapi', audioDevice: 'wasapi/{guid}' }),
        });

        expect(model.requestedExclusive).toBe(true);
        expect(model.integrity.status).toBe('bit-perfect-eligible');
        expect(model.integrity.missingEvidence).toContain('route');
    });

    it('keeps a capable route shared when the policy does not request exclusivity', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            policy: 'standard',
            snapshot: baseSnapshot({ aoDriver: 'wasapi', audioDevice: 'wasapi/{guid}' }),
        });

        expect(model.requestedExclusive).toBe(false);
        expect(model.integrity.status).toBe('unprocessed-shared');
    });

    it('carries physical format evidence through to the device stage', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                audioDevice: null,
                physicalFormat: { level: 'inferred', source: 'mpv-log', value: '44100 Hz' },
            }),
        });

        // Log-derived evidence must not display as confirmed.
        expect(model.device.level).toBe('inferred');
        expect(model.physicalFormat?.level).toBe('inferred');
    });

    it('separates the device stage from the physical format evidence', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                audioDevice: 'coreaudio/DAC',
                physicalFormat: { level: 'inferred', source: 'mpv-log', value: '44100 Hz' },
            }),
        });

        // The device row keeps the device name; the physical format renders as
        // its own evidence row instead of replacing the device value.
        expect(model.device.value).toBe('coreaudio/DAC');
        expect(model.device.detail).toBeNull();
        expect(model.physicalFormat?.value).toBe('44100 Hz');
    });

    it('treats a missing ao driver as unknown-route evidence', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ aoDriver: null, outputParams: null }),
        });

        expect(model.output.level).toBe('unknown');
        expect(model.integrity.status).toBe('unknown');
    });

    function depthModel(sourceDepth: null | number, decodedFormat: string) {
        return buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                decodedParams: { channels: 2, format: decodedFormat, samplerate: 44100 },
            }),
            source: { ...flacSource, bitDepth: sourceDepth },
        });
    }

    function depthEntry(model: ReturnType<typeof buildSignalPathModel>) {
        return model.processing.find((entry) => entry.detail?.includes('-bit decoded'));
    }

    it('flags a declared depth the decoded format cannot carry', () => {
        const model = depthModel(24, 's16');
        const entry = depthEntry(model);

        expect(entry?.kind).toBe('format-conversion');
        expect(entry?.detail).toBe('declared 24-bit decoded as s16');
        expect(entry?.level).toBe('confirmed');
        expect(model.integrity.status).toBe('exclusive-processed');
    });

    const preservedDepths: Array<[number, string]> = [
        [16, 's16'],
        [24, 's32'],
        [24, 'float'],
    ];
    it.each(preservedDepths)('accepts declared %i-bit decoded as %s', (depth, format) => {
        expect(depthEntry(depthModel(depth, format))).toBeUndefined();
    });

    const lossyDepths: Array<[number, string]> = [
        [32, 's24'],
        [32, 'float'],
    ];
    it.each(lossyDepths)('flags declared %i-bit decoded as %s', (depth, format) => {
        expect(depthEntry(depthModel(depth, format))?.detail).toBe(
            `declared ${depth}-bit decoded as ${format}`,
        );
    });

    it('does not invent a depth finding for an unknown decoded format', () => {
        expect(depthEntry(depthModel(24, 'fltp'))).toBeUndefined();
    });

    it('does not invent a depth finding without a declared depth', () => {
        expect(depthEntry(depthModel(null, 's16'))).toBeUndefined();
    });

    it('leaves DSD sources out of the depth check', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({
                decodedParams: { channels: 2, format: 'float', samplerate: 352800 },
                outputParams: { channels: 2, format: 'float', samplerate: 352800 },
            }),
            source: {
                ...flacSource,
                bitDepth: 32,
                codec: 'dsf',
                pcmOrDsd: 'dsd',
                samplingRate: 2822400,
            },
        });

        expect(depthEntry(model)).toBeUndefined();
    });

    it('reports standard policy without requesting exclusive', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            policy: 'standard',
            snapshot: baseSnapshot({ aoDriver: 'avfoundation' }),
        });

        expect(model.requestedExclusive).toBe(false);
        expect(model.integrity.status).toBe('unprocessed-shared');
    });
});
