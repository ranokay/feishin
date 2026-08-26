import type { ConfidenceLevel } from './evidence';
import type { DecodedParams, SourceDeclaration } from './formats';
import type { PlaybackPolicy } from './policy';
import type { ReplayGainMode } from './policy';
import type { AudioSnapshot } from './snapshot';

import { weakestLevel } from './evidence';
import { isPrecisionPreserving } from './formats';
import { evaluateIntegrity, type IntegrityVerdict } from './integrity';

export interface ProcessingEntry {
    detail: null | string;
    kind: ProcessingKind;
    level: ConfidenceLevel;
}

export type ProcessingKind =
    | 'channel-map'
    | 'declared-decode'
    | 'filter'
    | 'format-conversion'
    | 'gain'
    | 'replaygain'
    | 'resample'
    | 'tempo';

export interface SignalPathInputs {
    policy: PlaybackPolicy;
    replayGainMode: ReplayGainMode;
    snapshot: AudioSnapshot | null;
    source: null | SourceDeclaration;
}

export interface SignalPathItem {
    detail: null | string;
    level: ConfidenceLevel;
    value: null | string;
}

export interface SignalPathModel {
    decoder: SignalPathItem;
    device: SignalPathItem;
    integrity: IntegrityVerdict;
    output: SignalPathItem;
    physicalFormat: AudioSnapshot['physicalFormat'];
    processing: ProcessingEntry[];
    /** Evidence tier for the DSP row itself: unknown while the af chain is unobserved. */
    processingEvidence: ConfidenceLevel;
    requestedExclusive: boolean;
    server: SignalPathItem;
    source: SignalPathItem;
}

const LOSSLESS_CONTAINERS = new Set(['aiff', 'alac', 'ape', 'flac', 'shn', 'wav', 'wv']);
const DSD_CONTAINERS = new Set(['dff', 'dsf']);
// Containers that are definitively lossy; anything else unknown stays unknown
// instead of producing a false lossy-source verdict (e.g. ALAC inside m4a,
// which is deliberately treated as unknown fidelity and gated at eligible).
const KNOWN_LOSSY_CONTAINERS = new Set(['aac', 'mp3', 'ogg', 'opus', 'wma']);

export function declareSource(song: {
    bitDepth: null | number;
    channels: null | number;
    container: null | string;
    sampleRate: null | number;
}): null | SourceDeclaration {
    if (!song.container) {
        return null;
    }
    const codec = normalizeContainer(song.container);
    const lossless = LOSSLESS_CONTAINERS.has(codec)
        ? true
        : KNOWN_LOSSY_CONTAINERS.has(codec)
          ? false
          : null;
    return {
        bitDepth: song.bitDepth ?? null,
        channelCount: song.channels ?? null,
        codec,
        lossless,
        pcmOrDsd: DSD_CONTAINERS.has(codec) ? 'dsd' : 'pcm',
        samplingRate: song.sampleRate ?? null,
    };
}

function collectProcessing(
    replayGainMode: ReplayGainMode,
    snapshot: AudioSnapshot,
    source: null | SourceDeclaration,
): ProcessingEntry[] {
    const processing: ProcessingEntry[] = [];

    if (snapshot.volume !== null && (snapshot.muted || snapshot.volume !== 100)) {
        processing.push({
            detail: snapshot.muted ? 'muted' : `${snapshot.volume}%`,
            kind: 'gain',
            level: 'confirmed',
        });
    }

    if (replayGainMode !== 'no') {
        processing.push({
            detail: replayGainMode,
            kind: 'replaygain',
            // Configured by us; mpv does not expose the applied gain as a property.
            level: 'requested',
        });
    }

    for (const filter of snapshot.activeFilters ?? []) {
        processing.push({ detail: filter, kind: 'filter', level: 'confirmed' });
    }

    if (snapshot.speed !== null && snapshot.speed !== 1) {
        processing.push({
            detail: `${snapshot.speed}x`,
            kind: 'tempo',
            level: 'confirmed',
        });
    }

    const { decodedParams, outputParams } = snapshot;
    if (decodedParams && outputParams) {
        if (
            decodedParams.format &&
            outputParams.format &&
            !isPrecisionPreserving(decodedParams.format, outputParams.format)
        ) {
            processing.push({
                detail: `${decodedParams.format} -> ${outputParams.format}`,
                kind: 'format-conversion',
                level: 'confirmed',
            });
        }
        if (
            decodedParams.channels !== null &&
            outputParams.channels !== null &&
            decodedParams.channels !== outputParams.channels
        ) {
            processing.push({
                detail: `${decodedParams.channels}ch -> ${outputParams.channels}ch`,
                kind: 'channel-map',
                level: 'confirmed',
            });
        }
        if (
            decodedParams.samplerate !== null &&
            outputParams.samplerate !== null &&
            decodedParams.samplerate !== outputParams.samplerate
        ) {
            processing.push({
                detail: `${decodedParams.samplerate} Hz -> ${outputParams.samplerate} Hz`,
                kind: 'resample',
                level: 'confirmed',
            });
        }
    }

    if (source?.pcmOrDsd === 'dsd') {
        processing.push({
            detail: 'dsd2pcm',
            kind: 'declared-decode',
            level: 'inferred',
        });
    }

    return processing;
}

