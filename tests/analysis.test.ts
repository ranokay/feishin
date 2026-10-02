import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    analysisCacheKey,
    deriveAnalysisResult,
    effectiveBitDepthFrom,
    parseAstatsOverall,
    parseEbur128Summary,
    parseFfprobeJson,
    parseRolloffValues,
    summarizeRolloff,
} from '../src/shared/analysis';

const fixture = (name: string) =>
    readFileSync(fileURLToPath(new URL(`./fixtures/analysis/${name}`, import.meta.url)), 'utf8');

const source16 = {
    bitDepth: 16,
    channels: 1,
    codec: 'flac',
    container: 'flac',
    durationSec: 2,
    sampleRate: 44100,
    sizeBytes: 40739,
};

describe('parseFfprobeJson', () => {
    it('reads stream and format facts from a flac probe', () => {
        expect(parseFfprobeJson(fixture('ffprobe-flac-16.json'))).toEqual(source16);
    });

    it('reads a 24-bit stereo probe', () => {
        expect(parseFfprobeJson(fixture('ffprobe-flac-24.json'))).toEqual({
            bitDepth: 24,
            channels: 2,
            codec: 'flac',
            container: 'flac',
            durationSec: 123.456,
            sampleRate: 96000,
            sizeBytes: 12950000,
        });
    });

    it('returns null for unparsable or streamless probes', () => {
        expect(parseFfprobeJson('not json')).toBeNull();
        expect(parseFfprobeJson('{"streams":[],"format":{}}')).toBeNull();
    });
});

describe('parseAstatsOverall', () => {
    it('reads the overall block, not a per-channel block', () => {
        expect(parseAstatsOverall(fixture('ffmpeg-sine-16bit.stderr.txt'))).toEqual({
            dcOffset: 0,
            noiseFloorDb: -18.063656,
            peakLevelDb: -18.063656,
            rmsLevelDb: -21.073712,
        });
    });

    it('treats an infinite noise floor as not measurable', () => {
        const overall = parseAstatsOverall(fixture('ffmpeg-quiet-passage-16bit.stderr.txt'));
        expect(overall?.noiseFloorDb).toBeNull();
        expect(overall?.peakLevelDb).toBeCloseTo(-4.991631, 5);
    });

    it('returns null when no overall block exists', () => {
        expect(parseAstatsOverall('')).toBeNull();
    });
});

describe('parseEbur128Summary', () => {
    it('reads integrated loudness, range, and true peak', () => {
        expect(parseEbur128Summary(fixture('ffmpeg-sine-16bit.stderr.txt'))).toEqual({
            integratedLufs: -21.1,
            loudnessRangeLu: 0,
            truePeakDbfs: -18.1,
        });
    });

    it('returns null when no summary exists', () => {
        expect(parseEbur128Summary('')).toBeNull();
    });
});

describe('rolloff samples', () => {
    it('extracts the per-frame rolloff series', () => {
        const values = parseRolloffValues(fixture('rolloff-sine-16bit.stdout'));
        expect(values).toHaveLength(87);
        expect(values[0]).toBeCloseTo(1356.59, 2);
        expect(values.at(-1)).toBeCloseTo(1291.99, 2);
    });

    it('drops non-finite values and summarizes percentiles', () => {
        const values = parseRolloffValues(
            [
                'frame:0    pts:0       pts_time:0',
                'lavfi.aspectralstats.1.rolloff=1000',
                'lavfi.aspectralstats.1.rolloff=nan',
                'lavfi.aspectralstats.1.rolloff=2000',
                'lavfi.aspectralstats.1.rolloff=inf',
                'lavfi.aspectralstats.1.rolloff=3000',
            ].join('\n'),
        );
        expect(values).toEqual([1000, 2000, 3000]);
        expect(summarizeRolloff(values)).toEqual({
            frameCount: 3,
            medianHz: 2000,
            p90Hz: 3000,
        });
        expect(summarizeRolloff([])).toEqual({
            frameCount: 0,
            medianHz: null,
            p90Hz: null,
        });
    });
});

