import type { AnalysisSourceInfo } from './types';

export interface FfmpegAstatsOverall {
    dcOffset: null | number;
    noiseFloorDb: null | number;
    peakLevelDb: null | number;
    rmsLevelDb: null | number;
}

export interface FfmpegEbur128Summary {
    integratedLufs: null | number;
    loudnessRangeLu: null | number;
    truePeakDbfs: null | number;
}

export interface FfmpegRolloffSummary {
    frameCount: number;
    medianHz: null | number;
    p90Hz: null | number;
}

/**
 * The final "Overall" block of one `astats` filter. Per-channel blocks carry
 * the same keys, so only lines after the Overall header are read; `-inf`/`nan`
 * values (digital silence, no measurable floor) become null.
 */
export function parseAstatsOverall(stderr: string): FfmpegAstatsOverall | null {
    const lines = stderr.split(/\r?\n/);
    const overallIndex = lines.findIndex((line) => /\]\s+Overall\s*$/.test(line));
    if (overallIndex === -1) {
        return null;
    }

    const values = new Map<string, string>();
    for (const line of lines.slice(overallIndex + 1)) {
        const match = /\]\s+([^:]+):\s*(.+?)\s*$/.exec(line);
        if (match) {
            values.set(match[1], match[2]);
        }
    }

    return {
        dcOffset: readNumber(values.get('DC offset')),
        noiseFloorDb: readNumber(values.get('Noise floor dB')),
        peakLevelDb: readNumber(values.get('Peak level dB')),
        rmsLevelDb: readNumber(values.get('RMS level dB')),
    };
}

export function parseEbur128Summary(stderr: string): FfmpegEbur128Summary | null {
    const summaryIndex = stderr.indexOf('Summary:');
    if (summaryIndex === -1) {
        return null;
    }
    const summary = stderr.slice(summaryIndex);

    const integrated = /^\s*I:\s+(-?[\d.]+)\s+LUFS\s*$/m.exec(summary);
    const range = /^\s*LRA:\s+(-?[\d.]+)\s+LU\s*$/m.exec(summary);
    const truePeak = /^\s*Peak:\s+(-?[\d.]+)\s+dBFS\s*$/m.exec(summary);
    if (!integrated && !range && !truePeak) {
        return null;
    }

    return {
        integratedLufs: readNumber(integrated?.[1]),
        loudnessRangeLu: readNumber(range?.[1]),
        truePeakDbfs: readNumber(truePeak?.[1]),
    };
}

/** ffprobe JSON -> the facts printed by the container/stream headers. */
export function parseFfprobeJson(text: string): AnalysisSourceInfo | null {
    let probe: unknown;
    try {
        probe = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(probe)) {
        return null;
    }

    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    const stream = streams.find((entry) => isRecord(entry) && entry.codec_type === 'audio');
    if (!isRecord(stream)) {
        return null;
    }
    const format = isRecord(probe.format) ? probe.format : {};

    return {
        bitDepth: readInt(stream.bits_per_raw_sample) ?? readInt(stream.bits_per_sample),
        channels: readInt(stream.channels),
        codec: readString(stream.codec_name),
        container: readString(format.format_name),
        durationSec: readNumber(stream.duration) ?? readNumber(format.duration),
        sampleRate: readInt(stream.sample_rate),
        sizeBytes: readInt(format.size),
    };
}

/**
 * `ametadata=print` emits `lavfi.aspectralstats.N.rolloff=<value>` once per
 * frame. Non-finite sample windows (silence) are dropped, not treated as 0 Hz.
 */
export function parseRolloffValues(stdout: string): number[] {
    const values: number[] = [];

    for (const match of stdout.matchAll(/lavfi\.aspectralstats\.\d+\.rolloff=(\S+)/g)) {
        const value = readNumber(match[1]);
        if (value !== null && value > 0) {
            values.push(value);
        }
    }

    return values;
}

/** Median/p90 of the rolloff series stand in for where the HF content ends. */
export function summarizeRolloff(values: number[]): FfmpegRolloffSummary {
    if (values.length === 0) {
        return { frameCount: 0, medianHz: null, p90Hz: null };
    }
    const sorted = [...values].sort((a, b) => a - b);

    return {
        frameCount: sorted.length,
        medianHz: percentile(sorted, 0.5),
        p90Hz: percentile(sorted, 0.9),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function percentile(sorted: number[], fraction: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function readInt(value: unknown): null | number {
    const number = readNumber(value);
    return number === null || !Number.isInteger(number) || number <= 0 ? null : number;
}

function readNumber(value: unknown): null | number {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function readString(value: unknown): null | string {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
