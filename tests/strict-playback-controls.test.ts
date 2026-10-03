import { describe, expect, it } from 'vitest';

import {
    BIT_PERFECT_MUTE_BEHAVIORS,
    isBitPerfectPlaybackActive,
    normalizeBitPerfectMuteBehavior,
    resolveBitPerfectStartMute,
    resolveEffectivePlaybackVolume,
    resolvePlaybackControlAction,
} from '../src/shared/signalpath';

describe('isBitPerfectPlaybackActive', () => {
    it('only activates strict controls for the local player', () => {
        expect(isBitPerfectPlaybackActive('bit-perfect', 'local')).toBe(true);
        expect(isBitPerfectPlaybackActive('bit-perfect', 'web')).toBe(false);
        expect(isBitPerfectPlaybackActive('bit-perfect', 'jukebox')).toBe(false);
        expect(isBitPerfectPlaybackActive('exclusive', 'local')).toBe(false);
    });
});

describe('resolveEffectivePlaybackVolume', () => {
    it('reports unity volume only for active local Bit-Perfect playback', () => {
        expect(resolveEffectivePlaybackVolume('bit-perfect', 'local', 30)).toBe(100);
        expect(resolveEffectivePlaybackVolume('bit-perfect', 'web', 30)).toBe(30);
        expect(resolveEffectivePlaybackVolume('standard', 'local', 30)).toBe(30);
    });
});

describe('normalizeBitPerfectMuteBehavior', () => {
    it.each(BIT_PERFECT_MUTE_BEHAVIORS)('passes through %s', (behavior) => {
        expect(normalizeBitPerfectMuteBehavior(behavior)).toBe(behavior);
    });

    it.each([undefined, null, false, 'mute', 'gain'])(
        'defaults invalid value %s to pause',
        (value) => {
            expect(normalizeBitPerfectMuteBehavior(value)).toBe('pause');
        },
    );
});

describe('resolvePlaybackControlAction', () => {
    it('keeps normal controls unchanged outside Bit-Perfect', () => {
        expect(resolvePlaybackControlAction('standard', 'pause', 'volume', 'playing')).toBe(
            'apply',
        );
        expect(resolvePlaybackControlAction('exclusive', 'pause', 'speed', 'playing')).toBe(
            'apply',
        );
        expect(resolvePlaybackControlAction('standard', 'pause', 'mute', 'playing')).toBe(
            'toggle-mute',
        );
    });

    it('blocks volume and speed without changing their stored values', () => {
        expect(resolvePlaybackControlAction('bit-perfect', 'pause', 'volume', 'playing')).toBe(
            'block',
        );
        expect(resolvePlaybackControlAction('bit-perfect', 'pause', 'speed', 'playing')).toBe(
            'block',
        );
    });

    it('maps default strict mute to pause and resume', () => {
        expect(resolvePlaybackControlAction('bit-perfect', 'pause', 'mute', 'playing')).toBe(
            'pause',
        );
        expect(resolvePlaybackControlAction('bit-perfect', 'pause', 'mute', 'paused')).toBe('play');
        expect(resolvePlaybackControlAction('bit-perfect', 'pause', 'mute', 'stopped')).toBe(
            'block',
        );
    });

    it('requests pause and mute clearing for a mute inherited from another mode', () => {
        expect(resolvePlaybackControlAction('bit-perfect', 'pause', 'mute', 'playing', true)).toBe(
            'pause-and-unmute',
        );
    });

    it('allows the explicit gain-mute alternative in strict playback', () => {
        expect(resolvePlaybackControlAction('bit-perfect', 'gain-mute', 'mute', 'playing')).toBe(
            'toggle-mute',
        );
    });
});

describe('resolveBitPerfectStartMute', () => {
    it('keeps an inherited mute outside active local Bit-Perfect', () => {
        expect(resolveBitPerfectStartMute('standard', 'local', 'pause', true)).toEqual({
            clearStoredMute: false,
            mute: true,
        });
        expect(resolveBitPerfectStartMute('exclusive', 'local', 'pause', true)).toEqual({
            clearStoredMute: false,
            mute: true,
        });
        expect(resolveBitPerfectStartMute('bit-perfect', 'web', 'pause', true)).toEqual({
            clearStoredMute: false,
            mute: true,
        });
        expect(resolveBitPerfectStartMute('bit-perfect', 'jukebox', 'pause', true)).toEqual({
            clearStoredMute: false,
            mute: true,
        });
    });

    it('drops an inherited mute when Bit-Perfect pause behavior starts', () => {
        expect(resolveBitPerfectStartMute('bit-perfect', 'local', 'pause', true)).toEqual({
            clearStoredMute: true,
            mute: false,
        });
    });

    it('preserves the inherited mute for explicit gain-mute behavior', () => {
        expect(resolveBitPerfectStartMute('bit-perfect', 'local', 'gain-mute', true)).toEqual({
            clearStoredMute: false,
            mute: true,
        });
    });

    it('leaves an already-unmuted start unchanged', () => {
        expect(resolveBitPerfectStartMute('bit-perfect', 'local', 'pause', false)).toEqual({
            clearStoredMute: false,
            mute: false,
        });
        expect(resolveBitPerfectStartMute('bit-perfect', 'local', 'gain-mute', false)).toEqual({
            clearStoredMute: false,
            mute: false,
        });
    });
});
