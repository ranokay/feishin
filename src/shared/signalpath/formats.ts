export type PcmFormat = 'double' | 'float' | 's8' | 's16' | 's24' | 's32' | 'u8';

const FORMAT_CAPACITY_BITS: Record<PcmFormat, number> = {
    double: 53,
    float: 25,
    s8: 8,
    s16: 16,
    s24: 24,
    s32: 32,
    u8: 8,
};

export interface DecodedParams {
    channels: null | number;
    format: null | string;
    samplerate: null | number;
}

export type FormatRelation = 'incomparable' | 'narrowing' | 'same' | 'widening';

export interface OutputParams extends DecodedParams {}

export interface SourceDeclaration {
    bitDepth: null | number;
    channelCount: null | number;
    codec: string;
    lossless: boolean | null;
    pcmOrDsd: 'dsd' | 'pcm' | 'unknown';
    samplingRate: null | number;
}

export function compareFormats(from: string, to: string): FormatRelation {
    if (!isKnownPcmFormat(from) || !isKnownPcmFormat(to)) {
        return 'incomparable';
    }
    if (from === to) {
        return 'same';
    }
    const fromCapacity = FORMAT_CAPACITY_BITS[from];
    const toCapacity = FORMAT_CAPACITY_BITS[to];
    if (toCapacity >= fromCapacity) {
        return 'widening';
    }
    return 'narrowing';
}

export function isDepthWidening(
    sourceBitDepth: null | number,
    outputFormat: null | string,
): boolean {
    if (sourceBitDepth === null || outputFormat === null || !isKnownPcmFormat(outputFormat)) {
        return false;
    }
    return FORMAT_CAPACITY_BITS[outputFormat] >= sourceBitDepth;
}

export function isKnownPcmFormat(format: string): format is PcmFormat {
    return format in FORMAT_CAPACITY_BITS;
}

export function isPrecisionPreserving(from: string, to: string): boolean {
    const relation = compareFormats(from, to);
    return relation === 'same' || relation === 'widening';
}
