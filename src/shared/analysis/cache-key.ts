import { ANALYSIS_SCHEMA_VERSION } from './types';

/**
 * Cache identity of one analyzed source revision. Servers disagree on what
 * revision metadata they expose (Subsonic songs only carry a creation date,
 * Navidrome songs a real updatedAt), so every available hint is part of the
 * key: a size, creation date, or modification date change re-analyzes.
 */
export function analysisCacheKey(input: {
    createdAt?: null | string;
    serverId: string;
    size?: null | number;
    songId: string;
    updatedAt?: null | string;
}): string {
    return [
        `v${ANALYSIS_SCHEMA_VERSION}`,
        encodeURIComponent(input.serverId),
        encodeURIComponent(input.songId),
        input.size ?? '-',
        encodeURIComponent(input.updatedAt || '-'),
        encodeURIComponent(input.createdAt || '-'),
    ].join(':');
}
