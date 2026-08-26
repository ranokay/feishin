import type { StreamHeaderProbe } from '/@/shared/signalpath';

import { net } from 'electron';

import log from '/@/main/logger';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Cheap ranged GET that reads only the stream's headers, never the body:
 * Content-Range/Content-Length vs song size, Accept-Ranges, and Content-Type
 * vs the declared container decide whether the server returned original bytes.
 * Returns null on any failure - verification degrades to unknown.
 */
export async function probeStreamHeaders(url: string): Promise<null | StreamHeaderProbe> {
    if (!/^https?:\/\//i.test(url)) {
        return null;
    }
    try {
        const response = await net.fetch(url, {
            headers: { Range: 'bytes=0-1' },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        try {
            await response.body?.cancel();
        } catch {
            // Aborting a streaming body is best-effort.
        }
        if (!response.ok) {
            log.debug(`Stream probe got HTTP ${response.status} for ${redactUrl(url)}`);
            return null;
        }
        return {
            acceptRanges: response.headers.get('accept-ranges'),
            contentLength: readTotalLength(response),
            contentType: response.headers.get('content-type'),
        };
    } catch (error) {
        log.debug(`Stream route probe failed for ${redactUrl(url)}`, error);
        return null;
    }
}

function readTotalLength(response: Response): null | number {
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
        // "bytes 0-1/12345" - the total is what compares against song.size.
        const match = /\/(\d+)\s*$/.exec(contentRange);
        if (match) {
            return Number(match[1]);
        }
        return null;
    }
    const contentLength = Number(response.headers.get('content-length'));
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
}

/** Stream URLs embed auth tokens as query params: never log them whole. */
function redactUrl(url: string): string {
    const queryStart = url.indexOf('?');
    return queryStart === -1 ? url : `${url.slice(0, queryStart)}?...`;
}
