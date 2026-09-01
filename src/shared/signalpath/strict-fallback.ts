import type { AudioEngineFailureCause } from './engine-errors';
import type { PlaybackPolicy, PlaybackPolicyPlayerType } from './policy';
import type { AudioSnapshot } from './snapshot';

export interface RetainedStrictPlaybackStopState {
    playbackKey: null | string;
    state: StrictPlaybackState;
}

export type StrictPlaybackState = Partial<Pick<AudioSnapshot, 'lastError' | 'serverRoute'>>;

export interface StrictPlaybackStop {
    cause: 'player-fallback' | 'transcode-detected' | AudioEngineFailureCause;
    detail: null | string;
    standardWouldHelp: boolean;
}

export function resolveStrictPlaybackStop(
    policy: PlaybackPolicy,
    playerType: PlaybackPolicyPlayerType,
    state: null | StrictPlaybackState,
): null | StrictPlaybackStop {
    if (policy !== 'bit-perfect' || playerType !== 'local' || !state) {
        return null;
    }
    if (state.lastError) {
        return state.lastError;
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
    playbackKey: null | string,
    next: StrictPlaybackState,
): null | RetainedStrictPlaybackStopState {
    if (next.lastError || next.serverRoute?.route === 'transcoded') {
        if (
            current?.playbackKey === playbackKey &&
            current.state.lastError === next.lastError &&
            current.state.serverRoute === next.serverRoute
        ) {
            return current;
        }
        return { playbackKey, state: next };
    }
    return current?.playbackKey === playbackKey ? current : null;
}

export function shouldUseWebPlayerFallback(
    policy: PlaybackPolicy,
    playerType: PlaybackPolicyPlayerType,
    fallbackRequested: boolean,
): boolean {
    return fallbackRequested && playerType === 'local' && policy !== 'bit-perfect';
}
