import type { AudioEngineFailure, AudioEngineFailureCause } from './engine-errors';
import type { PlaybackPolicy, PlaybackPolicyPlayerType } from './policy';
import type { AudioSnapshot } from './snapshot';

export type RetainedStrictPlaybackStopState = Pick<AudioSnapshot, 'playbackKey'> &
    StrictPlaybackState;

export type StrictPlaybackState = Partial<Pick<AudioSnapshot, 'lastError' | 'serverRoute'>>;

export interface StrictPlaybackStop {
    cause: 'player-fallback' | 'transcode-detected' | AudioEngineFailureCause;
    detail: null | string;
    standardWouldHelp: boolean;
}

export function resolveFallbackPlaybackType(
    policy: PlaybackPolicy,
    playerType: PlaybackPolicyPlayerType,
    fallbackRequested: boolean,
): PlaybackPolicyPlayerType {
    return shouldUseWebPlayerFallback(policy, playerType, fallbackRequested) ? 'web' : playerType;
}

export function resolveStrictPlaybackStop(
    policy: PlaybackPolicy,
    playerType: PlaybackPolicyPlayerType,
    state: null | StrictPlaybackState,
): null | StrictPlaybackStop {
    if (policy !== 'bit-perfect' || playerType !== 'local' || !state) {
        return null;
    }
    const failure = strictFailure(state);
    if (failure) {
        return failure;
    }
    if (state.serverRoute?.route === 'transcoded') {
        return {
            cause: 'transcode-detected',
            detail: state.serverRoute.detail,
            standardWouldHelp: true,
        };
    }
    return null;
}

export function retainStrictPlaybackStopState(
    current: null | RetainedStrictPlaybackStopState,
    next: RetainedStrictPlaybackStopState,
): null | RetainedStrictPlaybackStopState {
    if (strictFailure(next) || next.serverRoute?.route === 'transcoded') {
        if (
            current?.playbackKey === next.playbackKey &&
            current.lastError === next.lastError &&
            current.serverRoute === next.serverRoute
        ) {
            return current;
        }
        return next;
    }
    return current?.playbackKey === next.playbackKey ? current : null;
}

export function shouldUseWebPlayerFallback(
    policy: PlaybackPolicy,
    playerType: PlaybackPolicyPlayerType,
    fallbackRequested: boolean,
): boolean {
    return fallbackRequested && playerType === 'local' && policy !== 'bit-perfect';
}

/**
 * Strict stops require a typed cause. Unclassified end-file failures are
 * transient buffers/network drops; they must stay retryable instead of
 * latching a dead end (architecture doc: strict stop only on
 * integrity-affecting failures, not transient buffers).
 */
function strictFailure(state: StrictPlaybackState): AudioEngineFailure | null {
    if (!state.lastError || state.lastError.cause === 'unknown') {
        return null;
    }
    return state.lastError;
}
