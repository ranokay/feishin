import type { FfmpegAstatsOverall, FfmpegEbur128Summary } from './parse';
import type {
    AnalysisFinding,
    AnalysisMeasurements,
    AnalysisResult,
    AnalysisSourceInfo,
} from './types';

import { ANALYSIS_SCHEMA_VERSION } from './types';

/** dB of dynamic range per integer bit. */
const DB_PER_BIT = 6.02;

export interface DeriveAnalysisInput {
    analyzedAt: string;
    astats: FfmpegAstatsOverall | null;
    ebur128: FfmpegEbur128Summary | null;
    rolloffHz: null | number;
    source: AnalysisSourceInfo;
}

/**
 * Descriptive findings only: each states what was measured next to what the
 * container claims. It does not say a file is fake; low measured resolution
 * can also come from the recording itself. Spectral rolloff is deliberately
 * not classified: an energy percentile cannot prove where content ends, and
 * FFmpeg's available high-pass filters leak too much to measure a Nyquist
 * cliff directly.
 */
export function classifyAnalysis(
    source: AnalysisSourceInfo,
    measurements: AnalysisMeasurements,
): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    const { bitDepth } = source;
    const { effectiveBitDepth, noiseFloorDbfs } = measurements;

    if (
        bitDepth !== null &&
        bitDepth >= 24 &&
        effectiveBitDepth !== null &&
        noiseFloorDbfs !== null &&
        effectiveBitDepth <= bitDepth - 2
    ) {
        findings.push({
            effectiveBitDepth,
            kind: 'effective-resolution',
            noiseFloorDbfs,
            nominalBitDepth: bitDepth,
        });
    }

    return findings;
}

export function deriveAnalysisResult(input: DeriveAnalysisInput): AnalysisResult {
    const { analyzedAt, astats, ebur128, rolloffHz, source } = input;
    const samplePeakDbfs = astats?.peakLevelDb ?? null;
    const rmsDbfs = astats?.rmsLevelDb ?? null;
    const noiseFloorDbfs = astats?.noiseFloorDb ?? null;

    const measurements: AnalysisMeasurements = {
        crestFactorDb:
            samplePeakDbfs !== null && rmsDbfs !== null ? samplePeakDbfs - rmsDbfs : null,
        dcOffset: astats?.dcOffset ?? null,
        effectiveBitDepth: effectiveBitDepthFrom(samplePeakDbfs, noiseFloorDbfs),
        loudnessLufs: ebur128?.integratedLufs ?? null,
        loudnessRangeLu: ebur128?.loudnessRangeLu ?? null,
        noiseFloorDbfs,
        rmsDbfs,
        samplePeakDbfs,
        spectralRolloffHz: rolloffHz,
        truePeakDbfs: ebur128?.truePeakDbfs ?? null,
    };

    return {
        analyzedAt,
        findings: classifyAnalysis(source, measurements),
        measurements,
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        source,
    };
}

/**
 * Quantization noise limits how much of a container's depth is actually used.
 * The measured peak-to-noise-floor range is 6.02 dB per bit; material without
 * quiet passages (pure tones, uniformly loud masters) cannot answer this, so
 * a range under one bit is reported as unknown instead of a fake 0.
 */
export function effectiveBitDepthFrom(
    peakLevelDb: null | number,
    noiseFloorDb: null | number,
): null | number {
    if (peakLevelDb === null || noiseFloorDb === null) {
        return null;
    }
    const dynamicRangeDb = peakLevelDb - noiseFloorDb;
    if (!Number.isFinite(dynamicRangeDb) || dynamicRangeDb < DB_PER_BIT) {
        return null;
    }

    return Math.max(1, Math.min(32, Math.round(dynamicRangeDb / DB_PER_BIT)));
}
