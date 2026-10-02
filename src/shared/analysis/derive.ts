import type { FfmpegAstatsOverall, FfmpegEbur128Summary, FfmpegRolloffSummary } from './parse';
import type {
    AnalysisFinding,
    AnalysisMeasurements,
    AnalysisResult,
    AnalysisSourceInfo,
} from './types';

import { ANALYSIS_SCHEMA_VERSION } from './types';

export interface DeriveAnalysisInput {
    analyzedAt: string;
    astats: FfmpegAstatsOverall | null;
    ebur128: FfmpegEbur128Summary | null;
    rolloff: FfmpegRolloffSummary;
    source: AnalysisSourceInfo;
}

/**
 * Descriptive findings only: each states what was measured next to what the
 * container claims. Neither says a file is fake; low measured resolution or
 * bandwidth can also come from the recording itself.
 */
export function classifyAnalysis(
    source: AnalysisSourceInfo,
    measurements: AnalysisMeasurements,
): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    const { bitDepth, sampleRate } = source;
    const { effectiveBitDepth, hfExtentHz, noiseFloorDbfs } = measurements;

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

    if (
        sampleRate !== null &&
        sampleRate >= 88200 &&
        hfExtentHz !== null &&
        hfExtentHz < 0.6 * (sampleRate / 2)
    ) {
        findings.push({
            hfExtentHz,
            kind: 'bandwidth-extent',
            nominalNyquistHz: sampleRate / 2,
        });
    }

    return findings;
}

export function deriveAnalysisResult(input: DeriveAnalysisInput): AnalysisResult {
    const { analyzedAt, astats, ebur128, rolloff, source } = input;
    const samplePeakDbfs = astats?.peakLevelDb ?? null;
    const rmsDbfs = astats?.rmsLevelDb ?? null;
    const noiseFloorDbfs = astats?.noiseFloorDb ?? null;

    const measurements: AnalysisMeasurements = {
        crestFactorDb:
            samplePeakDbfs !== null && rmsDbfs !== null ? samplePeakDbfs - rmsDbfs : null,
        dcOffset: astats?.dcOffset ?? null,
        effectiveBitDepth: effectiveBitDepthFrom(samplePeakDbfs, noiseFloorDbfs),
        hfExtentHz: rolloff.medianHz,
        hfExtentP90Hz: rolloff.p90Hz,
        loudnessLufs: ebur128?.integratedLufs ?? null,
        loudnessRangeLu: ebur128?.loudnessRangeLu ?? null,
        noiseFloorDbfs,
        rmsDbfs,
        samplePeakDbfs,
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
    if (!Number.isFinite(dynamicRangeDb) || dynamicRangeDb < 6.02) {
        return null;
    }

    return Math.max(1, Math.min(32, Math.round(dynamicRangeDb / 6.02)));
}
