import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AudioSnapshot } from '../src/shared/signalpath';

import { runProcess } from '../src/main/features/core/analysis/process';
import {
    applyPropertyValue,
    createObservedAudioState,
} from '../src/main/features/core/player/mpv/audio-state';
import { buildSignalPathModel, declareSource } from '../src/shared/signalpath';
import {
    createFixtureDirectory,
    generateHdcdWav,
    generateWav,
    HDCD_PEAK_EXTEND_LEVEL,
    type HdcdFixtureSpec,
    resolveFfmpegBinary,
    writeHdcdWavFixture,
} from './fixtures/audio-fixtures';
import { MpvTestProcess } from './harness/mpv-test-process';

const mpvAvailable = await MpvTestProcess.isAvailable();
const ffmpegBinary = await resolveFfmpegBinary();

const HDCD_FIXTURE: HdcdFixtureSpec = {
    channels: 2,
    durationSec: 1,
    frequencyHz: 1000,
    sampleRate: 44100,
};

// The filter maps only at/above this magnitude through its peak-extend table;
// every sample below it must survive as a plain scale shift.
const PEAK_EXTEND_LEVEL_S32 = HDCD_PEAK_EXTEND_LEVEL << 16;

describe.skipIf(!mpvAvailable || !ffmpegBinary)('source decode through real mpv', () => {
    it(
        'decodes a synthetic HDCD packet with peak extension (ffmpeg evidence)',
        { timeout: 30_000 },
        async () => {
            const dir = await createFixtureDirectory();
            const fixturePath = await writeHdcdWavFixture(dir, HDCD_FIXTURE);
            const filteredPath = path.join(dir, 'hdcd.filtered.s32le');
            const transparentPath = path.join(dir, 'hdcd.transparent.s32le');

            const decode = await runProcess(ffmpegBinary!, [
                '-v',
                'verbose',
                '-y',
                '-i',
                fixturePath,
                '-af',
                'hdcd',
                '-f',
                's32le',
                '-c:a',
                'pcm_s32le',
                filteredPath,
            ]);
            expect(decode.code, decode.stderr).toBe(0);
            expect(decode.stderr).toContain('HDCD detected: yes');
            expect(decode.stderr).toContain('peak_extend: enabled permanently');

            const transparent = await runProcess(ffmpegBinary!, [
                '-v',
                'error',
                '-y',
                '-i',
                fixturePath,
                '-f',
                's32le',
                '-c:a',
                'pcm_s32le',
                transparentPath,
            ]);
            expect(transparent.code).toBe(0);

            const filteredPcm = await readFile(filteredPath);
            const transparentPcm = await readFile(transparentPath);
            const comparison = compareExpansion(filteredPcm, transparentPcm);

            // Below the peak-extend level only the 16 -> 32-bit scale differs.
            expect(comparison.belowMismatches).toBe(0);
            expect(comparison.belowSamples).toBeGreaterThan(0);
            // Above it, the sample values themselves are reconstructed.
            expect(comparison.aboveSamples).toBeGreaterThan(0);
            expect(comparison.aboveChanged / comparison.aboveSamples).toBeGreaterThan(0.9);
            expect(comparison.peakRatio).toBeGreaterThan(1);
        },
    );

    it(
        'renders the hdcd chain byte-identically to the ffmpeg reference and reports it',
        { timeout: 30_000 },
        async () => {
            const dir = await createFixtureDirectory();
            const fixturePath = await writeHdcdWavFixture(dir, HDCD_FIXTURE);
            const renderedPath = path.join(dir, 'mpv.hdcd.s32le');
            const referencePath = path.join(dir, 'ffmpeg.hdcd.s32le');

            const reference = await runProcess(ffmpegBinary!, [
                '-v',
                'error',
                '-y',
                '-i',
                fixturePath,
                '-af',
                'hdcd',
                '-f',
                's32le',
                '-c:a',
                'pcm_s32le',
                referencePath,
            ]);
            expect(reference.code).toBe(0);

            const appliedFilters = await renderWithFilters({
                af: 'lavfi=[hdcd]',
                fixturePath,
                renderedPath,
            });

            expect(await readFile(renderedPath)).toEqual(await readFile(referencePath));

            // The parser the app relies on must see the real mpv read-back, and
            // the model must classify it as declared decode, never bit-perfect.
            const observed = createObservedAudioState();
            applyPropertyValue(observed, 'af', appliedFilters);
            expect(observed.activeFilters).toEqual(['lavfi:hdcd']);

            const model = buildSignalPathModel({
                policy: 'bit-perfect',
                replayGainMode: 'no',
                snapshot: snapshotFor(observed.activeFilters ?? []),
                source: declareSource({
                    bitDepth: 16,
                    channels: 2,
                    container: 'wav',
                    sampleRate: 44100,
                }),
                sourceDecode: { deEmphasis: false, hdcd: true },
            });
            const declared = model.processing.find((entry) => entry.kind === 'declared-decode');
            expect(declared?.level).toBe('confirmed');
            expect(declared?.detail).toContain('hdcd');
            expect(model.integrity.status).toBe('exclusive-processed');
        },
    );

    it(
        'renders the cd de-emphasis chain byte-identically to the ffmpeg reference',
        { timeout: 30_000 },
        async () => {
            const dir = await createFixtureDirectory();
            const fixturePath = await writeHdcdWavFixture(dir, {
                ...HDCD_FIXTURE,
                amplitude: 0.5,
            });
            const renderedPath = path.join(dir, 'mpv.deemphasis.s32le');
            const referencePath = path.join(dir, 'ffmpeg.deemphasis.s32le');
            const transparentPath = path.join(dir, 'ffmpeg.transparent.s32le');

            const reference = await runProcess(ffmpegBinary!, [
                '-v',
                'error',
                '-y',
                '-i',
                fixturePath,
                '-af',
                'aemphasis=type=cd',
                '-f',
                's32le',
                '-c:a',
                'pcm_s32le',
                referencePath,
            ]);
            expect(reference.code).toBe(0);
            const transparent = await runProcess(ffmpegBinary!, [
                '-v',
                'error',
                '-y',
                '-i',
                fixturePath,
                '-f',
                's32le',
                '-c:a',
                'pcm_s32le',
                transparentPath,
            ]);
            expect(transparent.code).toBe(0);

            const appliedFilters = await renderWithFilters({
                af: 'lavfi=[aemphasis=type=cd]',
                fixturePath,
                renderedPath,
            });

            const rendered = await readFile(renderedPath);
            expect(rendered).toEqual(await readFile(referencePath));
            expect(rendered).not.toEqual(await readFile(transparentPath));

            const observed = createObservedAudioState();
            applyPropertyValue(observed, 'af', appliedFilters);
            expect(observed.activeFilters).toEqual(['lavfi:aemphasis=type=cd']);
        },
    );
});

