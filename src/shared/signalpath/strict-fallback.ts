import type { AudioEngineFailureCause } from './engine-errors';
import type { PlaybackPolicy, PlaybackPolicyPlayerType } from './policy';
import type { AudioSnapshot } from './snapshot';

export interface StrictPlaybackStop {
    cause: 'transcode-detected' | AudioEngineFailureCause;
    detail: null | string;
    explanation: string;
    standardWouldHelp: boolean;
}

type StrictPlaybackState = Partial<Pick<AudioSnapshot, 'lastError' | 'serverRoute'>>;

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
            explanation: 'The server delivered a transcoded stream instead of the original audio.',
            standardWouldHelp: true,
        };
    }
    return null;
}

export function shouldUseWebPlayerFallback(
    policy: PlaybackPolicy,
    playerType: PlaybackPolicyPlayerType,
    fallbackRequested: boolean,
): boolean {
    return fallbackRequested && playerType === 'local' && policy !== 'bit-perfect';
}
