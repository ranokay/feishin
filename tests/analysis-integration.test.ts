import { execFile } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
    buildFfmpegAnalysisArgs,
    buildFfprobeAnalysisArgs,
    deriveAnalysisResult,
    parseAstatsOverall,
    parseEbur128Summary,
    parseFfprobeJson,
    parseRolloffValues,
    summarizeRolloff,
} from '../src/shared/analysis';
import { createFixtureDirectory } from './fixtures/audio-fixtures';

interface ExecResult {
    code: null | number;
    stderr: string;
    stdout: string;
}

function isAvailable(binary: string): Promise<boolean> {
    return run(binary, ['-version']).then((result) => result.code === 0);
}

function run(binary: string, args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
        execFile(binary, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
                code: error ? ((error as { code?: number }).code ?? 1) : 0,
                stderr,
                stdout,
            });
        });
    });
}

const ffmpegAvailable = await isAvailable('ffmpeg');
const ffprobeAvailable = await isAvailable('ffprobe');

describe.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    'analysis runner commands against real ffmpeg',
    () => {
        let plain16: string;
        let upsampled96: string;

        beforeAll(async () => {
            const dir = await createFixtureDirectory();
            plain16 = path.join(dir, 'noise-16.flac');
            upsampled96 = path.join(dir, 'noise-16-upsampled-96.flac');

            const created = await run('ffmpeg', [
                '-v',
                'error',
                '-y',
                '-f',
                'lavfi',
                '-i',
                'anoisesrc=color=white:duration=2:sample_rate=44100:amplitude=0.5',
                '-sample_fmt',
                's16',
                plain16,
            ]);
            expect(created.code, created.stderr).toBe(0);

            const upsampled = await run('ffmpeg', [
                '-v',
                'error',
                '-y',
                '-i',
                plain16,
                '-ar',
                '96000',
                '-sample_fmt',
                's32',
                upsampled96,
            ]);
            expect(upsampled.code, upsampled.stderr).toBe(0);
        }, 60_000);

        const analyze = async (filePath: string) => {
            const probe = await run('ffprobe', buildFfprobeAnalysisArgs(filePath));
            expect(probe.code, probe.stderr).toBe(0);
            const source = parseFfprobeJson(probe.stdout);
            expect(source).not.toBeNull();

            const stats = await run('ffmpeg', buildFfmpegAnalysisArgs(filePath));
            expect(stats.code, stats.stderr).toBe(0);

            return deriveAnalysisResult({
                analyzedAt: '2026-10-02T00:00:00.000Z',
                astats: parseAstatsOverall(stats.stderr),
                ebur128: parseEbur128Summary(stats.stderr),
                rolloffHz: summarizeRolloff(parseRolloffValues(stats.stdout)),
                source: source!,
            });
        };

        it('measures a 16-bit 44.1 kHz source with full-band HF content', async () => {
            const result = await analyze(plain16);

            expect(result.source).toMatchObject({
                bitDepth: 16,
                codec: 'flac',
                sampleRate: 44100,
            });
            expect(result.measurements.samplePeakDbfs).toBeCloseTo(-6, 0);
            expect(result.measurements.loudnessLufs).toBeLessThan(0);
            // Broadband noise keeps HF content, unlike the sine fixtures.
            expect(result.measurements.hfExtentHz).toBeGreaterThan(15000);
            expect(result.findings).toEqual([]);
        }, 60_000);

        it('describes 44.1 kHz content in a 96 kHz container as band-limited', async () => {
            const result = await analyze(upsampled96);

            expect(result.source.sampleRate).toBe(96000);
            const bandwidth = result.findings.find(
                (finding) => finding.kind === 'bandwidth-extent',
            );
            expect(bandwidth).toBeDefined();
            expect(result.measurements.hfExtentHz).toBeLessThan(24000);
        }, 60_000);
    },
);
