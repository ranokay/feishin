import { describe, expect, it } from 'vitest';

import type {
    CompressorSettings,
    EqSettings,
} from '../src/renderer/features/settings/components/playback/mpv-audio-filters';

import { buildMpvAudioFilters } from '../src/renderer/features/settings/components/playback/mpv-audio-filters';

const eqOff: EqSettings = {
    bands: [{ freq: 1000, gain: 0 }],
    enabled: false,
    preamp: 0,
};

const compOff: CompressorSettings = {
    attack: 20,
    enabled: false,
    knee: 2.83,
    makeup: 6,
    ratio: 4,
    release: 250,
    threshold: -24,
};

const eqOn: EqSettings = {
    bands: [{ freq: 1000, gain: 6 }],
    enabled: true,
    preamp: 0,
};

describe('buildMpvAudioFilters source decode', () => {
    it('keeps the chain empty when nothing is enabled', () => {
        expect(buildMpvAudioFilters(eqOff, compOff)).toBe('');
        expect(
            buildMpvAudioFilters(eqOff, compOff, {
                sourceDecode: { deEmphasis: false, hdcd: false },
            }),
        ).toBe('');
    });

    it('prepends the opted source-faithful decode filters', () => {
        expect(
            buildMpvAudioFilters(eqOff, compOff, {
                sourceDecode: { deEmphasis: false, hdcd: true },
            }),
        ).toBe('lavfi=[hdcd]');
        expect(
            buildMpvAudioFilters(eqOff, compOff, {
                sourceDecode: { deEmphasis: true, hdcd: true },
            }),
        ).toBe('lavfi=[hdcd],lavfi=[aemphasis=type=cd]');
    });

    it('runs source decode before user DSP', () => {
        const chain = buildMpvAudioFilters(eqOn, compOff, {
            sourceDecode: { deEmphasis: false, hdcd: true },
        });
        expect(chain.indexOf('hdcd')).toBeLessThan(chain.indexOf('equalizer'));
    });

    it('suppresses user DSP under strict playback but keeps the opted decode', () => {
        expect(
            buildMpvAudioFilters(eqOn, compOff, {
                includeUserDsp: false,
                sourceDecode: { deEmphasis: false, hdcd: true },
            }),
        ).toBe('lavfi=[hdcd]');
        expect(buildMpvAudioFilters(eqOn, compOff, { includeUserDsp: false })).toBe('');
    });

    it('keeps existing EQ and compressor composition unchanged', () => {
        const chain = buildMpvAudioFilters(eqOn, compOff);
        expect(chain).toBe('lavfi=[equalizer=f=1000:width_type=o:w=1:g=6]');
    });
});
