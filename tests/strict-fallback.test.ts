import { describe, expect, it } from 'vitest';

import {
    classifyAoFailure,
    resolveFallbackPlaybackType,
    resolveStrictPlaybackStop,
    retainStrictPlaybackStopState,
    shouldUseWebPlayerFallback,
} from '../src/shared/signalpath';

describe('resolveStrictPlaybackStop', () => {
    it('stops Bit-Perfect playback when exclusive access is contended', () => {
        const lastError = classifyAoFailure('[ao/coreaudio] failed to set hogmode: device is busy');

        expect(resolveStrictPlaybackStop('bit-perfect', 'local', { lastError })).toMatchObject({
            cause: 'exclusive-contention',
            standardWouldHelp: true,
        });
    });

    it('stops Bit-Perfect playback when the server transcodes the track', () => {
        expect(
            resolveStrictPlaybackStop('bit-perfect', 'local', {
                serverRoute: {
                    detail: 'response mime audio/mpeg contradicts source audio/flac',
                    level: 'confirmed',
                    route: 'transcoded',
                    verification: 'header-match',
                },
            }),
        ).toMatchObject({
            cause: 'transcode-detected',
            standardWouldHelp: true,
        });
    });

    it('does not stop non-strict or non-local playback', () => {
        const state = {
            serverRoute: {
                detail: 'transcoded',
                level: 'confirmed' as const,
                route: 'transcoded' as const,
                verification: 'header-match' as const,
            },
        };

        expect(resolveStrictPlaybackStop('standard', 'local', state)).toBeNull();
        expect(resolveStrictPlaybackStop('exclusive', 'local', state)).toBeNull();
        expect(resolveStrictPlaybackStop('bit-perfect', 'web', state)).toBeNull();
    });
});

describe('shouldUseWebPlayerFallback', () => {
    it('never engages WebPlayer automatically under Bit-Perfect', () => {
        expect(shouldUseWebPlayerFallback('bit-perfect', 'local', true)).toBe(false);
    });

    it('preserves automatic fallback outside Bit-Perfect', () => {
        expect(shouldUseWebPlayerFallback('standard', 'local', true)).toBe(true);
        expect(shouldUseWebPlayerFallback('exclusive', 'local', true)).toBe(true);
        expect(shouldUseWebPlayerFallback('standard', 'local', false)).toBe(false);
        expect(shouldUseWebPlayerFallback('standard', 'web', true)).toBe(false);
    });
});

describe('resolveFallbackPlaybackType', () => {
    it('reports WebPlayer as the active engine after a non-strict local fallback', () => {
        expect(resolveFallbackPlaybackType('standard', 'local', true)).toBe('web');
        expect(resolveFallbackPlaybackType('exclusive', 'local', true)).toBe('web');
    });

    it('keeps the configured engine when fallback is blocked or inactive', () => {
        expect(resolveFallbackPlaybackType('bit-perfect', 'local', true)).toBe('local');
        expect(resolveFallbackPlaybackType('standard', 'local', false)).toBe('local');
        expect(resolveFallbackPlaybackType('standard', 'jukebox', true)).toBe('jukebox');
    });
});

describe('retainStrictPlaybackStopState', () => {
    it('keeps a failure latched when a later snapshot clears the engine error', () => {
        const lastError = classifyAoFailure('[ao/coreaudio] failed to set hogmode: device is busy');
        const latched = retainStrictPlaybackStopState(null, {
            lastError,
            playbackKey: 'song-1',
        });

        expect(
            retainStrictPlaybackStopState(latched, {
                lastError: null,
                playbackKey: 'song-1',
                serverRoute: null,
            }),
        ).toBe(latched);
    });

    it('releases a latched failure when the track changes', () => {
        const lastError = classifyAoFailure('[ao/coreaudio] failed to set hogmode: device is busy');
        const latched = retainStrictPlaybackStopState(null, {
            lastError,
            playbackKey: 'song-1',
        });

        expect(
            retainStrictPlaybackStopState(latched, {
                lastError: null,
                playbackKey: 'song-2',
                serverRoute: null,
            }),
        ).toBeNull();
    });
});
