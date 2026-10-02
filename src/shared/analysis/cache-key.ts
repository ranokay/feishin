import { ANALYSIS_SCHEMA_VERSION } from './types';

/**
 * Cache identity of one analyzed source revision: same server track at the
 * same size and modified date hits the cache, anything else re-analyzes.
 */
export function analysisCacheKey(input: {
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
        encodeURIComponent(input.updatedAt ?? '-'),
    ].join(':');
}
