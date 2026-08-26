/**
 * Typed classification of audio-engine failures (AO init failures, error
 * end-files). Classification is pattern-based over mpv log evidence; the
 * cause drives strict-fallback UX and tells the user whether Standard
 * playback policy would resolve the problem.
 */
export const AUDIO_ENGINE_FAILURE_CAUSES = [
    'device-lost',
    'exclusive-contention',
    'unknown',
    'unsupported-format',
    'unsupported-rate',
] as const;

export interface AudioEngineFailure {
    cause: AudioEngineFailureCause;
    /** Raw log/evidence line the classification came from. */
    detail: string;
    explanation: string;
    /** Whether switching to Standard (shared, processed) playback would resolve it. */
    standardWouldHelp: boolean;
}

export type AudioEngineFailureCause = (typeof AUDIO_ENGINE_FAILURE_CAUSES)[number];

const CONTENTION = /hog ?mode|in use by another|another application|device is busy/i;
const RATE_REJECTED = /sample ?rate[^.]*not support|unsupported sample ?rate|no supported rate/i;
const FORMAT_REJECTED = /(format|bit ?depth)[^.]*not support|unsupported (pcm )?format/i;
const DEVICE_LOST = /device (disappeared|was lost|unplugged)|no such device|disconnected/i;

export function classifyAoFailure(logText: string): AudioEngineFailure | null {
    if (!logText) {
        return null;
    }
    const failure = (cause: AudioEngineFailureCause): AudioEngineFailure => ({
        cause,
        detail: logText,
        explanation: EXPLANATIONS[cause],
        standardWouldHelp: STANDARD_WOULD_HELP[cause],
    });

    if (CONTENTION.test(logText)) {
        return failure('exclusive-contention');
    }
    if (RATE_REJECTED.test(logText)) {
        return failure('unsupported-rate');
    }
    if (FORMAT_REJECTED.test(logText)) {
        return failure('unsupported-format');
    }
    if (DEVICE_LOST.test(logText)) {
        return failure('device-lost');
    }
    return null;
}

export function classifyEndFileError(): AudioEngineFailure {
    return unknownFailure('end-file(reason=error)');
}

/** Fallback for failure evidence that matched no specific cause pattern. */
export function unknownFailure(detail: string): AudioEngineFailure {
    return {
        cause: 'unknown',
        detail,
        explanation: EXPLANATIONS.unknown,
        standardWouldHelp: STANDARD_WOULD_HELP.unknown,
    };
}

const EXPLANATIONS: Record<AudioEngineFailureCause, string> = {
    'device-lost': 'The audio device disappeared during playback.',
    'exclusive-contention': 'Another application is holding exclusive access to the audio device.',
    unknown: 'Playback failed with an unspecified audio engine error.',
    'unsupported-format': 'The device rejected the stream format in exclusive mode.',
    'unsupported-rate': 'The device rejected the stream sample rate in exclusive mode.',
};

const STANDARD_WOULD_HELP: Record<AudioEngineFailureCause, boolean> = {
    'device-lost': false,
    'exclusive-contention': true,
    unknown: false,
    'unsupported-format': true,
    'unsupported-rate': true,
};
