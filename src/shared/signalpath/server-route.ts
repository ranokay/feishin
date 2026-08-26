import type { ConfidenceLevel } from './evidence';

/**
 * Server-route verification: did the server return the original file bytes for
 * the playing track, or a transcode? Combines cheap HTTP header inspection
 * against the library declaration with mpv's demuxer-reported codec/rate as a
 * cross-check that catches cached transcodes mimicking raw headers.
 */
export interface DemuxerObservation {
    channels: null | number;
    codec: null | string;
    samplerate: null | number;
}

export interface ServerRouteEvidence {
    /** Human-readable mismatch reasons; null when no contradiction was found. */
    detail: null | string;
    level: ConfidenceLevel;
    route: 'direct-stream' | 'transcoded' | 'unverified';
    verification: 'header-match' | 'metadata-match' | 'size-match' | 'unverified';
}

/** Renderer -> main request to verify the route of the currently playing stream. */
export interface ServerVerificationRequest {
    declaration: SourceStreamDeclaration;
    url: string;
}

export interface SourceStreamDeclaration {
    bitDepth: null | number;
    channels: null | number;
    container: null | string;
    sampleRate: null | number;
    sizeBytes: null | number;
}

export interface StreamHeaderProbe {
    acceptRanges: null | string;
    /** Full-entity byte length when derivable (Content-Length or Content-Range total). */
    contentLength: null | number;
    contentType: null | string;
}

// Servers label the same container differently across backends; both directions
// of each alias pair must pass so honest responses are never flagged.
const MIME_SUBTYPES_BY_CONTAINER: Record<string, string[]> = {
    aac: ['aac', 'm4a', 'mp4'],
    aiff: ['aiff', 'x-aiff'],
    alac: ['alac', 'm4a', 'mp4'],
    dsf: ['dsf', 'x-dsf'],
    flac: ['flac', 'x-flac'],
    m4a: ['m4a', 'mp4'],
    mp3: ['mp3', 'mpeg'],
    ogg: ['ogg'],
    opus: ['ogg', 'opus'],
    wav: ['wav', 'wave', 'x-wav'],
    wma: ['asf', 'ms-wma', 'x-ms-wma'],
};

const CONTAINERS_BY_CODEC: Record<string, string[]> = {
    aac: ['aac', 'm4a', 'mp4'],
    alac: ['alac', 'm4a', 'mp4'],
    flac: ['flac'],
    mp3: ['mp3'],
    opus: ['ogg', 'opus'],
    vorbis: ['ogg'],
};

export function evaluateServerRoute(input: {
    demuxer?: DemuxerObservation | null;
    headers?: null | StreamHeaderProbe;
    source: SourceStreamDeclaration;
}): ServerRouteEvidence {
    const { demuxer, headers, source } = input;
    const mismatches: string[] = [];

    if (headers) {
        const expectedSubtypes = source.container
            ? (MIME_SUBTYPES_BY_CONTAINER[source.container.toLowerCase()] ?? [
                  source.container.toLowerCase(),
              ])
            : null;
        const actualSubtype = mimeSubtype(headers.contentType);
        if (expectedSubtypes && actualSubtype && !expectedSubtypes.includes(actualSubtype)) {
            mismatches.push(
                `content-type ${headers.contentType} does not match declared .${source.container}`,
            );
        }

        if (
            source.sizeBytes !== null &&
            headers.contentLength !== null &&
            headers.contentLength !== source.sizeBytes
        ) {
            mismatches.push(
                `content-length ${headers.contentLength} differs from declared size ${source.sizeBytes}`,
            );
        }

        // Chunked transcode signature: no length announced and ranges refused,
        // while the library says there is a concrete file to serve.
        if (
            source.sizeBytes !== null &&
            headers.contentLength === null &&
            headers.acceptRanges !== 'bytes'
        ) {
            mismatches.push('no content-length and range requests unsupported');
        }
    }

    if (demuxer?.codec && source.container) {
        if (!codecMatchesContainer(demuxer.codec, source.container)) {
            mismatches.push(
                `stream decodes as ${demuxer.codec} but library declares .${source.container}`,
            );
        }
    }

    if (demuxer?.samplerate !== null && demuxer?.samplerate !== undefined) {
        if (source.sampleRate !== null && demuxer.samplerate !== source.sampleRate) {
            mismatches.push(
                `stream rate ${demuxer.samplerate} differs from declared ${source.sampleRate}`,
            );
        }
    }

    if (mismatches.length > 0) {
        return {
            detail: mismatches.join('; '),
            level: 'confirmed',
            route: 'transcoded',
            // A failed check is not a positive verification kind.
            verification: 'unverified',
        };
    }

    if (headers && source.sizeBytes !== null && headers.contentLength === source.sizeBytes) {
        return {
            detail: null,
            level: 'confirmed',
            route: 'direct-stream',
            verification: 'size-match',
        };
    }

    // Header consistency is only meaningful when something was actually compared.
    if (headers && source.container && headers.contentType) {
        return {
            detail: null,
            level: 'inferred',
            route: 'direct-stream',
            verification: 'header-match',
        };
    }

    if (demuxer?.codec && source.container) {
        return {
            detail: null,
            level: 'inferred',
            route: 'direct-stream',
            verification: 'metadata-match',
        };
    }

    if (demuxer?.samplerate != null && source.sampleRate != null) {
        return {
            detail: null,
            level: 'inferred',
            route: 'direct-stream',
            verification: 'metadata-match',
        };
    }

    return { detail: null, level: 'unknown', route: 'unverified', verification: 'unverified' };
}

function codecMatchesContainer(codec: string, container: string): boolean {
    const normalized = container.toLowerCase();
    if (codec.startsWith('pcm_')) {
        return ['aif', 'aiff', 'w64', 'wav'].includes(normalized);
    }
    return (CONTAINERS_BY_CODEC[codec] ?? [codec]).includes(normalized);
}

// Query params whose values are safe (and useful) in diagnostics output.
const SAFE_QUERY_PARAMS = new Set([
    'audioCodec',
    'c',
    'container',
    'format',
    'getTranscodeInfo',
    'id',
    'maxBitRate',
    'mediaType',
    'offset',
    'skipAutoTranscode',
    'static',
    'transcode',
    'transcodingContainer',
    'v',
]);

/**
 * Strips credential-bearing query values from a stream URL while keeping the
 * shape that matters for diagnosis: origin, path, and safe param names/values.
 */
export function redactStreamUrl(url: string): string {
    const queryStart = url.indexOf('?');
    if (queryStart === -1) {
        return redactUserInfo(url);
    }
    const base = redactUserInfo(url.slice(0, queryStart));
    const query = url.slice(queryStart + 1);
    const redacted = query.split('&').map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) {
            return pair;
        }
        const key = pair.slice(0, eq);
        return SAFE_QUERY_PARAMS.has(key) ? pair : `${key}=<redacted>`;
    });
    return `${base}?${redacted.join('&')}`;
}

/** Redacts every http(s) URL found inside free-form text (event details etc). */
export function redactUrlsInText(text: string): string {
    return text.replace(/https?:\/\/[^\s;)]+/g, (match) => redactStreamUrl(match));
}

function mimeSubtype(contentType: null | string): null | string {
    if (!contentType) {
        return null;
    }
    const subtype = contentType.split(';')[0].trim().split('/')[1];
    return subtype ? subtype.toLowerCase() : null;
}

// HTTP userinfo (https://user:password@host) must never survive into
// diagnostics output or snapshot broadcasts.
function redactUserInfo(base: string): string {
    return base.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/\s]+)@/i, '$1<redacted>@');
}
