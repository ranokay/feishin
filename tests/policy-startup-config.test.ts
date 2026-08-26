import { describe, expect, it } from 'vitest';

import { policyStartupConfig, resolvePolicy } from '../src/shared/signalpath';

describe('policyStartupConfig', () => {
    it('returns nothing for standard so the arg set stays byte-identical', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as const) {
            expect(policyStartupConfig('standard', platform)).toEqual({
                runtimeProperties: {},
                startupArgs: [],
            });
        }
    });

    it('pins coreaudio plus exclusive for macOS exclusive sessions', () => {
        expect(policyStartupConfig('exclusive', 'darwin')).toEqual({
            runtimeProperties: { 'audio-exclusive': 'yes' },
            startupArgs: ['--ao=coreaudio', '--audio-exclusive=yes'],
        });
    });

    it('pins wasapi on Windows and leaves Linux unpinned', () => {
        expect(policyStartupConfig('exclusive', 'win32').startupArgs).toEqual([
            '--ao=wasapi',
            '--audio-exclusive=yes',
        ]);
        expect(policyStartupConfig('exclusive', 'linux').startupArgs).toEqual([
            '--audio-exclusive=yes',
        ]);
    });

    it('adds strict pins on top of the AO pinning for bit-perfect', () => {
        const config = policyStartupConfig('bit-perfect', 'darwin');

        expect(config.startupArgs).toContain('--ao=coreaudio');
        expect(config.startupArgs).toContain('--audio-exclusive=yes');
        expect(config.startupArgs).toContain('--gapless-audio=weak');
        expect(config.runtimeProperties).toMatchObject({
            'audio-exclusive': 'yes',
            'gapless-audio': 'weak',
            mute: false,
            replaygain: 'no',
            speed: 1,
            volume: 100,
        });
    });
});

describe('resolvePolicy consistency with policyStartupConfig', () => {
    it('keeps resolvePolicy startup args derived from the shared helper', () => {
        for (const platform of ['darwin', 'linux', 'win32'] as const) {
            for (const policy of ['standard', 'exclusive', 'bit-perfect'] as const) {
                const resolved = resolvePolicy({
                    audioFadeEnabled: false,
                    compressorEnabled: false,
                    equalizerEnabled: false,
                    forcedSampleRateHz: null,
                    platform,
                    policy,
                    replayGainMode: 'no',
                    speed: 1,
                });
                expect(resolved.startupArgs).toEqual(
                    policyStartupConfig(policy, platform).startupArgs,
                );
            }
        }
    });
});
