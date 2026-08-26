import type { SourceDeclaration } from './formats';
import type { ReplayGainMode } from './policy';
import type { PlaybackPolicy } from './policy';
import type { AudioEngineEvent } from './snapshot';
import type { AudioSnapshot } from './snapshot';

import { audioEventSeverity } from './event-log';
import { redactUrlsInText } from './server-route';

export interface DiagnosticsInputs {
    events: AudioEngineEvent[];
    policy: PlaybackPolicy;
    replayGainMode: ReplayGainMode;
    snapshot: AudioSnapshot | null;
    source: null | SourceDeclaration;
}

const EVENT_TAIL_LIMIT = 50;

/**
 * Composes a complete, secrets-scrubbed plain-text diagnostics report for the
 * playing track. Every fact degrades to "unknown"; URLs pass through
 * redaction even if a caller forgot to scrub them.
 */
export function buildDiagnosticsReport(inputs: DiagnosticsInputs): string {
    const { events, policy, replayGainMode, snapshot, source } = inputs;
    const lines: string[] = [
        'Feishin stream diagnostics',
        `Generated: ${new Date().toISOString()}`,
        `policy: ${policy} | replaygain mode: ${replayGainMode}`,
    ];

    lines.push('', '[source]');
    lines.push(`declared: ${formatSource(source)}`);
    lines.push(`stream url: ${value(snapshot?.streamUrl ?? null)}`);

    lines.push('', '[server route]');
    const route = snapshot?.serverRoute;
    lines.push(
        route
            ? `route: ${route.route} (${route.verification}) [${route.level}]`
            : 'route: unverified [unknown]',
    );
    if (route?.detail) {
        lines.push(`mismatches: ${redactUrlsInText(route.detail)}`);
    }

    lines.push('', '[decoder]');
    const demuxer = snapshot?.demuxer;
    lines.push(
        demuxer
            ? `demuxer: ${demuxer.codec ?? 'unknown'} @ ${demuxer.samplerate ?? 'unknown'} Hz ${demuxer.channels ?? '?'}ch`
            : 'demuxer: unknown',
    );
    lines.push(`decoded: ${formatParams(snapshot?.decodedParams ?? null)}`);

    lines.push('', '[processing]');
    const filters = snapshot?.activeFilters;
    lines.push(
        `af: ${filters === null || filters === undefined ? 'unknown' : filters.length > 0 ? filters.join(', ') : 'none'}`,
    );
    const volume = snapshot?.volume;
    const muted = snapshot?.muted;
    lines.push(
        `volume: ${volume === null || volume === undefined ? 'unknown' : `${volume}%${muted ? ' (muted)' : ''}`} | speed: ${snapshot?.speed ?? 'unknown'}x`,
    );

    lines.push('', '[output]');
    lines.push(`ao: ${value(snapshot?.aoDriver)}`);
    lines.push(`out params: ${formatParams(snapshot?.outputParams ?? null)}`);
    lines.push(`device: ${value(snapshot?.audioDevice)}`);
    const physical = snapshot?.physicalFormat;
    lines.push(
        physical
            ? `physical format: ${physical.value} (${physical.level})`
            : 'physical format: unknown',
    );

    lines.push('', '[cache]');
    lines.push(
        `eof-reaching: ${snapshot?.cacheEofReaching ?? '-'} | idle: ${snapshot?.cacheIdle ?? '-'} | underrun: ${snapshot?.cacheUnderrun ?? '-'}`,
    );
    lines.push(`gapless-audio: ${value(snapshot?.gaplessAudio)}`);

    lines.push('', '[events]');
    const tail = events.slice(-EVENT_TAIL_LIMIT);
    if (tail.length === 0) {
        lines.push('none');
    } else {
        lines.push(`(last ${tail.length})`);
    }
    for (const event of tail) {
        const time = new Date(event.time).toISOString();
        const detail = event.detail ? redactUrlsInText(event.detail) : '';
        lines.push(
            `#${event.id} ${time} [${audioEventSeverity(event.type)}] ${event.type}${detail ? `: ${detail}` : ''}`,
        );
    }

    // Defense in depth: nothing credential-shaped survives serialization.
    return redactUrlsInText(lines.join('\n'));
}

function formatParams(
    params: null | { channels: null | number; format: null | string; samplerate: null | number },
): string {
    if (!params) {
        return 'unknown';
    }
    return [
        params.format ?? 'unknown',
        params.samplerate !== null ? `${params.samplerate} Hz` : null,
        params.channels !== null ? `${params.channels}ch` : null,
    ]
        .filter((part): part is string => part !== null)
        .join(' / ');
}

function formatSource(source: null | SourceDeclaration): string {
    if (!source) {
        return 'unknown';
    }
    const parts = [
        source.codec,
        source.samplingRate !== null ? `${source.samplingRate} Hz` : null,
        source.bitDepth !== null ? `${source.bitDepth}-bit` : null,
        source.channelCount !== null ? `${source.channelCount}ch` : null,
        source.lossless ? 'lossless' : 'lossy',
    ].filter((part): part is string => part !== null);
    return parts.join(' / ');
}

function value(part: null | string | undefined): string {
    return part === null || part === undefined || part === '' ? 'unknown' : part;
}
