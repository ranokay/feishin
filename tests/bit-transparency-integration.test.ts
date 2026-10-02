import { describe, expect, it } from 'vitest';

import { createFixtureDirectory, resolveFfmpegBinary } from './fixtures/audio-fixtures';
import { bitTransparencyMatrix, runBitTransparencySelfTest } from './harness/bit-transparency';
import { MpvTestProcess } from './harness/mpv-test-process';

const mpvAvailable = await MpvTestProcess.isAvailable();
const ffmpegBinary = await resolveFfmpegBinary();

describe.skipIf(!mpvAvailable || !ffmpegBinary)('bit-transparency self-test', () => {
    it(
        'renders every matrix cell byte-identically and detects an EQ-injected chain',
        { timeout: 180_000 },
        async () => {
            if (!ffmpegBinary) {
                throw new Error('ffmpeg is required but was not resolved');
            }
            const workDir = await createFixtureDirectory();
            const outcome = await runBitTransparencySelfTest({
                ffmpegBinary,
                mpvBinary: MpvTestProcess.resolveBinaryPath(),
                workDir,
            });

            console.log(`\n${outcome.report}\n`);

            expect(outcome.versions.mpv).toMatch(/^mpv/);
            expect(outcome.versions.ffmpeg).toMatch(/^ffmpeg version/);
            expect(outcome.results).toHaveLength(bitTransparencyMatrix().length);
            expect(outcome.results.filter((result) => !result.matched)).toEqual([]);
            expect(outcome.sensitivity.detected).toBe(true);
            expect(outcome.report).toContain(outcome.versions.mpv);
            expect(outcome.report).toContain(outcome.versions.ffmpeg);
            expect(outcome.report).toContain(outcome.versions.platform);
            expect(outcome.report).toContain('Result: PASS');
        },
    );
});
