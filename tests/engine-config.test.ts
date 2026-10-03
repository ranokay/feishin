import { describe, expect, it } from 'vitest';

import { buildMpvEngineConfig } from '../src/shared/signalpath/engine-config';

const userProperties = {
    af: ['lavfi=[equalizer=f=500:t=q:w=1:g=3]'],
    'audio-exclusive': 'no',
    'audio-samplerate': 48000,
    'gapless-audio': 'yes',
    replaygain: 'track',
    'replaygain-preamp': 3,
};

function inputs(overrides: Record<string, unknown> = {}) {
    return {
        deviceId: 'coreaudio/TestDAC',
        extraParameters: [] as string[],
        mpvProperties: { ...userProperties },
        mute: false,
        platform: 'darwin' as const,
        playbackPolicy: 'standard' as const,
        preservePitch: true,
        speed: 1,
        volume: 30,
        ...overrides,
    };
}

describe('buildMpvEngineConfig', () => {
    it('keeps standard playback unchanged: user properties, controls, device arg only', () => {
        const config = buildMpvEngineConfig(inputs());

        expect(config.properties).toEqual({
            ...userProperties,
            'audio-pitch-correction': 'yes',
            mute: false,
            speed: 1,
            volume: 30,
        });
        expect(config.extraParameters).toEqual(['--audio-device=coreaudio/TestDAC']);
    });

    it('writes pitch correction off when preservePitch is false', () => {
        const config = buildMpvEngineConfig(inputs({ preservePitch: false }));

        expect(config.properties['audio-pitch-correction']).toBe('no');
    });

    it('resolves a blank or missing device id to the mpv auto device', () => {
        expect(buildMpvEngineConfig(inputs({ deviceId: '   ' })).extraParameters).toEqual([
            '--audio-device=auto',
        ]);
        expect(buildMpvEngineConfig(inputs({ deviceId: undefined })).extraParameters).toEqual([
            '--audio-device=auto',
        ]);
    });

    it('lets bit-perfect runtime pins override conflicting user properties', () => {
        const config = buildMpvEngineConfig(
            inputs({ playbackPolicy: 'bit-perfect', speed: 1.5, volume: 25 }),
        );

        expect(config.properties).toMatchObject({
            af: [],
            'audio-exclusive': 'yes',
            'audio-samplerate': 0,
            'gapless-audio': 'weak',
            replaygain: 'no',
            speed: 1,
            volume: 100,
        });
    });

    it('orders filtered user args, policy args, then the device arg', () => {
        const config = buildMpvEngineConfig(
            inputs({
                extraParameters: ['--gapless-audio=yes', '--volume-gain=2', '--keep=1'],
                playbackPolicy: 'bit-perfect',
            }),
        );

        expect(config.extraParameters).toEqual([
            '--keep=1',
            '--ao=coreaudio',
            '--audio-exclusive=yes',
            '--gapless-audio=weak',
            '--audio-device=coreaudio/TestDAC',
        ]);
    });

    it('keeps user args including volume-gain outside bit-perfect', () => {
        const config = buildMpvEngineConfig(
            inputs({ extraParameters: ['--gapless-audio=yes', '--volume-gain=2'] }),
        );

        expect(config.extraParameters).toEqual([
            '--gapless-audio=yes',
            '--volume-gain=2',
            '--audio-device=coreaudio/TestDAC',
        ]);
    });

    it('drops bare blocked flags under bit-perfect, not only name=value forms', () => {
        const config = buildMpvEngineConfig(
            inputs({
                extraParameters: ['--gapless-audio', '--volume-gain', '--keep'],
                playbackPolicy: 'bit-perfect',
            }),
        );

        expect(config.extraParameters).toEqual([
            '--keep',
            '--ao=coreaudio',
            '--audio-exclusive=yes',
            '--gapless-audio=weak',
            '--audio-device=coreaudio/TestDAC',
        ]);
    });

    it('never authors an audio-format property for any policy', () => {
        for (const playbackPolicy of ['standard', 'bit-perfect'] as const) {
            const config = buildMpvEngineConfig(inputs({ playbackPolicy }));

            expect(config.properties).not.toHaveProperty('audio-format');
        }
    });

    it('pins the platform AO for bit-perfect on Windows', () => {
        const config = buildMpvEngineConfig(
            inputs({ platform: 'win32', playbackPolicy: 'bit-perfect' }),
        );

        expect(config.extraParameters).toEqual([
            '--ao=wasapi',
            '--audio-exclusive=yes',
            '--gapless-audio=weak',
            '--audio-device=coreaudio/TestDAC',
        ]);
    });

    it('leaves the Linux audio output unpinned under bit-perfect', () => {
        const config = buildMpvEngineConfig(
            inputs({ platform: 'linux', playbackPolicy: 'bit-perfect' }),
        );

        expect(config.extraParameters).toEqual([
            '--audio-exclusive=yes',
            '--gapless-audio=weak',
            '--audio-device=coreaudio/TestDAC',
        ]);
    });

    it('passes an inherited mute through at init', () => {
        const config = buildMpvEngineConfig(inputs({ mute: true, playbackPolicy: 'bit-perfect' }));

        expect(config.properties.mute).toBe(true);
    });
});
