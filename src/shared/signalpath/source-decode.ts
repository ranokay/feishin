export interface SourceDecodeOptions {
    deEmphasis: boolean;
    hdcd: boolean;
}

export const DEFAULT_SOURCE_DECODE_OPTIONS: SourceDecodeOptions = {
    deEmphasis: false,
    hdcd: false,
};

export type SourceDecodeFilter = 'deEmphasis' | 'hdcd';

/** hdcd reconstructs 20-bit samples; outputs below that capacity truncate the expansion. */
export const HDCD_EXPANDED_BIT_DEPTH = 20;

// Tag keys that declare a CD emphasis flag, normalized by stripping
// punctuation: "pre-emphasis", "PREEMPHASIS", and "pre_emphasis" all match.
const DE_EMPHASIS_TAG_KEYS = new Set([
    'cddeemphasis',
    'cdpreemphasis',
    'deemphasis',
    'preemphasis',
]);

const FALSEY_TAG_VALUES = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Classifies an observed mpv `af` entry (as reported by the audio state
 * service, e.g. `lavfi:hdcd`). Only the exact CD curve counts as de-emphasis;
 * other aemphasis types are ordinary user DSP.
 */
export function classifySourceDecodeFilter(filter: string): null | SourceDecodeFilter {
    const normalized = filter.trim().toLowerCase();
    if (normalized === 'lavfi:hdcd' || normalized.startsWith('lavfi:hdcd=')) {
        return 'hdcd';
    }
    const aemphasisPrefix = 'lavfi:aemphasis=';
    if (normalized.startsWith(aemphasisPrefix)) {
        const args = normalized.slice(aemphasisPrefix.length).split(':');
        if (args.includes('type=cd')) {
            return 'deEmphasis';
        }
    }
    return null;
}

/**
 * Navidrome's native API surfaces arbitrary file tags; a truthy pre-emphasis /
 * de-emphasis tag is the only source-side declaration this filter can consume.
 */
export function declaresDeEmphasis(tags: null | Record<string, string[]> | undefined): boolean {
    if (!tags) {
        return false;
    }
    for (const [key, values] of Object.entries(tags)) {
        if (!DE_EMPHASIS_TAG_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
            continue;
        }
        if (values.some((value) => !FALSEY_TAG_VALUES.has(value.trim().toLowerCase()))) {
            return true;
        }
    }
    return false;
}

/**
 * Names one observed mpv `af` entry. mpv reports graph filters as
 * `{name:'lavfi', params:{graph:'hdcd'}}`; the graph string carries the actual
 * filter identity, so it is part of the name.
 */
export function describeAfEntry(filter: unknown): string {
    if (typeof filter === 'string') {
        return filter;
    }
    if (!isRecord(filter)) {
        return String(filter ?? '');
    }
    const name = typeof filter['name'] === 'string' ? filter['name'] : '';
    const params = filter['params'];
    const graph =
        isRecord(params) && typeof params['graph'] === 'string' ? params['graph'].trim() : '';
    if (graph.length > 0) {
        return name.length > 0 ? `${name}:${graph}` : graph;
    }
    if (name.length > 0) {
        return name;
    }
    // An unrecognized shape must still count as a live entry; dropping it would
    // let a non-empty chain read as clean.
    return JSON.stringify(filter) ?? '';
}

export function isSourceDecodeActive(options: SourceDecodeOptions): boolean {
    return options.hdcd || options.deEmphasis;
}

export function normalizeSourceDecodeOptions(value: unknown): SourceDecodeOptions {
    if (!isRecord(value)) {
        return { ...DEFAULT_SOURCE_DECODE_OPTIONS };
    }
    return {
        deEmphasis: value['deEmphasis'] === true,
        hdcd: value['hdcd'] === true,
    };
}

/** mpv `af` entries for the opted source-faithful decodes, in decode order. */
export function sourceDecodeFilterEntries(options: SourceDecodeOptions): string[] {
    const entries: string[] = [];
    if (options.hdcd) {
        entries.push('lavfi=[hdcd]');
    }
    if (options.deEmphasis) {
        entries.push('lavfi=[aemphasis=type=cd]');
    }
    return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