function normalizeContainer(container: string): string {
    const lowered = container.trim().toLowerCase();
    // Servers emit mime subtypes like x-flac / x-wav for ordinary containers.
    return lowered.startsWith('x-') ? lowered.slice(2) : lowered;
}

const UNKNOWN_ITEM: SignalPathItem = { detail: null, level: 'unknown', value: null };

export function buildSignalPathModel(inputs: SignalPathInputs): SignalPathModel {
    const { policy, replayGainMode, snapshot, source } = inputs;
    const requestedExclusive = policy === 'bit-perfect' || policy === 'exclusive';

    if (!snapshot) {
        return {
            decoder: UNKNOWN_ITEM,
            device: UNKNOWN_ITEM,
            integrity: { detail: [], missingEvidence: ['engine'], status: 'unknown' },
            output: UNKNOWN_ITEM,
            physicalFormat: null,
            processing: [],
            processingEvidence: 'unknown',
            requestedExclusive,
            server: UNKNOWN_ITEM,
            source: UNKNOWN_ITEM,
        };
    }

    const processing = collectProcessing(replayGainMode, snapshot, source);

    const serverRoute = snapshot.serverRoute ?? null;

    const integrity = evaluateIntegrity({
        activeUserFilters: snapshot.activeFilters ?? [],
        declaredSource: source,
        decodedParams: snapshot.decodedParams,
        filterEvidenceLevel: snapshot.activeFilters === null ? 'unknown' : 'confirmed',
        outputParams: snapshot.outputParams,
        route: snapshot.aoDriver ?? '',
        routeEvidenceLevel: snapshot.aoDriver === null ? 'unknown' : 'confirmed',
        serverRoute: serverRoute?.route ?? 'unverified',
        serverRouteEvidenceLevel: serverRoute?.level ?? 'unknown',
        softwareProcessing: processing
            .filter(
                (entry): entry is typeof entry & { detail: string } =>
                    (entry.kind === 'gain' ||
                        entry.kind === 'replaygain' ||
                        entry.kind === 'tempo') &&
                    entry.detail !== null,
            )
            .map((entry) => ({ detail: `${entry.kind} ${entry.detail}`, kind: entry.kind })),
    });

    return {
        decoder: snapshot.decodedParams
            ? {
                  detail: formatParams(snapshot.decodedParams),
                  level: 'confirmed',
                  value: 'decoded',
              }
            : UNKNOWN_ITEM,
        device: {
            detail: snapshot.physicalFormat?.value ?? null,
            level:
                snapshot.audioDevice === null && snapshot.physicalFormat === null
                    ? 'unknown'
                    : weakestLevel(
                          ...(snapshot.audioDevice !== null ? (['confirmed'] as const) : []),
                          ...(snapshot.physicalFormat !== null
                              ? [snapshot.physicalFormat.level]
                              : []),
                      ),
            value: snapshot.audioDevice,
        },
        integrity,
        output: snapshot.aoDriver
            ? { detail: null, level: 'confirmed', value: snapshot.aoDriver }
            : UNKNOWN_ITEM,
        physicalFormat: snapshot.physicalFormat,
        processing,
        processingEvidence:
            snapshot.activeFilters === null || snapshot.activeFilters === undefined
                ? 'unknown'
                : 'confirmed',
        requestedExclusive,
        server: serverRoute
            ? {
                  detail: serverRoute.route === 'transcoded' ? serverRoute.detail : null,
                  level: serverRoute.level,
                  value: serverRoute.route,
              }
            : // No probe result for this track yet: honest unverified placeholder.
              { detail: null, level: 'unknown', value: 'unverified' },
        source: source
            ? {
                  detail: [
                      source.codec,
                      source.samplingRate !== null ? `${source.samplingRate} Hz` : null,
                      source.bitDepth !== null ? `${source.bitDepth}-bit` : null,
                      source.channelCount !== null ? `${source.channelCount}ch` : null,
                  ]
                      .filter((part): part is string => part !== null)
                      .join(' / '),
                  level: 'inferred',
                  value: source.codec,
              }
            : UNKNOWN_ITEM,
    };
}

function formatParams(params: DecodedParams): string {
    const parts = [
        params.format,
        params.samplerate !== null ? `${params.samplerate} Hz` : null,
        params.channels !== null ? `${params.channels}ch` : null,
    ].filter((part): part is string => part !== null);
    return parts.join(' / ');
}
