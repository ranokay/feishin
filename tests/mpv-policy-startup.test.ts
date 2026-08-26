import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { policyStartupConfig } from '../src/shared/signalpath';
import { writeWavFixture } from './fixtures/audio-fixtures';
import { MpvTestProcess } from './harness/mpv-test-process';

const mpvAvailable = await MpvTestProcess.isAvailable();
// Exclusive redirect evidence is only meaningful where the AO pin applies.
const isDarwin = process.platform === 'darwin';

let mpv: MpvTestProcess | null = null;
let fixturesDir: string;

beforeAll(async () => {
    if (!mpvAvailable || !isDarwin) {
        return;
    }
    fixturesDir = await (await import('./fixtures/audio-fixtures')).createFixtureDirectory();
});

afterAll(async () => {
    if (mpv) {
        await mpv.dispose();
    }
});

describe.skipIf(!mpvAvailable || !isDarwin)(
    'policy-driven exclusive session over real mpv (macOS)',
    () => {
        it('redirects to coreaudio_exclusive under bit-perfect startup args', async () => {
            const { startupArgs } = policyStartupConfig('bit-perfect', 'darwin');
            mpv = new MpvTestProcess({ args: [...startupArgs, '--msg-level=all=info'] });
            await mpv.start();

            await mpv.request([
                'loadfile',
                await writeWavFixture(fixturesDir, {
                    bitDepth: 16,
                    channels: 2,
                    durationSec: 2,
                    frequencyHz: 1000,
                    kind: 'sine',
                    sampleRate: 44100,
                }),
            ]);

            // P7: coreaudio + audio-exclusive=yes redirects to coreaudio_exclusive.
            // current-ao is unavailable while idle; poll once playback starts.
            const deadline = Date.now() + 10_000;
            let currentAo: unknown = null;
            while (Date.now() < deadline) {
                try {
                    currentAo = await mpv.getProperty('current-ao');
                } catch {
                    currentAo = null;
                }
                if (typeof currentAo === 'string' && currentAo.length > 0) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }

            expect(String(currentAo)).toMatch(/^coreaudio/);
            expect(String(currentAo)).toBe('coreaudio_exclusive');
        }, 20_000);
    },
);
