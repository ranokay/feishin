import { describe, expect, it } from 'vitest';

import {
    bitTransparencyCellLabel,
    bitTransparencyMatrix,
    comparePcm,
    formatBitTransparencyReport,
} from './harness/bit-transparency';

describe('comparePcm', () => {
    it('matches identical buffers', () => {
        expect(comparePcm(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toEqual({
            matched: true,
        });
    });

    it('reports the first differing byte with both values', () => {
        expect(comparePcm(Buffer.from([1, 2, 3]), Buffer.from([1, 9, 3]))).toEqual({
            detail: 'first differing byte 1: reference 0x02, rendered 0x09',
            matched: false,
        });
    });

    it('reports a length mismatch with both lengths', () => {
        expect(comparePcm(Buffer.from([1, 2, 3]), Buffer.from([1, 2]))).toEqual({
            detail: 'length mismatch: reference 3 bytes, rendered 2 bytes',
            matched: false,
        });
    });

    it('reports both the differing byte and the length mismatch', () => {
        expect(comparePcm(Buffer.from([1, 3, 3]), Buffer.from([1, 2]))).toEqual({
            detail: 'first differing byte 1: reference 0x03, rendered 0x02; length mismatch: reference 3 bytes, rendered 2 bytes',
            matched: false,
        });
    });
});

describe('bitTransparencyMatrix', () => {
    it('covers wav at every depth from 16/44.1 through 24/192 including 32-bit', () => {
        const wavCells = bitTransparencyMatrix().filter((cell) => cell.container === 'wav');

        expect(wavCells).toHaveLength(12);
        expect(wavCells.map((cell) => `${cell.spec.bitDepth}/${cell.spec.sampleRate}`)).toEqual([
            '16/44100',
            '24/44100',
            '32/44100',
            '16/48000',
            '24/48000',
            '32/48000',
            '16/96000',
            '24/96000',
            '32/96000',
            '16/192000',
            '24/192000',
            '32/192000',
        ]);
        expect(wavCells.every((cell) => cell.spec.channels === 2)).toBe(true);
    });

    it('adds flac cells only where the container supports the depth', () => {
        const flacCells = bitTransparencyMatrix().filter((cell) => cell.container === 'flac');

        expect(flacCells).toHaveLength(8);
        expect(
            flacCells.every((cell) => cell.spec.bitDepth === 16 || cell.spec.bitDepth === 24),
        ).toBe(true);
    });

    it('labels every cell uniquely and readably', () => {
        const labels = bitTransparencyMatrix().map(bitTransparencyCellLabel);

        expect(new Set(labels).size).toBe(labels.length);
        expect(labels).toContain('wav 16-bit 44100 Hz stereo');
        expect(labels).toContain('wav 32-bit 192000 Hz stereo');
        expect(labels).toContain('flac 24-bit 96000 Hz stereo');
    });
});

describe('formatBitTransparencyReport', () => {
    const versions = {
        ffmpeg: 'ffmpeg version 9.0.2',
        mpv: 'mpv v0.41.0',
        platform: 'darwin arm64 25.2.0',
    };

    it('lists the tool versions, every cell outcome, and the sensitivity check', () => {
        const report = formatBitTransparencyReport({
            results: [
                { label: 'wav 16-bit 44100 Hz stereo', matched: true },
                {
                    detail: 'first differing byte 4: reference 0x00, rendered 0x01',
                    label: 'wav 24-bit 96000 Hz stereo',
                    matched: false,
                },
            ],
            sensitivity: {
                detail: 'first differing byte 0: reference 0x00, rendered 0x7f',
                detected: true,
            },
            versions,
        });

        expect(report).toContain('mpv:      mpv v0.41.0');
        expect(report).toContain('ffmpeg:   ffmpeg version 9.0.2');
        expect(report).toContain('platform: darwin arm64 25.2.0');
        expect(report).toContain('PASS wav 16-bit 44100 Hz stereo');
        expect(report).toContain(
            'FAIL wav 24-bit 96000 Hz stereo: first differing byte 4: reference 0x00, rendered 0x01',
        );
        expect(report).toContain('Sensitivity (EQ injected): detected as expected');
        expect(report).toContain('first differing byte 0: reference 0x00, rendered 0x7f');
        expect(report).toContain('Cells: 1 passed, 1 failed');
        expect(report).toContain('Result: FAIL');
    });

    it('summarizes a fully transparent run as a pass', () => {
        const report = formatBitTransparencyReport({
            results: [{ label: 'wav 16-bit 44100 Hz stereo', matched: true }],
            sensitivity: { detected: true },
            versions,
        });

        expect(report).toContain('Cells: 1 passed, 0 failed');
        expect(report).toContain('Result: PASS');
    });

    it('fails the run when the sensitivity check does not fire', () => {
        const report = formatBitTransparencyReport({
            results: [],
            sensitivity: { detected: false },
            versions,
        });

        expect(report).toContain('Sensitivity (EQ injected): not detected');
        expect(report).toContain('Result: FAIL');
    });
});
