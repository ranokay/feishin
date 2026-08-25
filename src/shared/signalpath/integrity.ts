import type { ConfidenceLevel } from './evidence';
import type { DecodedParams, OutputParams, SourceDeclaration } from './formats';

import { isPrecisionPreserving } from './formats';

export const EXCLUSIVE_DRIVERS = ['coreaudio_exclusive', 'wasapi', 'pipewire'] as const;

export interface IntegrityObservation {
    activeUserFilters: string[];
    declaredSource: null | SourceDeclaration;
    decodedParams: DecodedParams | null;
    filterEvidenceLevel: ConfidenceLevel;
    outputParams: null | OutputParams;
    route: string;
    routeEvidenceLevel: ConfidenceLevel;
    serverRoute: 'direct-stream' | 'transcoded' | 'unknown' | 'unverified';
    serverRouteEvidenceLevel: ConfidenceLevel;
}

export type IntegrityStatus =
    | 'bit-perfect-eligible'
    | 'bit-perfect-verified'
    | 'exclusive-processed'
    | 'lossy-source'
    | 'processed'
    | 'resampled'
    | 'transcoded'
    | 'unknown'
    | 'unprocessed-shared';

export interface IntegrityVerdict {
    detail: string[];
    missingEvidence: string[];
    status: IntegrityStatus;
}

export function evaluateIntegrity(observation: IntegrityObservation): IntegrityVerdict {
    const detail: string[] = [];
    const missingEvidence: string[] = [];

    if (!observation.declaredSource || !observation.decodedParams) {
        return { detail, missingEvidence: ['source', 'decoder'], status: 'unknown' };
    }
    const source = observation.declaredSource;

    if (observation.serverRoute === 'transcoded') {
        return { detail, missingEvidence, status: 'transcoded' };
    }
    if (source.lossless === false) {
        return { detail, missingEvidence, status: 'lossy-source' };
    }

    if (!observation.outputParams) {
        missingEvidence.push('output');
    }

    const processing = collectProcessing(observation, detail);
    const resample = detectResampling(observation, detail);
    if (resample !== null && processing.length === 0) {
        return { detail, missingEvidence, status: 'resampled' };
    }

    if (processing.length > 0 || resample !== null) {
        const exclusiveActive = isExclusiveRoute(observation.route);
        return {
            detail,
            missingEvidence,
            status: exclusiveActive ? 'exclusive-processed' : 'processed',
        };
    }

    if (missingEvidence.length > 0) {
        return { detail, missingEvidence, status: 'unknown' };
    }

    if (!isExclusiveRoute(observation.route)) {
        return { detail, missingEvidence, status: 'unprocessed-shared' };
    }

    const pendingConfirmation = collectPendingConfirmation(observation);
    if (pendingConfirmation.length > 0) {
        return { detail, missingEvidence: pendingConfirmation, status: 'bit-perfect-eligible' };
    }
    return { detail, missingEvidence, status: 'bit-perfect-verified' };
}

function collectPendingConfirmation(observation: IntegrityObservation): string[] {
    const pending: string[] = [];
    const criticalLevels: Array<[string, ConfidenceLevel]> = [
        ['route', observation.routeEvidenceLevel],
        ['server-route', observation.serverRouteEvidenceLevel],
        ['filters', observation.filterEvidenceLevel],
    ];
    for (const [name, level] of criticalLevels) {
        if (level !== 'confirmed') {
            pending.push(name);
        }
    }
    return pending;
}

function collectProcessing(observation: IntegrityObservation, detail: string[]): string[] {
    const processing: string[] = [];
    if (observation.activeUserFilters.length > 0) {
        processing.push('filters');
        detail.push(`active filters: ${observation.activeUserFilters.join(', ')}`);
    }
    if (observation.decodedParams && observation.outputParams) {
        const from = observation.decodedParams.format;
        const to = observation.outputParams.format;
        if (from && to && !isPrecisionPreserving(from, to)) {
            processing.push('format-conversion');
            detail.push(`precision-altering conversion ${from} -> ${to}`);
        }
        if (
            observation.decodedParams.channels !== null &&
            observation.outputParams.channels !== null &&
            observation.decodedParams.channels !== observation.outputParams.channels
        ) {
            processing.push('channel-conversion');
            detail.push(
                `channel conversion ${observation.decodedParams.channels} -> ${observation.outputParams.channels}`,
            );
        }
    }
    if (sourceIsDsd(observation)) {
        processing.push('dsd-to-pcm-conversion');
        detail.push('DSD converted to PCM (dsd2pcm)');
    }
    return processing;
}

function detectResampling(observation: IntegrityObservation, detail: string[]): null | number {
    const declaredRate = observation.declaredSource?.samplingRate ?? null;
    const decodedRate = observation.decodedParams?.samplerate ?? null;
    const outputRate = observation.outputParams?.samplerate ?? null;
    if (decodedRate !== null && outputRate !== null && decodedRate !== outputRate) {
        detail.push(`rate change decoder -> output: ${decodedRate} -> ${outputRate}`);
        return decodedRate;
    }
    if (declaredRate !== null && decodedRate !== null && declaredRate !== decodedRate) {
        detail.push(`rate mismatch source -> decoder: ${declaredRate} -> ${decodedRate}`);
        return declaredRate;
    }
    return null;
}

function isExclusiveRoute(route: string): boolean {
    if (route === 'alsa-hw') {
        return true;
    }
    return route.endsWith('-exclusive') || (EXCLUSIVE_DRIVERS as readonly string[]).includes(route);
}

function sourceIsDsd(observation: IntegrityObservation): boolean {
    return observation.declaredSource?.pcmOrDsd === 'dsd';
}
