import { describe, expect, it } from 'vitest';

import type { AudioSnapshot } from '../src/shared/signalpath';
import type { SourceDeclaration } from '../src/shared/signalpath/formats';

import {
    BIT_PERFECT_PROPERTY_PINS,
    buildSignalPathModel,
    filterPolicyExtraParameters,
    findStrictPropertyViolation,
    policyStartupConfig,
} from '../src/shared/signalpath';

const source: SourceDeclaration = {
    bitDepth: 16,
    channelCount: 2,
    codec: 'flac',
    lossless: true,
    pcmOrDsd: 'pcm',
    samplingRate: 44100,
};

function snapshot(overrides: Partial<AudioSnapshot> = {}): AudioSnapshot {
    return {
        activeFilters: [],
        aoDriver: 'coreaudio_exclusive',
        audioDevice: 'coreaudio/DAC',
        cacheEofReaching: null,
        cacheIdle: null,
        cacheUnderrun: null,
        decodedParams: { channels: 2, format: 's16', samplerate: 44100 },
        gaplessAudio: 'weak',
        muted: false,
        outputParams: { channels: 2, format: 's32', samplerate: 44100 },
        physicalFormat: null,
        playbackKey: 'song-1',
        playlistPos: 0,
        sequence: 1,
        speed: 1,
        strictPropertyViolations: [],
        strictValidationError: null,
        timestamp: 0,
        volume: 100,
        ...overrides,
    };
}

describe('Bit-Perfect runtime property pins', () => {
    it('defines the exact strict property set', () => {
        expect(BIT_PERFECT_PROPERTY_PINS).toEqual([
            { name: 'af', value: [] },
            { name: 'audio-samplerate', value: 0 },
            { name: 'gapless-audio', value: 'weak' },
            { name: 'replaygain', value: 'no' },
            { name: 'speed', value: 1 },
            { name: 'volume', value: 100 },
        ]);

        expect(policyStartupConfig('bit-perfect', 'darwin').runtimeProperties).toEqual({
            af: [],
            'audio-exclusive': 'yes',
            'audio-samplerate': 0,
            'gapless-audio': 'weak',
            replaygain: 'no',
            speed: 1,
            volume: 100,
        });
    });

    it('rejects user volume gain arguments only under Bit-Perfect', () => {
        const parameters = [
            '--cache=yes',
            '--volume-gain',
            '--volume-gain=6',
            '  --volume-gain=-3  ',
            '--volume-gain-max=12',
        ];

        expect(filterPolicyExtraParameters('bit-perfect', parameters)).toEqual([
            '--cache=yes',
            '--volume-gain-max=12',
        ]);
        expect(filterPolicyExtraParameters('standard', parameters)).toEqual(parameters);
        expect(filterPolicyExtraParameters('exclusive', parameters)).toEqual(parameters);
    });

    it('normalizes mpv filter observations before comparing them', () => {
        const filterPin = BIT_PERFECT_PROPERTY_PINS[0];

        expect(findStrictPropertyViolation(filterPin, [])).toBeNull();
        expect(findStrictPropertyViolation(filterPin, null)).toEqual({
            actual: 'unset',
            expected: 'none',
            property: 'af',
        });
        expect(findStrictPropertyViolation(filterPin, [{ label: 'unknown' }])).toEqual({
            actual: '[{"label":"unknown"}]',
            expected: 'none',
            property: 'af',
        });
        expect(findStrictPropertyViolation(filterPin, [{ name: 'lavfi' }])).toEqual({
            actual: 'lavfi',
            expected: 'none',
            property: 'af',
        });
        expect(
            findStrictPropertyViolation(
                BIT_PERFECT_PROPERTY_PINS.find((pin) => pin.name === 'replaygain')!,
                false,
            ),
        ).toBeNull();
    });

    it('leaves Standard and Exclusive runtime properties unchanged', () => {
        expect(policyStartupConfig('standard', 'darwin').runtimeProperties).toEqual({});
        expect(policyStartupConfig('exclusive', 'darwin').runtimeProperties).toEqual({
            'audio-exclusive': 'yes',
        });
    });

    it('removes strict playback from an eligible verdict as soon as drift is observed', () => {
        const model = buildSignalPathModel({
            policy: 'bit-perfect',
            replayGainMode: 'no',
            snapshot: snapshot({
                strictPropertyViolations: [
                    {
                        actual: 'yes',
                        expected: 'weak',
                        property: 'gapless-audio',
                    },
                ],
            }),
            source,
        });

        expect(model.integrity.status).toBe('exclusive-processed');
        expect(model.integrity.detail).toContain(
            'strict property gapless-audio: expected weak, got yes',
        );
    });

    it('preserves stronger source and server diagnoses when strict drift overlaps them', () => {
        const strictPropertyViolations: AudioSnapshot['strictPropertyViolations'] = [
            { actual: '1.25', expected: '1', property: 'speed' },
        ];
        const transcoded = buildSignalPathModel({
            policy: 'bit-perfect',
            replayGainMode: 'no',
            snapshot: snapshot({
                serverRoute: {
                    detail: 'codec mismatch',
                    level: 'confirmed',
                    route: 'transcoded',
                    verification: 'unverified',
                },
                strictPropertyViolations,
            }),
            source,
        });
        const lossy = buildSignalPathModel({
            policy: 'bit-perfect',
            replayGainMode: 'no',
            snapshot: snapshot({ strictPropertyViolations }),
            source: { ...source, lossless: false },
        });

        expect(transcoded.integrity.status).toBe('transcoded');
        expect(lossy.integrity.status).toBe('lossy-source');
    });
});
