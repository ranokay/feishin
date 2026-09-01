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
        muted: false,
        outputParams: { channels: 2, format: 's32', samplerate: 44100 },
        physicalFormat: null,
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
            lossless: true,
            pcmOrDsd: 'pcm',
            samplingRate: 96000,
        });
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

    it('caps shared routes at unprocessed-shared', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ aoDriver: 'avfoundation' }),
        });

        expect(model.integrity.status).toBe('unprocessed-shared');
        expect(model.output.value).toContain('avfoundation');
        expect(model.requestedExclusive).toBe(true);
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

    it('treats a missing ao driver as unknown-route evidence', () => {
        const model = buildSignalPathModel({
            ...baseInputs,
            snapshot: baseSnapshot({ aoDriver: null, outputParams: null }),
        });

        expect(model.output.level).toBe('unknown');
        expect(model.integrity.status).toBe('unknown');
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