describe('generateHdcdWav', () => {
    it('carries the HDCD packet in the sample LSBs without changing the level', () => {
        const spec: HdcdFixtureSpec = {
            amplitude: 0.92,
            channels: 1,
            durationSec: 0.25,
            sampleRate: 44100,
        };
        const withPacket = generateHdcdWav(spec);
        const plain = generateWav({
            amplitude: 0.92,
            bitDepth: 16,
            channels: 1,
            durationSec: 0.25,
            frequencyHz: 1000,
            kind: 'sine',
            sampleRate: 44100,
        });

        expect(withPacket.length).toBe(plain.length);
        let changed = 0;
        for (let offset = 44; offset < withPacket.length; offset += 2) {
            const a = withPacket.readInt16LE(offset);
            const b = plain.readInt16LE(offset);
            const delta = Math.abs(a - b);
            expect(delta).toBeLessThanOrEqual(1);
            if (delta === 1) {
                changed++;
            }
        }
        // The 40-bit packet must actually be present in the LSB stream.
        expect(changed).toBeGreaterThan(0);
    });
});

interface ExpansionComparison {
    aboveChanged: number;
    aboveSamples: number;
    belowMismatches: number;
    belowSamples: number;
    peakRatio: number;
}

/**
 * The hdcd filter outputs 20-bit samples in an s32 container, so below the
 * peak-extend level its output is exactly half the transparent 32-bit decode.
 * Above it, peaktab reconstruction changes the sample value itself.
 */
function compareExpansion(filtered: Buffer, transparent: Buffer): ExpansionComparison {
    const sampleCount = Math.min(filtered.length, transparent.length) / 4;
    const comparison: ExpansionComparison = {
        aboveChanged: 0,
        aboveSamples: 0,
        belowMismatches: 0,
        belowSamples: 0,
        peakRatio: 0,
    };
    let filteredPeak = 0;
    let transparentPeak = 0;
    for (let index = 0; index < sampleCount; index++) {
        const original = transparent.readInt32LE(index * 4);
        const expanded = filtered.readInt32LE(index * 4);
        filteredPeak = Math.max(filteredPeak, Math.abs(expanded * 2));
        transparentPeak = Math.max(transparentPeak, Math.abs(original));
        if (Math.abs(original) < PEAK_EXTEND_LEVEL_S32) {
            comparison.belowSamples++;
            if (expanded * 2 !== original) {
                comparison.belowMismatches++;
            }
        } else {
            comparison.aboveSamples++;
            if (expanded * 2 !== original) {
                comparison.aboveChanged++;
            }
        }
    }
    comparison.peakRatio = transparentPeak > 0 ? filteredPeak / transparentPeak : 0;
    return comparison;
}

async function renderWithFilters(options: {
    af: string;
    fixturePath: string;
    renderedPath: string;
}): Promise<unknown> {
    const mpv = new MpvTestProcess({
        args: [
            '--ao=pcm',
            '--ao-pcm-waveheader=no',
            `--ao-pcm-file=${options.renderedPath}`,
            '--audio-format=s32',
        ],
    });
    try {
        await mpv.start();
        await mpv.setProperty('af', options.af);
        const appliedFilters = await mpv.getProperty('af');
        await mpv.request(['loadfile', options.fixturePath]);
        const endFile = await mpv.waitFor({ name: 'end-file', timeoutMs: 15_000 });
        expect(endFile['reason']).toBe('eof');
        return appliedFilters;
    } finally {
        await mpv.dispose();
    }
}

function snapshotFor(activeFilters: string[]): AudioSnapshot {
    return {
        activeFilters,
        aoDriver: 'coreaudio_exclusive',
        audioDevice: 'coreaudio/DAC',
        cacheEofReaching: null,
        cacheIdle: null,
        cacheUnderrun: null,
        decodedParams: { channels: 2, format: 's16', samplerate: 44100 },
        gaplessAudio: 'weak',
        lastEventId: 0,
        muted: false,
        outputParams: { channels: 2, format: 's32', samplerate: 44100 },
        physicalFormat: null,
        playbackKey: 'hdcd-fixture',
        playlistPos: 0,
        sequence: 1,
        speed: 1,
        strictPropertyViolations: [],
        strictValidationError: null,
        timestamp: 0,
        volume: 100,
    };
}