describe('effectiveBitDepthFrom', () => {
    it('derives the resolution a measured dynamic range supports', () => {
        expect(effectiveBitDepthFrom(-1, -97)).toBe(16);
        expect(effectiveBitDepthFrom(-1, -121)).toBe(20);
    });

    it('refuses to invent a resolution without measurable quiet passages', () => {
        expect(effectiveBitDepthFrom(-1, -1)).toBeNull();
        expect(effectiveBitDepthFrom(-4.99, null)).toBeNull();
    });
});

describe('deriveAnalysisResult', () => {
    const sineAstats = parseAstatsOverall(fixture('ffmpeg-sine-16bit.stderr.txt'))!;
    const sineEbur = parseEbur128Summary(fixture('ffmpeg-sine-16bit.stderr.txt'))!;
    const sineRolloff = summarizeRolloff(parseRolloffValues(fixture('rolloff-sine-16bit.stdout')));

    it('merges the measured values into a schema-versioned result', () => {
        const result = deriveAnalysisResult({
            analyzedAt: '2026-10-02T00:00:00.000Z',
            astats: sineAstats,
            ebur128: sineEbur,
            rolloff: sineRolloff,
            source: source16,
        });

        expect(result.schemaVersion).toBe(1);
        expect(result.analyzedAt).toBe('2026-10-02T00:00:00.000Z');
        expect(result.source).toEqual(source16);
        expect(result.measurements).toMatchObject({
            dcOffset: 0,
            effectiveBitDepth: null,
            hfExtentHz: 1012.06,
            hfExtentP90Hz: 1012.06,
            loudnessLufs: -21.1,
            loudnessRangeLu: 0,
            noiseFloorDbfs: -18.063656,
            rmsDbfs: -21.073712,
            samplePeakDbfs: -18.063656,
            truePeakDbfs: -18.1,
        });
        expect(result.measurements.crestFactorDb).toBeCloseTo(3.010056, 5);
        expect(result.findings).toEqual([]);
    });

    it('flags a resolution below the container and HF content below Nyquist', () => {
        const result = deriveAnalysisResult({
            analyzedAt: '2026-10-02T00:00:00.000Z',
            astats: { dcOffset: 0, noiseFloorDb: -97, peakLevelDb: -1, rmsLevelDb: -20 },
            ebur128: null,
            rolloff: { frameCount: 10, medianHz: 18700, p90Hz: 19078 },
            source: { ...source16, bitDepth: 24, sampleRate: 96000 },
        });

        expect(result.findings).toEqual([
            {
                effectiveBitDepth: 16,
                kind: 'effective-resolution',
                noiseFloorDbfs: -97,
                nominalBitDepth: 24,
            },
            { hfExtentHz: 18700, kind: 'bandwidth-extent', nominalNyquistHz: 48000 },
        ]);
    });

    it('does not flag 16-bit 44.1 kHz material as lossless-consistent', () => {
        const result = deriveAnalysisResult({
            analyzedAt: '2026-10-02T00:00:00.000Z',
            astats: sineAstats,
            ebur128: sineEbur,
            rolloff: sineRolloff,
            source: source16,
        });

        expect(result.findings).toEqual([]);
    });
});

describe('analysisCacheKey', () => {
    const base = {
        serverId: 'server-a',
        size: 1000,
        songId: 'song-1',
        updatedAt: '2026-01-01T00:00:00Z',
    };

    it('is stable for the same source revision', () => {
        expect(analysisCacheKey(base)).toBe(analysisCacheKey({ ...base }));
    });

    it('changes when the file size or modified date changes', () => {
        expect(analysisCacheKey({ ...base, size: 1001 })).not.toBe(analysisCacheKey(base));
        expect(analysisCacheKey({ ...base, updatedAt: '2026-02-02T00:00:00Z' })).not.toBe(
            analysisCacheKey(base),
        );
    });

    it('scopes entries to the server and song', () => {
        expect(analysisCacheKey({ ...base, serverId: 'server-b' })).not.toBe(
            analysisCacheKey(base),
        );
        expect(analysisCacheKey({ ...base, songId: 'song-2' })).not.toBe(analysisCacheKey(base));
    });
});
