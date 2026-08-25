export const CONFIDENCE_LEVELS = ['confirmed', 'requested', 'inferred', 'unknown'] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface Evidence<T> {
    level: ConfidenceLevel;
    source: string;
    value: T;
}

export function evidence<T>(value: T, level: ConfidenceLevel, source: string): Evidence<T> {
    return { level, source, value };
}

export function isConfirmed<T>(item: Evidence<T> | null | undefined): boolean {
    return item !== undefined && item !== null && item.level === 'confirmed';
}

export function isKnown<T>(item: Evidence<T> | null | undefined): item is Evidence<T> {
    return item !== undefined && item !== null && item.level !== 'unknown';
}

export function weakestLevel(...levels: ConfidenceLevel[]): ConfidenceLevel {
    if (levels.includes('unknown')) {
        return 'unknown';
    }
    if (levels.includes('inferred')) {
        return 'inferred';
    }
    if (levels.includes('requested')) {
        return 'requested';
    }
    return 'confirmed';
}
