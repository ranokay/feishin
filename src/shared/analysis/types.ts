export const ANALYSIS_SCHEMA_VERSION = 1;

export type AnalysisAvailability =
    | { available: false; reason: 'missing-ffmpeg' | 'missing-ffprobe' }
    | {
          available: true;
          ffmpegPath: string;
          ffprobePath: string;
      };

export type AnalysisFinding =
    | {
          effectiveBitDepth: number;
          kind: 'effective-resolution';
          noiseFloorDbfs: number;
          nominalBitDepth: number;
      }
    | {
          hfExtentHz: number;
          kind: 'bandwidth-extent';
          nominalNyquistHz: number;
      };

export interface AnalysisMeasurements {
    crestFactorDb: null | number;
    dcOffset: null | number;
    effectiveBitDepth: null | number;
    hfExtentHz: null | number;
    loudnessLufs: null | number;
    loudnessRangeLu: null | number;
    noiseFloorDbfs: null | number;
    rmsDbfs: null | number;
    samplePeakDbfs: null | number;
    truePeakDbfs: null | number;
}

/**
 * Renderer-built request for one offline analysis run. The URL is a raw/direct
 * stream URL produced by the same builders LOCAL playback uses; the main
 * process never rebuilds it, so server credentials stay in the renderer.
 */
export interface AnalysisRequest {
    label?: string;
    url: string;
}

export type AnalysisResponse =
    | { message: string; status: 'error' }
    | { reason: 'missing-ffmpeg' | 'missing-ffprobe'; status: 'unavailable' }
    | { result: AnalysisResult; status: 'ok' }
    | { status: 'busy' }
    | { status: 'cancelled' };

export interface AnalysisResult {
    analyzedAt: string;
    findings: AnalysisFinding[];
    measurements: AnalysisMeasurements;
    schemaVersion: number;
    source: AnalysisSourceInfo;
}

export interface AnalysisSourceInfo {
    bitDepth: null | number;
    channels: null | number;
    codec: null | string;
    container: null | string;
    durationSec: null | number;
    sampleRate: null | number;
}
