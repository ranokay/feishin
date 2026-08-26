import { describe, expect, it } from 'vitest';

import { classifyAoFailure, classifyEndFileError } from '../src/shared/signalpath/engine-errors';

describe('classifyAoFailure', () => {
    it('classifies hog-mode contention from the probe-evidence log line', () => {
        // P15b: second exclusive instance while the first holds the device.
        const failure = classifyAoFailure('[ao/coreaudio] failed to set hogmode: -536870196');

        expect(failure?.cause).toBe('exclusive-contention');
        expect(failure?.standardWouldHelp).toBe(true);
        expect(failure?.explanation).toContain('exclusive');
    });

    it('recognizes other busy-device wordings as contention', () => {
        for (const line of [
            'Could not set hog mode: device is busy',
            'audio device is in use by another application',
        ]) {
            expect(classifyAoFailure(line)?.cause).toBe('exclusive-contention');
        }
    });

    it('classifies rate and format rejections separately', () => {
        const rate = classifyAoFailure(
            'failed to initialize AO: sample rate 176400 not supported by device',
        );
        expect(rate?.cause).toBe('unsupported-rate');
        expect(rate?.standardWouldHelp).toBe(true);

        const format = classifyAoFailure('AO init failed: format s32 not supported');
        expect(format?.cause).toBe('unsupported-format');
    });

    it('classifies a disappearing device', () => {
        const failure = classifyAoFailure('audio device disappeared, uninitializing');
        expect(failure?.cause).toBe('device-lost');
        expect(failure?.standardWouldHelp).toBe(false);
    });

    it('returns null for log lines that are not failures', () => {
        expect(classifyAoFailure('Selected physical format: 44100 Hz float32 2ch')).toBeNull();
        expect(classifyAoFailure('')).toBeNull();
    });

    it('keeps the raw evidence line on every typed failure', () => {
        const failure = classifyAoFailure('failed to set hogmode: boom');
        expect(failure?.detail).toContain('hogmode');
    });
});

describe('classifyEndFileError', () => {
    it('types an error end-file as an unknown playback failure', () => {
        const failure = classifyEndFileError();

        expect(failure.cause).toBe('unknown');
        expect(failure.standardWouldHelp).toBe(false);
        expect(failure.explanation.length).toBeGreaterThan(0);
    });
});
